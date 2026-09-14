import { randomUUID } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaignHandlers, type CampaignHttpDependencies } from '../src/lib/campaigns/http';
import { CampaignError, type AttemptView, type SessionContext } from '../src/lib/campaigns/types';
import { COOKIE_REGISTRY_POLICY } from '../src/lib/chain/policy';
import { openAttemptKey } from '../src/lib/security/attempt-key';
import { SESSION_COOKIE_NAME } from '../src/lib/security/http';
import { generateToken, hashToken } from '../src/lib/security/tokens';
import { createLogger } from '../src/server/logger';
import { chainFixture } from './helpers/chain-fixture';

const origin = 'https://localhost:3000';
const now = 1_800_000_000_000;
const encryptionKey = Buffer.alloc(32, 11).toString('base64');

function fixture(overrides: Partial<CampaignHttpDependencies> = {}) {
  const chain = chainFixture();
  const token = generateToken();
  const sessionToken = generateToken();
  const context: SessionContext = {
    sessionId: randomUUID(), inviteId: randomUUID(), campaignId: randomUUID(), wallet: chain.input.user.toBase58(),
    campaign: { id: randomUUID(), slug: 'local-pilot', name: 'Local pilot', status: 'active',
      startsAt: new Date(now - 60_000), endsAt: new Date(now + 3_600_000), maxUsers: 10,
      capNative: '150000100000000', reservedNative: '0', spentNative: '0', reservedUsers: 0, consumedUsers: 0,
      sponsorPublicKey: chain.input.sponsor.toBase58(), policyVersion: COOKIE_REGISTRY_POLICY.id,
      limits: { maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: 15_000n,
        recoveryAllowance: 15_000n, maxReservation: 15_000_010_000_000n, ttlMs: 45_000 } },
  };
  const id = randomUUID();
  const attempt: AttemptView = { id, quoteId: id, status: 'prepared', name: 'firstbite', wallet: context.wallet,
    reservationNative: '15000003384720', messageHash: 'a'.repeat(64), unsignedTransactionBase64: 'unsigned-fixture', expiresAt: new Date(now + 45_000) };
  const store = {
    publicCampaign: vi.fn(async () => ({ ...context.campaign, nameRule: '4–32 lowercase letters, numbers, and internal hyphens' })),
    exchangeInvite: vi.fn(async () => ({ sessionToken, expiresAt: new Date(now + 15 * 60_000), context })),
    getSession: vi.fn(async () => context),
    saveQuote: vi.fn<ReturnType<CampaignHttpDependencies['getStore']>['saveQuote']>(async (_token, input) => ({
      quoteId: input.id, expiresAt: new Date(input.quote.expiresAtMs), cost: input.quote.cost,
    })),
    reserveAttempt: vi.fn(async () => attempt), getAttempt: vi.fn(async () => attempt),
    takeRateLimit: vi.fn<ReturnType<CampaignHttpDependencies['getStore']>['takeRateLimit']>(async () => undefined),
  };
  const lines: string[] = [];
  const getStore = vi.fn(() => store);
  const getRegistry = vi.fn(() => chain.client);
  const deps: CampaignHttpDependencies = { preparationEnabled: true, appOrigin: origin, attemptEncryptionKey: encryptionKey,
    trustedIpHeader: 'none', getStore, getRegistry, log: createLogger((line) => lines.push(line)), now: () => now, ...overrides };
  const handlers = createCampaignHandlers(deps);
  function post(body: unknown, headers: Record<string, string> = {}) {
    return new Request(`${origin}/api/quotes`, { method: 'POST', headers: { origin, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, ...headers }, body: JSON.stringify(body) });
  }
  function get(headers: Record<string, string> = {}) {
    return new Request(`${origin}/api/attempts/${id}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, ...headers } });
  }
  return { handlers, store, getStore, getRegistry, chain, lines, context, token, sessionToken, attempt, post, get };
}

afterEach(() => vi.restoreAllMocks());

describe('campaign API boundary', () => {
  it.each(['exchange', 'quote', 'reserve'] as const)('keeps disabled %s free of database and RPC work', async (operation) => {
    const f = fixture({ preparationEnabled: false });
    const result = await f.handlers[operation](f.post({}));
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe('PREPARATION_DISABLED');
    expect(f.getStore).not.toHaveBeenCalled();
    expect(f.getRegistry).not.toHaveBeenCalled();
  });

  it('requires a wrapping key before enabled mutations touch storage', async () => {
    const f = fixture({ attemptEncryptionKey: undefined });
    expect((await f.handlers.exchange(f.post({ token: f.token }))).status).toBe(503);
    expect(f.getStore).not.toHaveBeenCalled();
  });

  it.each([
    { origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' },
  ])('rejects unsafe browser mutation headers', async (headers) => {
    const f = fixture();
    const result = await f.handlers.exchange(f.post({ token: f.token }, headers));
    expect([400, 403]).toContain(result.status);
    expect(f.getStore).not.toHaveBeenCalled();
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects unexpected fields and oversized JSON before store calls', async () => {
    const f = fixture();
    expect((await f.handlers.exchange(f.post({ token: f.token, campaignId: 'chosen-by-client' }))).status).toBe(400);
    expect((await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet, sponsor: f.context.wallet }))).status).toBe(400);
    expect((await f.handlers.reserve(f.post({ quoteId: f.attempt.quoteId, idempotencyKey: 'x'.repeat(16), transaction: 'arbitrary' }))).status).toBe(400);
    expect((await f.handlers.exchange(f.post({ token: 'x'.repeat(5000) }))).status).toBe(413);
    const malformed = new Request(origin, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{private-value' });
    expect((await f.handlers.exchange(malformed)).status).toBe(400);
    expect(f.getStore).not.toHaveBeenCalled();
    expect(f.lines.join('')).not.toContain('private-value');
  });

  it('exchanges a token into a secure capability cookie without putting it in JSON', async () => {
    const f = fixture();
    const result = await f.handlers.exchange(f.post({ token: f.token }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ wallet: f.context.wallet, expiresAt: new Date(now + 15 * 60_000).toISOString(),
      campaign: { name: 'Local pilot', slug: 'local-pilot', status: 'active' } });
    expect(result.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=${f.sessionToken}; Path=/;`);
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Secure');
    expect(f.store.exchangeInvite).toHaveBeenCalledWith(f.token);
    const buckets = f.store.takeRateLimit.mock.calls.flatMap(([b]) => b);
    expect(buckets.map((b) => b.scope)).toEqual(['exchange:global', 'exchange:ip', 'exchange:invite']);
    expect(buckets[2]!.identity).toBe(hashToken(f.token, 'invite'));
    expect(JSON.stringify(buckets)).not.toContain(f.token);
    expect(f.lines).toEqual([]);
  });

  it.each(['', 'first_bite_session=invalid', 'duplicate'])('requires an unambiguous session cookie for protected routes: %s', async (cookie) => {
    const f = fixture();
    const value = cookie === 'duplicate' ? `${SESSION_COOKIE_NAME}=${f.sessionToken}; ${SESSION_COOKIE_NAME}=${f.sessionToken}` : cookie;
    expect((await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }, { cookie: value }))).status).toBe(401);
    expect((await f.handlers.reserve(f.post({ quoteId: f.attempt.quoteId, idempotencyKey: 'x'.repeat(16) }, { cookie: value }))).status).toBe(401);
    expect((await f.handlers.attempt(f.get({ cookie: value }), f.attempt.id)).status).toBe(401);
    expect(f.getStore).not.toHaveBeenCalled();
  });

  it('requires the invitation wallet before querying the registry', async () => {
    const f = fixture();
    const result = await f.handlers.quote(f.post({ name: 'firstbite', wallet: Keypair.generate().publicKey.toBase58() }));
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe('WALLET_MISMATCH');
    expect(f.getRegistry).not.toHaveBeenCalled();
    expect(f.store.saveQuote).not.toHaveBeenCalled();
    expect(f.store.takeRateLimit.mock.calls.flatMap(([b]) => b).map((b) => b.scope)).toEqual(['quote:global', 'quote:ip', 'quote:session', 'quote:wallet', 'quote:invite']);
  });

  it('prepares and encrypts the exact fixed quote using a fresh payer and authenticated ID', async () => {
    const f = fixture();
    // Each fixture is a single read snapshot with a fixed fee context slot.
    f.getRegistry.mockReturnValueOnce(f.chain.client).mockReturnValueOnce(chainFixture().client);
    const first = await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }));
    expect(first.status).toBe(200);
    const body = await first.json();
    const saved = f.store.saveQuote.mock.calls[0]![1];
    expect(body).toEqual({ quoteId: saved.id, name: 'firstbite', cost: saved.quote.cost,
      expiresAt: new Date(now + 45_000).toISOString(), expected: saved.quote.expected });
    const secret = openAttemptKey(saved.encryptedPayerKey, encryptionKey, saved.id, saved.quote.attemptPayer);
    expect(Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(saved.quote.attemptPayer);
    secret.fill(0);
    const tx = Transaction.from(Buffer.from(saved.quote.unsignedTransactionBase64, 'base64'));
    expect(tx.signatures).toHaveLength(3);
    expect(tx.signatures.every((signature) => signature.signature === null)).toBe(true);
    expect(body).not.toHaveProperty('encryptedPayerKey');
    expect(body).not.toHaveProperty('unsignedTransactionBase64');
    expect(body).not.toHaveProperty('messageBase64');
    expect(f.store.reserveAttempt).not.toHaveBeenCalled();
    expect((await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }))).status).toBe(200);
    expect(f.store.saveQuote.mock.calls[1]![1].quote.attemptPayer).not.toBe(saved.quote.attemptPayer);
    expect(f.store.saveQuote.mock.calls[1]![1].id).not.toBe(saved.id);
  });

  it.each([false, true])('clears the owned secret copy after quote processing (failed=%s)', async (failed) => {
    const f = fixture();
    const payer = Keypair.generate();
    const owned = payer.secretKey;
    Object.defineProperty(payer, 'secretKey', { get: () => owned });
    vi.spyOn(Keypair, 'generate').mockReturnValueOnce(payer);
    if (failed) f.store.saveQuote.mockRejectedValueOnce(new Error('private-storage-message'));
    expect((await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }))).status).toBe(failed ? 500 : 200);
    expect(owned.every((byte) => byte === 0)).toBe(true);
    expect(f.lines.join('')).not.toContain('private-storage-message');
  });

  it('redacts registry failure details and never stores a failed preparation', async () => {
    const f = fixture();
    f.chain.connection.getGenesisHash.mockRejectedValueOnce(new Error('https://rpc.example/?secret=sensitive'));
    const result = await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }));
    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.error.code).toBe('RPC_UNAVAILABLE');
    expect(JSON.stringify(body) + f.lines.join('')).not.toContain('sensitive');
    expect(f.store.saveQuote).not.toHaveBeenCalled();
  });

  it('reserves only by saved quote ID and idempotency key and projects safe attempt fields', async () => {
    const f = fixture();
    f.store.reserveAttempt.mockResolvedValueOnce({ ...f.attempt, encryptedPayerKey: 'hidden-key', signedPayload: 'hidden-bytes' } as AttemptView);
    const input = { quoteId: f.attempt.quoteId, idempotencyKey: 'abcdefgh12345678' };
    const result = await f.handlers.reserve(f.post(input));
    expect(result.status).toBe(200);
    expect(f.store.reserveAttempt).toHaveBeenCalledWith(f.sessionToken, input);
    expect(await result.json()).toEqual({ attempt: { ...f.attempt, expiresAt: f.attempt.expiresAt.toISOString() } });
    expect(f.getRegistry).not.toHaveBeenCalled();
  });

  it('keeps authenticated attempt inspection available while preparation is disabled or campaign paused', async () => {
    const f = fixture({ preparationEnabled: false });
    f.context.campaign.status = 'paused';
    f.store.getSession.mockRejectedValueOnce(new CampaignError('campaign_unavailable'));
    const result = await f.handlers.attempt(f.get(), f.attempt.id);
    expect(result.status).toBe(200);
    expect(f.store.getSession).not.toHaveBeenCalled();
    expect(f.store.getAttempt).toHaveBeenCalledWith(f.sessionToken, f.attempt.id);
    expect(f.store.takeRateLimit.mock.calls.flatMap(([b]) => b).map((b) => b.scope)).toEqual(['attempt-read:global', 'attempt-read:ip', 'attempt-read:session']);
  });

  it('returns no attempt when storage rejects the capability or ownership', async () => {
    const f = fixture();
    f.store.getAttempt.mockRejectedValueOnce(new CampaignError('attempt_unavailable'));
    const result = await f.handlers.attempt(f.get(), f.attempt.id);
    expect(result.status).toBe(404);
    expect(await result.json()).not.toHaveProperty('attempt');
  });

  it('only exposes explicitly public campaign fields', async () => {
    const f = fixture({ preparationEnabled: false });
    const result = await f.handlers.publicCampaign(f.get(), 'local-pilot');
    const body = await result.json();
    expect(result.status).toBe(200);
    expect(body.campaign).toEqual({ name: 'Local pilot', slug: 'local-pilot', status: 'active',
      startsAt: f.context.campaign.startsAt.toISOString(), endsAt: f.context.campaign.endsAt.toISOString(),
      nameRule: '4–32 lowercase letters, numbers, and internal hyphens' });
    expect(body.campaign).not.toHaveProperty('sponsorPublicKey');
    expect(body.campaign).not.toHaveProperty('capNative');
  });

  it('honors a database rate denial before invitation exchange and returns bounded retry guidance', async () => {
    const f = fixture();
    f.store.takeRateLimit.mockRejectedValueOnce(new CampaignError('rate_limited'));
    const result = await f.handlers.exchange(f.post({ token: f.token }));
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('60');
    expect(f.store.takeRateLimit).toHaveBeenCalledExactlyOnceWith([{ scope: 'exchange:global', identity: 'all', limit: 120, windowMs: 60_000 }]);
    expect(f.store.exchangeInvite).not.toHaveBeenCalled();
    expect(JSON.stringify(await result.json()) + f.lines.join('')).not.toContain(f.token);
  });

  it('ignores spoofed IP forwarding unless a trusted ingress header is configured', async () => {
    const f = fixture();
    await f.handlers.exchange(f.post({ token: f.token }, { 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '1.2.3.4' }));
    expect(f.store.takeRateLimit.mock.calls[1]![0][0]!.identity).toBe('local');
    const strict = fixture({ trustedIpHeader: 'x-real-ip' });
    const result = await strict.handlers.exchange(strict.post({ token: strict.token }, { 'x-forwarded-for': '1.2.3.4' }));
    expect(result.status).toBe(503);
    expect(strict.store.exchangeInvite).not.toHaveBeenCalled();
  });

  it.each(['publicCampaign', 'quote', 'reserve', 'attempt'] as const)('stops %s after a global denial before adding IP or capability rate identities', async (operation) => {
    const f = fixture({ trustedIpHeader: 'x-real-ip' });
    f.store.takeRateLimit.mockRejectedValueOnce(new CampaignError('rate_limited'));
    const headers = { 'x-real-ip': '203.0.113.7' };
    const result = operation === 'publicCampaign' ? await f.handlers.publicCampaign(f.get(headers), 'local-pilot')
      : operation === 'attempt' ? await f.handlers.attempt(f.get(headers), f.attempt.id)
        : operation === 'quote' ? await f.handlers.quote(f.post({ name: 'firstbite', wallet: f.context.wallet }, headers))
          : await f.handlers.reserve(f.post({ quoteId: f.attempt.quoteId, idempotencyKey: 'abcdefgh12345678' }, headers));
    expect(result.status).toBe(429);
    expect(f.store.takeRateLimit).toHaveBeenCalledOnce();
    expect(f.store.takeRateLimit.mock.calls[0]![0]).toHaveLength(1);
    expect(f.store.takeRateLimit.mock.calls[0]![0][0]!.scope).toMatch(/:global$/);
    expect(f.store.getSession).not.toHaveBeenCalled();
    expect(f.store.getAttempt).not.toHaveBeenCalled();
    expect(f.store.publicCampaign).not.toHaveBeenCalled();
    expect(f.getRegistry).not.toHaveBeenCalled();
  });

  it.each(['exchange', 'attempt'] as const)('stops %s after an IP denial before adding arbitrary token rate identities', async (operation) => {
    const f = fixture();
    f.store.takeRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new CampaignError('rate_limited'));
    const result = operation === 'exchange' ? await f.handlers.exchange(f.post({ token: f.token })) : await f.handlers.attempt(f.get(), f.attempt.id);
    expect(result.status).toBe(429);
    expect(f.store.takeRateLimit).toHaveBeenCalledTimes(2);
    expect(f.store.takeRateLimit.mock.calls.flatMap(([b]) => b).map((b) => b.scope)).toEqual(
      operation === 'exchange' ? ['exchange:global', 'exchange:ip'] : ['attempt-read:global', 'attempt-read:ip']);
    expect(f.store.exchangeInvite).not.toHaveBeenCalled();
    expect(f.store.getAttempt).not.toHaveBeenCalled();
  });
});
