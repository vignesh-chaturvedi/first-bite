import { createHash } from 'node:crypto';
import { Message, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistryClient, RegistryClientError } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY } from '../src/lib/chain/policy';
import { PROGRAM_ID, configPda, domainPda, primaryPda } from '../src/lib/cookie/registry';
import { chainFixture, chainSnapshot, primaryAccount, systemAccount } from './helpers/chain-fixture';

afterEach(() => vi.useRealTimers());

describe('reviewed Cookie policy', () => {
  it('pins the committed executable, config and rent evidence', () => {
    const policy = COOKIE_REGISTRY_POLICY;
    expect(policy.genesisHash).toBe(chainSnapshot.genesisHash);
    expect(policy.programAddress).toBe(chainSnapshot.program.address);
    expect(policy.loaderAddress).toBe(chainSnapshot.program.owner);
    expect(policy.configAddress).toBe(chainSnapshot.config.address);
    expect(policy.configSha256).toBe(createHash('sha256').update(Buffer.from(chainSnapshot.config.dataBase64, 'base64')).digest('hex'));
    expect(policy.feeReceiverAddress).toBe(chainSnapshot.feeReceiver.address);
    expect(policy.programDataAddress).toBe(chainSnapshot.programData.address);
    expect(policy.deploymentSlot).toBe(BigInt(chainSnapshot.programData.deploymentSlot));
    expect(policy.upgradeAuthority).toBe(chainSnapshot.programData.upgradeAuthority);
    expect(policy.programSha256).toBe(chainSnapshot.programData.elfSha256);
    expect(policy.programBytes).toBe(chainSnapshot.programData.elfBytes);
    expect(policy.rentSha256).toBe(createHash('sha256').update(Buffer.from(chainSnapshot.rent.dataBase64, 'base64')).digest('hex'));
    expect(policy.domainRent).toBe(BigInt(chainSnapshot.quote.domainRent));
    expect(policy.primaryRent).toBe(BigInt(chainSnapshot.quote.primaryRent));
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe('finalized registry observations', () => {
  it('reads all account evidence together and obtains current rents and a subsequent blockhash', async () => {
    const f = chainFixture();
    const observation = await f.client.observe(f.input);
    expect(observation).toMatchObject({ ...f.input, registrationPrice: 15_000_000_000_000n,
      domainRent: 1_927_920n, primaryRent: 1_426_800n, sponsorBalance: 1_000_000_000_000_000n,
      observedSlot: 100, blockhashContextSlot: 101, observedAtMs: 1_800_000_000_000, lastValidBlockHeight: 200,
      genesisHash: f.policy.genesisHash, policyId: f.policy.id,
      configSha256: f.policy.configSha256, programSha256: f.policy.programSha256,
    });
    expect(f.connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledOnce();
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[0]![0]).toHaveLength(11);
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 0 });
    expect(f.connection.getLatestBlockhashAndContext).toHaveBeenCalledWith({ commitment: 'finalized', minContextSlot: 100 });
    expect(f.connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(149, 'finalized');
    expect(f.connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(77, 'finalized');
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it('allows an absent sponsor with zero balance and never offsets missing-primary rent against user funds', async () => {
    const f = chainFixture();
    f.accounts.delete(f.input.sponsor.toBase58());
    f.accounts.set(f.input.user.toBase58(), systemAccount(5_000_000_000));
    expect(await f.client.observe(f.input)).toMatchObject({ sponsorBalance: 0n, primaryRent: f.policy.primaryRent });
  });

  it('allows only a valid, adequately funded cleared user primary', async () => {
    const f = chainFixture();
    f.accounts.set(primaryPda(f.input.user).toBase58(), primaryAccount(f.input.user));
    expect((await f.client.observe(f.input)).primaryRent).toBe(0n);
    f.accounts.get(primaryPda(f.input.user).toBase58())!.lamports--;
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'USER_INELIGIBLE' });
  });

  it.each(['abc', 'ALICE', 'alice.cook', '../name', 'café', 'a'.repeat(33)])('rejects noncanonical or invalid name %s before RPC', async (label) => {
    const f = chainFixture();
    await expect(f.client.observe({ ...f.input, label })).rejects.toMatchObject({ code: 'INVALID_NAME' });
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled();
  });

  it('rejects actor aliases before RPC', async () => {
    const f = chainFixture();
    for (const user of [f.input.sponsor, new PublicKey(f.policy.feeReceiverAddress), SystemProgram.programId, primaryPda(f.input.user)]) {
      await expect(f.client.observe({ ...f.input, user })).rejects.toMatchObject({ code: 'INVALID_ACCOUNTS' });
    }
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled();
  });

  it('isolates keys and observed account values across asynchronous adapter calls', async () => {
    const f = chainFixture();
    const user = f.input.user.toBase58();
    const balance = f.accounts.get(f.input.sponsor.toBase58())!.lamports;
    const originalRead = f.connection.getMultipleAccountsInfoAndContext.getMockImplementation()!;
    f.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (keys, options) => {
      const snapshot = await originalRead(keys, options);
      (keys[10]! as unknown as { _bn: unknown })._bn = (f.input.attemptPayer as unknown as { _bn: unknown })._bn;
      return snapshot;
    });
    const originalBlock = f.connection.getLatestBlockhashAndContext.getMockImplementation()!;
    f.connection.getLatestBlockhashAndContext.mockImplementation(async (options) => {
      f.accounts.get(f.input.sponsor.toBase58())!.lamports = 1;
      (f.input.user as unknown as { _bn: unknown })._bn = (f.input.attemptPayer as unknown as { _bn: unknown })._bn;
      return originalBlock(options);
    });
    const observation = await f.client.observe(f.input);
    expect(observation.user.toBase58()).toBe(user);
    expect(observation.sponsorBalance).toBe(BigInt(balance));
  });

  it('rejects another genesis before reading accounts', async () => {
    const f = chainFixture();
    f.connection.getGenesisHash.mockResolvedValue('another-chain');
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(f.connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
  });

  it.each(['program executable', 'program owner', 'program pointer', 'program layout', 'data executable', 'data owner',
    'deployment', 'authority', 'ELF', 'config bytes', 'config owner', 'rent bytes', 'receiver owner'])('fails closed when %s changes', async (field) => {
    const f = chainFixture();
    const program = f.accounts.get(PROGRAM_ID.toBase58())!;
    const data = f.accounts.get(f.policy.programDataAddress)!;
    const config = f.accounts.get(configPda().toBase58())!;
    const receiver = f.accounts.get(f.policy.feeReceiverAddress)!;
    switch (field) {
      case 'program executable': program.executable = false; break;
      case 'program owner': program.owner = SystemProgram.programId; break;
      case 'program pointer': program.data[4] = program.data[4]! ^ 1; break;
      case 'program layout': program.data = Buffer.alloc(35); break;
      case 'data executable': data.executable = true; break;
      case 'data owner': data.owner = SystemProgram.programId; break;
      case 'deployment': data.data.writeBigUInt64LE(99n, 4); break;
      case 'authority': data.data[12] = 0; break;
      case 'ELF': data.data[50] = data.data[50]! ^ 1; break;
      case 'config bytes': config.data[72] = config.data[72]! ^ 1; break;
      case 'config owner': config.owner = SystemProgram.programId; break;
      case 'rent bytes': f.accounts.get(SYSVAR_RENT_PUBKEY.toBase58())!.data[0] = 0; break;
      case 'receiver owner': receiver.owner = PROGRAM_ID; break;
    }
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
  });

  it('rejects mismatched live rent RPC values', async () => {
    const f = chainFixture();
    f.connection.getMinimumBalanceForRentExemption.mockResolvedValue(1);
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
  });

  it.each(['taken', 'malformed', 'zero system allocation'])('treats %s domain as unavailable', async (kind) => {
    const f = chainFixture();
    const account = systemAccount();
    if (kind !== 'zero system allocation') { account.data = Buffer.alloc(kind === 'taken' ? 149 : 7); account.owner = PROGRAM_ID; }
    f.accounts.set(domainPda(f.input.label).toBase58(), account);
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'NAME_UNAVAILABLE' });
  });

  it.each(['allocated zero balance', 'funded', 'primary exists'])('rejects fresh-A violation: %s', async (kind) => {
    const f = chainFixture();
    if (kind === 'primary exists') f.accounts.set(primaryPda(f.input.attemptPayer).toBase58(), primaryAccount(f.input.attemptPayer));
    else f.accounts.set(f.input.attemptPayer.toBase58(), systemAccount(kind === 'funded' ? 1 : 0));
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FRESH' });
  });

  it.each(['existing name', 'malformed primary', 'non-system user', 'executable user', 'user data'])('rejects ineligible user: %s', async (kind) => {
    const f = chainFixture();
    if (kind === 'existing name') f.accounts.set(primaryPda(f.input.user).toBase58(), primaryAccount(f.input.user, 'abc'));
    else if (kind === 'malformed primary') f.accounts.set(primaryPda(f.input.user).toBase58(), systemAccount());
    else {
      const account = systemAccount();
      if (kind === 'non-system user') account.owner = PROGRAM_ID;
      if (kind === 'executable user') account.executable = true;
      if (kind === 'user data') account.data = Buffer.alloc(1);
      f.accounts.set(f.input.user.toBase58(), account);
    }
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'USER_INELIGIBLE' });
  });

  it('rejects a sponsor with allocated data', async () => {
    const f = chainFixture();
    f.accounts.get(f.input.sponsor.toBase58())!.data = Buffer.alloc(80);
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'SPONSOR_INVALID' });
  });

  it.each([NaN, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe RPC value %s before bigint conversion', async (value) => {
    const f = chainFixture();
    f.accounts.get(f.input.sponsor.toBase58())!.lamports = value;
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'UNSAFE_RPC_VALUE' });
    f.accounts.get(f.input.sponsor.toBase58())!.lamports = 0;
    f.connection.getMinimumBalanceForRentExemption.mockResolvedValue(value);
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'UNSAFE_RPC_VALUE' });
  });

  it('rejects an older blockhash context and invalid expiry height', async () => {
    const f = chainFixture();
    f.connection.getLatestBlockhashAndContext.mockResolvedValue({ context: { slot: 99 }, value: { blockhash: f.input.user.toBase58(), lastValidBlockHeight: 200 } });
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    f.connection.getLatestBlockhashAndContext.mockResolvedValue({ context: { slot: 101 }, value: { blockhash: f.input.user.toBase58(), lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 } });
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'UNSAFE_RPC_VALUE' });
  });

  it('rejects finalized snapshot rollback across observations', async () => {
    const f = chainFixture();
    await f.client.observe(f.input);
    f.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (keys) => ({
      context: { slot: 100 }, value: keys.map((key) => f.accounts.get(key.toBase58()) ?? null),
    }));
    await expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[1]![1]).toEqual({ commitment: 'finalized', minContextSlot: 101 });
  });
});

