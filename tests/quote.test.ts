import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemInstruction, Transaction, type Message } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClientError, type RegistryClient, type RegistryObservation } from '../src/lib/chain/client';
import { domainPda, primaryPda } from '../src/lib/cookie/registry';
import { assertUnsignedQuoteFresh, prepareSponsoredQuote, QuoteError, type QuoteLimits } from '../src/lib/transactions/quote';

const epoch = 1_789_344_000_000;
const limits: QuoteLimits = {
  maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: 15_000n,
  recoveryAllowance: 15_000n, maxReservation: 15_000_003_384_720n, ttlMs: 30_000,
};
function fixture() {
  const key = (seed: number) => Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
  const request = { name: ' FirstBite.cook ', sponsor: key(1), user: key(2), attemptPayer: key(3) };
  const observed: { -readonly [K in keyof RegistryObservation]: RegistryObservation[K] } = {
    label: 'firstbite', sponsor: request.sponsor, user: request.user, attemptPayer: request.attemptPayer,
    feeReceiver: key(4), registrationPrice: 15_000_000_000_000n, domainRent: 1_927_920n,
    primaryRent: 1_426_800n, sponsorBalance: 100_000_000_000_000n, userBalance: 0n,
    blockhash: key(5).toBase58(), lastValidBlockHeight: 20_000, observedSlot: 21_000, blockhashContextSlot: 21_001,
    observedAtMs: epoch, genesisHash: key(6).toBase58(), configSha256: 'a'.repeat(64),
    programSha256: 'b'.repeat(64), policyId: 'first-bite-registry-v1',
  };
  const client = { observe: vi.fn(async () => observed), getMessageFee: vi.fn(async (_message: Message, _slot: number) => 15_000n) } satisfies RegistryClient;
  const prepare = (bounds = limits, now = () => epoch) => prepareSponsoredQuote(request, client, bounds, now);
  return { request, observed, client, prepare };
}

