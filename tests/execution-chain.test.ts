import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey, Transaction, VersionedTransaction, type AccountInfo, type SignatureStatus, type VersionedTransactionResponse } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import type { RegistryObservation } from '../src/lib/chain/client';
import { domainPda, DOMAIN_SIZE, PROGRAM_ID, primaryPda } from '../src/lib/cookie/registry';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { createExecutionChain, type ExecutionChainOptions, type ExecutionRpcConnection } from '../src/lib/execution/chain';
import { coSignRegistration } from '../src/lib/execution/crypto';
import type { ExecutionAttempt, ExecutionOperation } from '../src/lib/execution/types';
import { prepareSponsoredQuote } from '../src/lib/transactions/quote';
import { primaryAccount, systemAccount } from './helpers/chain-fixture';

const epoch = 1_800_000_000_000;
const secretEndpoint = 'https://operator:private@rpc.invalid?api-key=secret';
const actors = [1, 2, 3].map((seed) => Keypair.fromSeed(Buffer.alloc(32, seed)));
const [sponsor, payer, user] = actors as [Keypair, Keypair, Keypair];
const blockhash = Keypair.fromSeed(Buffer.alloc(32, 4)).publicKey.toBase58();
const limits = { maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: 15_000n, recoveryAllowance: 15_000n, maxReservation: 15_000_003_384_720n, ttlMs: 30_000 };
function base58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${bytes.toString('hex')}`), out = '', zeroes = 0;
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + out;
}
function domainAccount(): AccountInfo<Buffer> {
  const name = 'firstbite', offset = 12 + name.length, data = Buffer.alloc(DOMAIN_SIZE);
  Buffer.from('239262700de6e799', 'hex').copy(data);
  data.writeUInt32LE(name.length, 8); Buffer.from(name).copy(data, 12); user.publicKey.toBuffer().copy(data, offset);
  data[offset + 104] = PublicKey.findProgramAddressSync([Buffer.from('domain'), Buffer.from(name)], PROGRAM_ID)[1];
  return { data, owner: PROGRAM_ID, executable: false, lamports: Number(policy.domainRent) };
}
async function fixture(options: ExecutionChainOptions = {}) {
  const observed: { -readonly [K in keyof RegistryObservation]: RegistryObservation[K] } = {
    label: 'firstbite', sponsor: sponsor.publicKey, attemptPayer: payer.publicKey, user: user.publicKey,
    feeReceiver: new PublicKey(policy.feeReceiverAddress), registrationPrice: 15_000_000_000_000n,
    domainRent: policy.domainRent, primaryRent: policy.primaryRent, sponsorBalance: 100_000_000_000_000n,
    blockhash, lastValidBlockHeight: 200, observedSlot: 100, blockhashContextSlot: 101, observedAtMs: epoch,
    genesisHash: policy.genesisHash, configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id,
  };
  const registry = { observe: vi.fn(async () => observed), getMessageFee: vi.fn(async () => 15_000n) };
  const quote = await prepareSponsoredQuote({ name: observed.label, sponsor: sponsor.publicKey, attemptPayer: payer.publicKey, user: user.publicKey }, registry, limits, () => epoch);
  observed.observedSlot = 102; observed.blockhashContextSlot = 103;
  registry.observe.mockClear(); registry.getMessageFee.mockClear();
  const userTx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
  userTx.partialSign(user);
  const userSignedBase64 = unsignedBytes(userTx).toString('base64');
  const signed = coSignRegistration(quote.unsignedTransactionBase64, userSignedBase64, sponsor.secretKey, payer.secretKey, quote.user);
  const signedTx = Transaction.from(Buffer.from(signed.signedBase64, 'base64'));
  const receipt: VersionedTransactionResponse = {
    slot: 110, version: 'legacy', transaction: { message: signedTx.compileMessage(), signatures: signedTx.signatures.map(({ signature }) => base58(signature!)) },
    meta: { err: null, fee: 15000, preBalances: signedTx.compileMessage().accountKeys.map(() => 0), postBalances: signedTx.compileMessage().accountKeys.map(() => 0) },
  };
  const accounts = new Map<string, AccountInfo<Buffer>>([[quote.sponsor, systemAccount(100_000_000)], [quote.attemptPayer, systemAccount(50_000)]]);
  const connection = {
    getGenesisHash: vi.fn(async () => policy.genesisHash),
    getBlockHeight: vi.fn<ExecutionRpcConnection['getBlockHeight']>(async () => 150),
    getSignatureStatuses: vi.fn<ExecutionRpcConnection['getSignatureStatuses']>(async () => ({ context: { slot: 115 }, value: [null] })),
    getTransaction: vi.fn(async () => receipt as VersionedTransactionResponse | null) as ReturnType<typeof vi.fn<ExecutionRpcConnection['getTransaction']>>,
    getMultipleAccountsInfoAndContext: vi.fn<ExecutionRpcConnection['getMultipleAccountsInfoAndContext']>(async (keys, config) => ({ context: { slot: Math.max(111, typeof config === 'object' ? config.minContextSlot ?? 0 : 0) }, value: keys.map((address) => accounts.get(address.toBase58()) ?? null) })),
    getLatestBlockhashAndContext: vi.fn<ExecutionRpcConnection['getLatestBlockhashAndContext']>(async () => ({ context: { slot: 112 }, value: { blockhash, lastValidBlockHeight: 200 } })),
    getFeeForMessage: vi.fn<ExecutionRpcConnection['getFeeForMessage']>(async () => ({ context: { slot: 113 }, value: 15_000 })),
    simulateTransaction: vi.fn(async () => ({ context: { slot: 114 }, value: { err: null, logs: null } })) as ReturnType<typeof vi.fn<ExecutionRpcConnection['simulateTransaction']>>,
    sendRawTransaction: vi.fn<ExecutionRpcConnection['sendRawTransaction']>(async () => signed.signature),
  };
  const operation: ExecutionOperation = { id: randomUUID(), attemptId: randomUUID(), campaignId: randomUUID(), kind: 'registration', status: 'signed',
    messageHash: quote.messageSha256, messageBase64: quote.messageBase64, encryptedUserPayload: null, encryptedSignedPayload: null,
    signature: signed.signature, blockhash, lastValidBlockHeight: 200, feeCapNative: '15000', amountNative: quote.cost.maxSponsorDebit, authorizedAt: new Date(epoch) };
  const attempt = { id: operation.attemptId, payerPublicKey: quote.attemptPayer, wallet: quote.user, name: quote.name } as ExecutionAttempt;
  const chain = createExecutionChain(secretEndpoint, { connection: connection as unknown as ExecutionRpcConnection, registry, clock: () => epoch + 1_000, ...options });
  const status = (confirmationStatus: SignatureStatus['confirmationStatus'], err: SignatureStatus['err'] = null) => connection.getSignatureStatuses.mockResolvedValue({ context: { slot: 115 }, value: [{ slot: 110, ...(confirmationStatus ? { confirmationStatus } : {}), err, confirmations: confirmationStatus === 'finalized' ? null : 1 }] });
  return { chain, connection, registry, observed, quote, userSignedBase64, signed, operation, attempt, receipt, accounts, status };
}
afterEach(() => vi.useRealTimers());

describe('execution preflight', () => {
  it('rechecks the original fee and simulates the exact user-signed legacy packet without replacing its blockhash', async () => {
    const f = await fixture();
    expect(await f.chain.preflight(f.quote, f.userSignedBase64)).toEqual({ checkedAtMs: epoch + 1000, slot: 114, blockHeight: 150, fee: 15000n, sponsorBalance: f.observed.sponsorBalance });
    const [message] = f.connection.getFeeForMessage.mock.calls[0]!;
    expect(Buffer.from(message.serialize()).toString('base64')).toBe(f.quote.messageBase64);
    const [tx, config] = f.connection.simulateTransaction.mock.calls[0]!;
    expect(tx).toBeInstanceOf(VersionedTransaction);
    expect(Buffer.from((tx as VersionedTransaction).serialize()).toString('base64')).toBe(f.userSignedBase64);
    expect(config).toEqual({ commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: 113 });
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('rejects an absent user signature before any RPC', async () => {
    const f = await fixture();
    await expect(f.chain.preflight(f.quote, f.quote.unsignedTransactionBase64)).rejects.toMatchObject({ code: 'signature_invalid' });
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled();
  });
  it.each([{ registrationPrice: 1n }, { domainRent: 1n }, { primaryRent: 0n }, { configSha256: 'a'.repeat(64) }, { programSha256: 'a'.repeat(64) }, { policyId: 'changed' }])('rejects changed registration evidence: %s', async (change) => {
    const f = await fixture(); Object.assign(f.observed, change);
    await expect(f.chain.preflight(f.quote, f.userSignedBase64)).rejects.toMatchObject({ code: 'policy_changed' });
    expect(f.connection.simulateTransaction).not.toHaveBeenCalled();
  });
  it('rejects fee increases, missing fees, insufficient sponsor funding, expiry and an expired blockhash', async () => {
    for (const change of ['fee', 'missing', 'balance', 'time', 'block']) {
      const f = await fixture(change === 'time' ? { clock: () => epoch + 30_000 } : {});
      if (change === 'fee') f.connection.getFeeForMessage.mockResolvedValue({ context: { slot: 113 }, value: 15001 });
      if (change === 'missing') f.connection.getFeeForMessage.mockResolvedValue({ context: { slot: 113 }, value: null });
      if (change === 'balance') f.observed.sponsorBalance = 1n;
      if (change === 'block') f.connection.getBlockHeight.mockResolvedValue(201);
      await expect(f.chain.preflight(f.quote, f.userSignedBase64)).rejects.toMatchObject({ code: change === 'fee' ? 'policy_changed' : change === 'balance' ? 'budget_exhausted' : 'quote_expired' });
      expect(f.connection.simulateTransaction).not.toHaveBeenCalled();
    }
  });
  it('rejects unsuccessful or stale simulation and unsafe RPC fee values', async () => {
    for (const change of ['failed', 'stale', 'unsafe']) {
      const f = await fixture();
      if (change === 'failed') f.connection.simulateTransaction.mockResolvedValue({ context: { slot: 114 }, value: { err: 'InstructionError', logs: null } });
      if (change === 'stale') f.connection.simulateTransaction.mockResolvedValue({ context: { slot: 112 }, value: { err: null, logs: null } });
      if (change === 'unsafe') f.connection.getFeeForMessage.mockResolvedValue({ context: { slot: 113 }, value: Number.MAX_SAFE_INTEGER + 1 });
      await expect(f.chain.preflight(f.quote, f.userSignedBase64)).rejects.toMatchObject({ code: 'evidence_invalid' });
    }
  });
  it('fails closed on wrong genesis and redacts upstream credential errors', async () => {
    const f = await fixture(); f.connection.getGenesisHash.mockResolvedValue(blockhash);
    await expect(f.chain.preflight(f.quote, f.userSignedBase64)).rejects.toMatchObject({ code: 'policy_changed' });
    f.connection.getGenesisHash.mockRejectedValue(new Error(secretEndpoint));
    const error = await f.chain.preflight(f.quote, f.userSignedBase64).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: 'Execution unavailable: unavailable' });
    expect((error as Error).cause).toBeUndefined();
  });
  it('bounds an injected hanging RPC without retaining its raw result', async () => {
    vi.useFakeTimers(); const f = await fixture({ requestTimeoutMs: 20 });
    f.connection.getGenesisHash.mockImplementation(() => new Promise(() => {}));
    const pending = expect(f.chain.preflight(f.quote, f.userSignedBase64)).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(20); await pending;
  });
});

describe('broadcast boundary', () => {
  it('never sends by default, including valid fully signed bytes', async () => {
    const f = await fixture();
    await expect(f.chain.broadcast(f.signed.signedBase64)).rejects.toMatchObject({ code: 'disabled' });
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled(); expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('sends only canonical fully signed bytes with explicit enablement and verifies the returned signature', async () => {
    const f = await fixture({ allowBroadcast: true });
    await expect(f.chain.broadcast(f.signed.signedBase64)).resolves.toBe(f.signed.signature);
    expect(f.connection.sendRawTransaction).toHaveBeenCalledWith(Buffer.from(f.signed.signedBase64, 'base64'), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 });
    f.connection.sendRawTransaction.mockResolvedValue(blockhash);
    await expect(f.chain.broadcast(f.signed.signedBase64)).rejects.toMatchObject({ code: 'evidence_invalid' });
    await expect(f.chain.broadcast(f.userSignedBase64)).rejects.toMatchObject({ code: 'evidence_invalid' });
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
});

describe('finalized execution evidence', () => {
  it('keeps missing history ambiguous after expiry and requests historical signature search', async () => {
    const f = await fixture(); f.connection.getBlockHeight.mockResolvedValue(999);
    const result = await f.chain.observe(f.operation, f.attempt);
    expect(result).toMatchObject({ status: 'missing', receipt: null, finalizedBlockHeight: 999, payerBalance: 50000n });
    expect(f.connection.getSignatureStatuses).toHaveBeenCalledWith([f.signed.signature], { searchTransactionHistory: true });
    expect(f.connection.getTransaction).not.toHaveBeenCalled();
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 0 });
  });
  it.each(['processed', 'confirmed'] as const)('does not treat a %s error as a finalized failure', async (status) => {
    const f = await fixture(); f.status(status, { InstructionError: [2, 'Custom'] });
    expect(await f.chain.observe(f.operation, f.attempt)).toMatchObject({ status, receipt: null });
    expect(f.connection.getTransaction).not.toHaveBeenCalled();
  });
  it('reconstructs and verifies the exact finalized signed packet and reads ownership at its slot or later', async () => {
    const f = await fixture(); f.status('finalized');
    f.accounts.set(domainPda(f.quote.name).toBase58(), domainAccount());
    f.accounts.set(primaryPda(user.publicKey).toBase58(), primaryAccount(user.publicKey, f.quote.name));
    const result = await f.chain.observe(f.operation, f.attempt);
    expect(result).toMatchObject({ status: 'finalized', accountSlot: 111, domainOwner: f.quote.user, primaryOwner: f.quote.user, primaryName: f.quote.name,
      receipt: { signedBase64: f.signed.signedBase64, slot: 110, fee: 15000n, failed: false } });
    expect(f.connection.getTransaction).toHaveBeenCalledWith(f.signed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 110 });
  });
  it('keeps a finalized status without its transaction receipt unresolved', async () => {
    const f = await fixture(); f.status('finalized'); f.connection.getTransaction.mockResolvedValue(null);
    expect(await f.chain.observe(f.operation, f.attempt)).toMatchObject({ status: 'finalized', receipt: null });
  });
  it.each(['message', 'signature', 'slot', 'unsafe', 'balance-count', 'status-error'] as const)('rejects inconsistent finalized receipt %s', async (change) => {
    const f = await fixture(); f.status('finalized');
    if (change === 'message') f.operation.messageHash = 'a'.repeat(64);
    if (change === 'signature') f.receipt.transaction.signatures[1] = f.signed.signature;
    if (change === 'slot') f.receipt.slot = 109;
    if (change === 'unsafe') f.receipt.meta!.postBalances[0] = Number.MAX_SAFE_INTEGER + 1;
    if (change === 'balance-count') f.receipt.meta!.preBalances.pop();
    if (change === 'status-error') f.receipt.meta!.err = 'InstructionError';
    await expect(f.chain.observe(f.operation, f.attempt)).rejects.toMatchObject({ code: 'evidence_invalid' });
  });
  it('rejects malformed status, backward finalized contexts, and non-system payer accounts', async () => {
    for (const change of ['status', 'context', 'payer']) {
      const f = await fixture();
      if (change === 'status') f.status(undefined);
      if (change === 'context') {
        f.status('finalized');
        f.connection.getMultipleAccountsInfoAndContext.mockResolvedValue({ context: { slot: 109 }, value: [null, null, null] });
      }
      if (change === 'payer') f.accounts.set(f.quote.attemptPayer, primaryAccount(payer.publicKey));
      await expect(f.chain.observe(f.operation, f.attempt)).rejects.toMatchObject({ code: 'evidence_invalid' });
    }
  });
});

describe('recovery preparation', () => {
  it('quotes a fixed full-balance payer-to-sponsor recovery and checks its fee', async () => {
    const f = await fixture();
    expect(await f.chain.prepareRecovery({ sponsor: f.quote.sponsor, payer: f.quote.attemptPayer, amount: 50000n, maxFee: 15000n }))
      .toEqual({ blockhash, lastValidBlockHeight: 200, observedSlot: 111, fee: 15000n, preparedAtMs: epoch + 1000 });
    const [message] = f.connection.getFeeForMessage.mock.calls[0]!;
    expect(message.header.numRequiredSignatures).toBe(2);
    expect(message.staticAccountKeys[0]!.toBase58()).toBe(f.quote.sponsor);
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('rechecks the original persisted recovery blockhash, fee and unsigned simulation without fetching a replacement', async () => {
    const f = await fixture();
    const originalBlockhash = Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey.toBase58();
    const result = await f.chain.prepareRecovery({ sponsor: f.quote.sponsor, payer: f.quote.attemptPayer, amount: 50000n, maxFee: 15000n,
      validity: { blockhash: originalBlockhash, lastValidBlockHeight: 180 } });
    expect(result).toMatchObject({ blockhash: originalBlockhash, lastValidBlockHeight: 180 });
    expect(f.connection.getLatestBlockhashAndContext).not.toHaveBeenCalled();
    expect(f.connection.getFeeForMessage.mock.calls[0]![0].recentBlockhash).toBe(originalBlockhash);
    const [raw, config] = f.connection.simulateTransaction.mock.calls[0]!;
    const tx = raw as VersionedTransaction;
    expect(tx.message.recentBlockhash).toBe(originalBlockhash);
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(config).toEqual({ commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: 113 });
  });
  it('rejects an expired original recovery before quoting or simulating it', async () => {
    const f = await fixture();
    await expect(f.chain.prepareRecovery({ sponsor: f.quote.sponsor, payer: f.quote.attemptPayer, amount: 50000n, maxFee: 15000n,
      validity: { blockhash, lastValidBlockHeight: 149 } })).rejects.toMatchObject({ code: 'quote_expired' });
    expect(f.connection.getLatestBlockhashAndContext).not.toHaveBeenCalled();
    expect(f.connection.getFeeForMessage).not.toHaveBeenCalled();
    expect(f.connection.simulateTransaction).not.toHaveBeenCalled();
  });
  it.each(['failure', 'stale', 'replacement', 'expired-during-simulation'] as const)('rejects recovery simulation %s', async (change) => {
    const f = await fixture();
    if (change === 'failure') f.connection.simulateTransaction.mockResolvedValue({ context: { slot: 114 }, value: { err: 'InstructionError', logs: null } });
    if (change === 'stale') f.connection.simulateTransaction.mockResolvedValue({ context: { slot: 112 }, value: { err: null, logs: null } });
    if (change === 'replacement') f.connection.simulateTransaction.mockResolvedValue({ context: { slot: 114 }, value: { err: null, logs: null,
      ...{ replacementBlockhash: { blockhash, lastValidBlockHeight: 999 } } } });
    if (change === 'expired-during-simulation') f.connection.getBlockHeight.mockResolvedValueOnce(150).mockResolvedValue(201);
    await expect(f.chain.prepareRecovery({ sponsor: f.quote.sponsor, payer: f.quote.attemptPayer, amount: 50000n, maxFee: 15000n,
      validity: { blockhash, lastValidBlockHeight: 200 } })).rejects.toMatchObject({ code: change === 'expired-during-simulation' ? 'quote_expired' : 'evidence_invalid' });
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each(['residual', 'fee', 'sponsor', 'unsafe', 'expired', 'alias'] as const)('rejects unsafe recovery %s', async (change) => {
    const f = await fixture();
    const request = { sponsor: f.quote.sponsor, payer: f.quote.attemptPayer, amount: 50000n, maxFee: 15000n };
    if (change === 'residual') request.amount--;
    if (change === 'fee') request.maxFee = 14999n;
    if (change === 'sponsor') f.accounts.set(f.quote.sponsor, systemAccount(14999));
    if (change === 'unsafe') f.accounts.set(f.quote.attemptPayer, systemAccount(Number.MAX_SAFE_INTEGER + 1));
    if (change === 'expired') f.connection.getBlockHeight.mockResolvedValue(201);
    if (change === 'alias') request.payer = request.sponsor;
    await expect(f.chain.prepareRecovery(request)).rejects.toHaveProperty('code');
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