describe('bounded and redacted RPC calls', () => {
  it('does not retain endpoint credentials, server text, stack or original cause', async () => {
    const f = chainFixture();
    f.connection.getGenesisHash.mockRejectedValue(new Error('https://rpc.invalid/secret-token?api_key=hidden wallet-private-value'));
    const error = await f.client.observe(f.input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RegistryClientError);
    expect(error).toMatchObject({ code: 'RPC_FAILED' });
    expect(JSON.stringify(error)).not.toMatch(/secret-token|hidden|wallet-private-value/);
    expect(String(error)).not.toMatch(/secret-token|hidden|wallet-private-value/);
    expect((error as Error).cause).toBeUndefined();
  });

  it('times out a stalled injected RPC without waiting indefinitely', async () => {
    vi.useFakeTimers();
    const f = chainFixture({ requestTimeoutMs: 10 });
    f.connection.getGenesisHash.mockImplementation(() => new Promise(() => {}));
    const result = expect(f.client.observe(f.input)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it('supplies an abort deadline to actual HTTP transport without a live request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('token in remote details', 'AbortError');
    });
    const client = createRegistryClient('https://rpc.invalid/secret-token');
    await expect(client.observe(chainFixture().input)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockRestore();
  });
});

describe('message fees', () => {
  const message = new Message({ header: { numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    accountKeys: [], recentBlockhash: PublicKey.default.toBase58(), instructions: [] });

  it('returns the exact fee at or after the observation context', async () => {
    const f = chainFixture();
    expect(await f.client.getMessageFee(message, 101)).toBe(15000n);
    expect(f.connection.getFeeForMessage).toHaveBeenCalledWith(message, 'finalized');
  });

  it.each([[null, 'FEE_UNAVAILABLE'], [-1, 'UNSAFE_RPC_VALUE'], [0.1, 'UNSAFE_RPC_VALUE'],
    [Number.MAX_SAFE_INTEGER + 1, 'UNSAFE_RPC_VALUE']] as const)('rejects invalid fee %s', async (value, code) => {
    const f = chainFixture();
    f.connection.getFeeForMessage.mockResolvedValue({ context: { slot: 102 }, value });
    await expect(f.client.getMessageFee(message, 101)).rejects.toMatchObject({ code });
  });

  it('rejects stale fee context', async () => {
    const f = chainFixture();
    await expect(f.client.getMessageFee(message, 103)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  });
});