describe('sponsored quote contract', () => {
  it('prepares deterministic unsigned bytes, exact costs and expected final ownership', async () => {
    const { request, observed, client, prepare } = fixture();
    const quote = await prepare();
    expect(await prepare()).toEqual(quote);
    expect(client.observe).toHaveBeenCalledWith({ label: 'firstbite', sponsor: request.sponsor, user: request.user, attemptPayer: request.attemptPayer });
    expect(client.getMessageFee.mock.calls[0]![1]).toBe(observed.blockhashContextSlot);
    expect(quote.cost).toEqual({ registrationPrice: '15000000000000', domainRent: '1927920', primaryRent: '1426800', transactionFee: '15000', recoveryAllowance: '15000', maxSponsorDebit: '15000003369720', maximumReservation: '15000003384720' });
    expect(quote.expected).toEqual({ domain: domainPda('firstbite').toBase58(), owner: request.user.toBase58(), primary: primaryPda(request.user).toBase58(), primaryName: 'firstbite' });
    const tx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
    expect(tx.signatures).toHaveLength(3);
    expect(tx.signatures.every(({ signature }) => signature === null)).toBe(true);
    expect(tx.serializeMessage().toString('base64')).toBe(quote.messageBase64);
    expect(quote.messageSha256).toBe(createHash('sha256').update(tx.serializeMessage()).digest('hex'));
    expect(quote.blockhash).toBe(observed.blockhash);
    expect(quote.lastValidBlockHeight).toBe(20_000);
    expect(quote.expiresAtMs).toBe(epoch + 30_000);
    expect(Object.isFrozen(quote) && Object.isFrozen(quote.cost) && Object.isFrozen(quote.expected)).toBe(true);
    expect(() => JSON.stringify(quote)).not.toThrow();
    expect(JSON.stringify(quote)).not.toMatch(/secretKey|privateKey/);
  });

  it('does not allocate funding for an already rent-funded cleared primary', async () => {
    const { observed, prepare } = fixture();
    observed.primaryRent = 0n;
    const quote = await prepare();
    const tx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
    expect(tx.instructions).toHaveLength(5);
    expect(quote.cost.primaryRent).toBe('0');
    expect(quote.cost.maximumReservation).toBe('15000001957920');
    expect(SystemInstruction.decodeTransfer(tx.instructions[1]!).lamports).toBe(15_000_001_927_920n);
  });

  it('retains exact base units beyond JavaScript safe-integer precision', async () => {
    const { observed, prepare } = fixture();
    observed.registrationPrice = 9_007_199_254_740_993n;
    observed.sponsorBalance = 10_000_000_000_000_000n;
    const quote = await prepare({ ...limits, maxRegistrationPrice: observed.registrationPrice, maxReservation: observed.sponsorBalance });
    expect(quote.cost.registrationPrice).toBe('9007199254740993');
    expect(BigInt(quote.cost.maximumReservation)).toBe(observed.registrationPrice + 3_384_720n);
  });

  it.each(['abc', 'a'.repeat(33), 'naïve', '-hello', 'hello..cook'])('rejects unsupported name %s before RPC', async (name) => {
    const { request, client, prepare } = fixture(); request.name = name;
    await expect(prepare()).rejects.toMatchObject({ code: 'invalid_name' });
    expect(client.observe).not.toHaveBeenCalled();
  });

  it.each([
    { ttlMs: 999 }, { ttlMs: 60_001 }, { ttlMs: NaN },
    { maxRegistrationPrice: 0n }, { maxTransactionFee: -1n }, { recoveryAllowance: 0n },
    { maxReservation: 1n << 64n }, { maxReservation: 5 as unknown as bigint },
  ])('rejects invalid operator limits without RPC: %s', async (changed) => {
    const { client, prepare } = fixture();
    await expect(prepare({ ...limits, ...changed })).rejects.toMatchObject({ code: 'invalid_limits' });
    expect(client.observe).not.toHaveBeenCalled();
  });

  it('enforces price, exact message fee, total cap and recovery funding', async () => {
    const { observed, client, prepare } = fixture();
    await expect(prepare({ ...limits, maxRegistrationPrice: limits.maxRegistrationPrice - 1n })).rejects.toMatchObject({ code: 'cost_limit' });
    expect(client.getMessageFee).not.toHaveBeenCalled();
    await expect(prepare({ ...limits, maxTransactionFee: 14_999n })).rejects.toMatchObject({ code: 'cost_limit' });
    await expect(prepare({ ...limits, maxReservation: limits.maxReservation - 1n })).rejects.toMatchObject({ code: 'cost_limit' });
    observed.sponsorBalance = limits.maxReservation - 1n;
    await expect(prepare()).rejects.toMatchObject({ code: 'insufficient_sponsor_balance' });
    observed.sponsorBalance = limits.maxReservation;
    await expect(prepare()).resolves.toHaveProperty('cost.maximumReservation', limits.maxReservation.toString());
  });

  it('rejects mismatched account observations and malformed counters/fingerprints', async () => {
    for (const changed of [
      { label: 'another' }, { user: PublicKey.default }, { observedSlot: NaN },
      { observedSlot: Number.MAX_SAFE_INTEGER + 1 }, { observedAtMs: epoch - 1 },
      { blockhashContextSlot: 20_999 }, { blockhashContextSlot: NaN },
      { lastValidBlockHeight: -1 }, { configSha256: 'bad' }, { programSha256: '' },
      { sponsorBalance: -1n }, { primaryRent: -1n }, { domainRent: 0n },
    ]) {
      const { observed, prepare } = fixture(); Object.assign(observed, changed);
      await expect(prepare()).rejects.toMatchObject({ code: 'invalid_observation' });
    }
  });

  it('rejects fee values outside the exact unsigned amount contract', async () => {
    for (const fee of [0n, -1n, 1n << 64n, 15_000 as unknown as bigint]) {
      const { client, prepare } = fixture(); client.getMessageFee.mockResolvedValue(fee);
      await expect(prepare()).rejects.toMatchObject({ code: 'invalid_observation' });
    }
  });

  it('wraps RPC failures without credentials, raw cause or signed payload details', async () => {
    const { client, prepare } = fixture();
    client.observe.mockRejectedValue(new Error('https://user:private@rpc.example?key=secret'));
    try { await prepare(); expect.fail('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(QuoteError);
      expect((error as Error).message).toBe('Quote unavailable: chain_unavailable');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    ['NAME_UNAVAILABLE', 'name_unavailable'],
    ['USER_INELIGIBLE', 'wallet_ineligible'],
  ] as const)('keeps an actionable %s observation distinct from an RPC outage', async (registryCode, quoteCode) => {
    const { client, prepare } = fixture();
    client.observe.mockRejectedValue(new RegistryClientError(registryCode));
    await expect(prepare()).rejects.toMatchObject({ code: quoteCode, message: `Quote unavailable: ${quoteCode}` });
    expect(client.getMessageFee).not.toHaveBeenCalled();
  });

  it('does not expose policy details or trust an untyped availability error', async () => {
    for (const failure of [
      new RegistryClientError('POLICY_CHANGED'), new RegistryClientError('RPC_TIMEOUT'),
      new RegistryClientError('ATTEMPT_NOT_FRESH'),
      Object.assign(new Error('private RPC response'), { code: 'NAME_UNAVAILABLE' }),
    ]) {
      const { client, prepare } = fixture();
      client.observe.mockRejectedValue(failure);
      await expect(prepare()).rejects.toMatchObject({ code: 'chain_unavailable', message: 'Quote unavailable: chain_unavailable' });
      expect(client.getMessageFee).not.toHaveBeenCalled();
    }
  });

  it('does not infer name availability from a fee adapter failure', async () => {
    const { client, prepare } = fixture();
    client.getMessageFee.mockRejectedValue(new RegistryClientError('NAME_UNAVAILABLE'));
    await expect(prepare()).rejects.toMatchObject({ code: 'chain_unavailable', message: 'Quote unavailable: chain_unavailable' });
  });

  it('expires slow preparation using its original lease, without refreshing the blockhash', async () => {
    const { prepare, client } = fixture();
    const now = vi.fn().mockReturnValueOnce(epoch).mockReturnValueOnce(epoch).mockReturnValue(epoch + limits.ttlMs);
    await expect(prepare(limits, now)).rejects.toMatchObject({ code: 'quote_expired' });
    expect(client.observe).toHaveBeenCalledOnce();
  });

  it('snapshots request identities and caps before asynchronous reads', async () => {
    const { request, client, observed } = fixture();
    let complete!: (value: RegistryObservation) => void;
    client.observe.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const bound = { ...limits };
    const pending = prepareSponsoredQuote(request, client, bound, () => epoch);
    request.name = 'changed'; request.user = PublicKey.default; bound.maxReservation = 1n;
    complete(observed);
    const quote = await pending;
    expect(quote.name).toBe('firstbite');
    expect(quote.user).toBe(observed.user.toBase58());
  });

  it('captures validated observation metadata and balance before awaiting the fee', async () => {
    const { observed, client, prepare } = fixture();
    observed.sponsorBalance = 1n;
    client.getMessageFee.mockImplementation(async () => {
      observed.sponsorBalance = limits.maxReservation;
      return 15_000n;
    });
    await expect(prepare()).rejects.toMatchObject({ code: 'insufficient_sponsor_balance' });
    client.getMessageFee.mockImplementation(async () => {
      observed.configSha256 = 'changed'; observed.lastValidBlockHeight = Number.MAX_SAFE_INTEGER + 1;
      return 15_000n;
    });
    const quote = await prepare();
    expect(quote.configSha256).toBe('a'.repeat(64));
    expect(quote.lastValidBlockHeight).toBe(20_000);
  });

  it('treats the last valid block height as inclusive but the wall-clock expiry as exclusive', async () => {
    const { prepare } = fixture(); const quote = await prepare();
    expect(() => assertUnsignedQuoteFresh(quote, epoch, 20_000)).not.toThrow();
    for (const [time, height] of [[epoch, 20_001], [epoch + 30_000, 20_000], [epoch - 1, 20_000], [epoch, NaN]]) {
      expect(() => assertUnsignedQuoteFresh(quote, time!, height!)).toThrow(QuoteError);
    }
  });
});
