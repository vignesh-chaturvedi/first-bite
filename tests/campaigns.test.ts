import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { CampaignStore } from '../src/lib/campaigns/store';
import type { CampaignContext, CreateCampaign, SessionContext } from '../src/lib/campaigns/types';
import type { RegistryClient } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { openAttemptKey, sealAttemptKey } from '../src/lib/security/attempt-key';
import { generateToken, hashToken } from '../src/lib/security/tokens';
import { prepareSponsoredQuote, type SponsoredQuote } from '../src/lib/transactions/quote';

const databaseTestUrl = process.env.DATABASE_TEST_URL;
const reservation = 15_000_003_384_720n;
const sponsor = Keypair.generate().publicKey;
// Test-only random wrapping key: neither a sponsor nor a funded wallet secret.
const wrappingKey = randomBytes(32).toString('base64');
const uniqueLabel = () => `bite${randomBytes(8).toString('hex')}`;

interface Member {
  wallet: PublicKey;
  token: string;
  inviteId: string;
  sessionToken: string;
  context: SessionContext;
}

describe.skipIf(!databaseTestUrl)('PostgreSQL campaign reservations and capabilities', () => {
  const testSchema = `first_bite_campaign_test_${randomBytes(8).toString('hex')}`;
  const migrationsSchema = `${testSchema}_migrations`;
  let admin: ReturnType<typeof createDatabase> | undefined;
  let connection: ReturnType<typeof createDatabase> | undefined;
  let store: CampaignStore;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!databaseTestUrl) throw new Error('DATABASE_TEST_URL is required');
    assertLocalFixtureUrl(databaseTestUrl, 'test');
    const parsed = parseDatabaseUrl(databaseTestUrl);
    if (parsed.pathname !== '/first_bite_test') throw new Error('Integration tests require the dedicated first_bite_test database');
    admin = createDatabase(databaseTestUrl);
    // These identifiers contain only a fixed prefix and random hexadecimal suffix.
    await admin.pool.query(`CREATE SCHEMA "${testSchema}"`);
    schemaCreated = true;
    parsed.searchParams.set('options', `-c search_path=${testSchema}`);
    const scopedUrl = parsed.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema });
    connection = createDatabase(scopedUrl);
    store = new CampaignStore(connection.pool);
  });

  afterAll(async () => {
    await connection?.pool.end();
    try {
      if (schemaCreated && admin) {
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`);
      }
    } finally { await admin?.pool.end(); }
  });

  async function campaign(overrides: Partial<CreateCampaign> = {}, activate = true): Promise<CampaignContext> {
    const created = await store.createCampaign({
      slug: uniqueLabel(), name: 'First Bite test campaign',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
      maxUsers: 20, capNative: reservation * 20n, sponsorPublicKey: sponsor.toBase58(),
      limits: {
        maxRegistrationPrice: 15_000_000_000_000n,
        maxTransactionFee: 15_000n, recoveryAllowance: 15_000n, maxReservation: reservation,
      }, ...overrides,
    });
    if (activate) {
      await store.setCampaignStatus(created.id, 'active');
      return store.inspectCampaign(created.id);
    }
    return created;
  }

  async function member(c: CampaignContext, wallet = Keypair.generate().publicKey): Promise<Member> {
    const invitation = await store.issueInvite({ campaignId: c.id, wallet: wallet.toBase58(), expiresAt: new Date(Date.now() + 1_800_000) });
    const session = await store.exchangeInvite(invitation.token);
    return { wallet, ...invitation, sessionToken: session.sessionToken, context: session.context };
  }

  async function quoteFor(c: CampaignContext, m: Member, name = uniqueLabel()) {
    const id = randomUUID();
    const payer = Keypair.generate();
    const now = Date.now();
    const client: RegistryClient = {
      observe: async ({ label, sponsor: quoteSponsor, user, attemptPayer }) => ({
        label, sponsor: quoteSponsor, user, attemptPayer,
        feeReceiver: new PublicKey(policy.feeReceiverAddress),
        registrationPrice: 15_000_000_000_000n, domainRent: policy.domainRent, primaryRent: policy.primaryRent,
        sponsorBalance: reservation * 100n, blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 20_000, observedSlot: 21_000, blockhashContextSlot: 21_001,
        observedAtMs: now, genesisHash: policy.genesisHash, configSha256: policy.configSha256,
        programSha256: policy.programSha256, policyId: policy.id,
      }),
      getMessageFee: async () => 15_000n,
    };
    const quote = await prepareSponsoredQuote({ name, sponsor: new PublicKey(c.sponsorPublicKey), user: m.wallet, attemptPayer: payer.publicKey }, client, c.limits, () => now);
    const encryptedPayerKey = sealAttemptKey(payer.secretKey, wrappingKey, id, payer.publicKey.toBase58());
    payer.secretKey.fill(0);
    return { id, quote, encryptedPayerKey };
  }

  async function prepared(c: CampaignContext, m: Member, name = uniqueLabel()) {
    const input = await quoteFor(c, m, name);
    await store.saveQuote(m.sessionToken, input);
    const attempt = await store.reserveAttempt(m.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() });
    return { ...input, attempt };
  }

  async function counts(campaignId: string) {
    const c = await store.inspectCampaign(campaignId);
    const rows = await connection!.pool.query<{ type: string; amount_native: string }>(
      'SELECT type, amount_native FROM ledger_entries WHERE campaign_id = $1 ORDER BY created_at, id', [campaignId],
    );
    return { campaign: c, ledger: rows.rows };
  }

  it('creates an explicitly inactive campaign and retains exact large budgets', async () => {
    const largeCap = 9_007_199_254_740_993n;
    const c = await campaign({ capNative: largeCap }, false);
    expect(c.status).toBe('draft');
    expect(c.capNative).toBe(largeCap.toString());
    expect(c.reservedNative).toBe('0');
    expect(c.spentNative).toBe('0');
    expect(c.policyVersion).toBe(policy.id);
    await store.setCampaignStatus(c.id, 'active');
    await store.setCampaignStatus(c.id, 'ended');
    await expect(store.setCampaignStatus(c.id, 'active')).rejects.toBeDefined();
    expect((await store.inspectCampaign(c.id)).status).toBe('ended');
  });

  it('stores domain-separated token hashes and binds the capability to its invitation wallet', async () => {
    const c = await campaign();
    const m = await member(c);
    const session = await store.getSession(m.sessionToken);
    expect(session).toMatchObject({ inviteId: m.inviteId, campaignId: c.id, wallet: m.wallet.toBase58() });
    const invitation = await connection!.pool.query('SELECT token_hash, expected_wallet FROM invites WHERE id = $1', [m.inviteId]);
    const capability = await connection!.pool.query('SELECT token_hash, expires_at FROM capability_sessions WHERE id = $1', [session.sessionId]);
    expect(invitation.rows[0]).toEqual({ token_hash: hashToken(m.token, 'invite'), expected_wallet: m.wallet.toBase58() });
    expect(capability.rows[0].token_hash).toBe(hashToken(m.sessionToken, 'session'));
    expect(capability.rows[0].expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(capability.rows[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(JSON.stringify([...invitation.rows, ...capability.rows])).not.toContain(m.token);
    expect(JSON.stringify([...invitation.rows, ...capability.rows])).not.toContain(m.sessionToken);
    await expect(store.getSession(m.token)).rejects.toBeDefined();
    await expect(store.exchangeInvite(m.sessionToken)).rejects.toBeDefined();
    await expect(store.getSession(generateToken())).rejects.toBeDefined();
  });

  it('bounds concurrent invitation exchanges to five usable sessions', async () => {
    const c = await campaign(); const m = await member(c);
    const sessions = await Promise.all(Array.from({ length: 8 }, () => store.exchangeInvite(m.token)));
    const stored = await connection!.pool.query<{ id: string; revoked_at: Date | null }>(
      'SELECT id, revoked_at FROM capability_sessions WHERE invite_id = $1', [m.inviteId],
    );
    expect(stored.rows).toHaveLength(9);
    expect(stored.rows.filter((row) => row.revoked_at === null)).toHaveLength(5);
    const results = await Promise.allSettled([m.sessionToken, ...sessions.map((session) => session.sessionToken)].map((token) => store.getSession(token)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
  });

  it('erases a superseded quote key while preserving the current quote for reservation', async () => {
    const c = await campaign(); const m = await member(c);
    const first = await quoteFor(c, m); await store.saveQuote(m.sessionToken, first);
    const replacement = await quoteFor(c, m); await store.saveQuote(m.sessionToken, replacement);
    const rows = await connection!.pool.query('SELECT id, status, encrypted_payer_key FROM quotes WHERE invite_id = $1', [m.inviteId]);
    expect(rows.rows.find((row) => row.id === first.id)).toEqual({ id: first.id, status: 'expired', encrypted_payer_key: null });
    expect(rows.rows.find((row) => row.id === replacement.id)).toEqual({ id: replacement.id, status: 'quoted', encrypted_payer_key: replacement.encryptedPayerKey });
    await expect(store.reserveAttempt(m.sessionToken, { quoteId: first.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'quote_unavailable' });
    const attempt = await store.reserveAttempt(m.sessionToken, { quoteId: replacement.id, idempotencyKey: randomUUID() });
    expect(attempt.id).toBe(replacement.id);
    expect((await counts(c.id)).ledger).toHaveLength(1);
  });

  it.each(['active', 'revoked'])('rotates a %s invitation without creating a second wallet pass', async (status) => {
    const c = await campaign(); const m = await member(c);
    const input = await quoteFor(c, m); await store.saveQuote(m.sessionToken, input);
    const extraSession = await store.exchangeInvite(m.token);
    if (status === 'revoked') await store.revokeInvite(m.inviteId);
    const rotated = await store.rotateInvite({ inviteId: m.inviteId, expiresAt: new Date(Date.now() + 1_800_000) });
    expect(rotated.inviteId).toBe(m.inviteId);
    expect(rotated.token).not.toBe(m.token);
    await expect(store.exchangeInvite(m.token)).rejects.toBeDefined();
    await expect(store.getSession(m.sessionToken)).rejects.toBeDefined();
    await expect(store.getSession(extraSession.sessionToken)).rejects.toBeDefined();
    const newSession = await store.exchangeInvite(rotated.token);
    expect(newSession.context).toMatchObject({ inviteId: m.inviteId, campaignId: c.id, wallet: m.wallet.toBase58() });
    const invitations = await connection!.pool.query('SELECT id, status, token_hash, expected_wallet FROM invites WHERE campaign_id = $1', [c.id]);
    expect(invitations.rows).toEqual([{ id: m.inviteId, status: 'active', token_hash: hashToken(rotated.token, 'invite'), expected_wallet: m.wallet.toBase58() }]);
    const staleQuote = await connection!.pool.query('SELECT status, encrypted_payer_key FROM quotes WHERE id = $1', [input.id]);
    expect(staleQuote.rows[0]).toEqual({ status: 'expired', encrypted_payer_key: null });
    await expect(store.reserveAttempt(newSession.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'quote_unavailable' });
    expect((await counts(c.id)).campaign).toMatchObject({ reservedNative: '0', reservedUsers: 0 });
  });

  it.each(['prepared', 'broadcast_unknown'])('refuses token rotation while a %s attempt holds the invitation', async (status) => {
    const c = await campaign(); const m = await member(c); const p = await prepared(c, m);
    if (status !== 'prepared') await connection!.pool.query('UPDATE attempts SET status = $2 WHERE id = $1', [p.id, status]);
    await expect(store.rotateInvite({ inviteId: m.inviteId, expiresAt: new Date(Date.now() + 1_800_000) })).rejects.toMatchObject({ code: 'invite_unavailable' });
    expect((await store.getSession(m.sessionToken)).inviteId).toBe(m.inviteId);
    const state = await counts(c.id);
    expect(state.campaign).toMatchObject({ reservedNative: reservation.toString(), reservedUsers: 1 });
    expect(state.ledger).toHaveLength(1);
  });

  it('refuses token rotation for a consumed invitation', async () => {
    const c = await campaign(); const m = await member(c);
    await connection!.pool.query("UPDATE invites SET status = 'consumed', consumed_at = clock_timestamp() WHERE id = $1", [m.inviteId]);
    await expect(store.rotateInvite({ inviteId: m.inviteId, expiresAt: new Date(Date.now() + 1_800_000) })).rejects.toMatchObject({ code: 'invite_unavailable' });
    const invitation = await connection!.pool.query('SELECT status, token_hash FROM invites WHERE id = $1', [m.inviteId]);
    expect(invitation.rows[0]).toEqual({ status: 'consumed', token_hash: hashToken(m.token, 'invite') });
  });

  it('reserves only one last campaign budget slot under concurrent requests', async () => {
    const c = await campaign({ capNative: reservation, maxUsers: 2 });
    const members = await Promise.all([member(c), member(c)]);
    const inputs = await Promise.all(members.map((m) => quoteFor(c, m)));
    await Promise.all(inputs.map((input, i) => store.saveQuote(members[i]!.sessionToken, input)));
    const results = await Promise.allSettled(inputs.map((input, i) => store.reserveAttempt(members[i]!.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'budget_exhausted' } });
    const state = await counts(c.id);
    expect(state.campaign).toMatchObject({ reservedNative: reservation.toString(), reservedUsers: 1, consumedUsers: 0 });
    expect(state.ledger).toEqual([{ type: 'reserve', amount_native: reservation.toString() }]);
  });

  it('reserves only one last campaign user slot even with enough funds for both', async () => {
    const c = await campaign({ capNative: reservation * 2n, maxUsers: 1 });
    const members = await Promise.all([member(c), member(c)]);
    const inputs = await Promise.all(members.map((m) => quoteFor(c, m)));
    await Promise.all(inputs.map((input, i) => store.saveQuote(members[i]!.sessionToken, input)));
    const results = await Promise.allSettled(inputs.map((input, i) => store.reserveAttempt(members[i]!.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'capacity_exhausted' } });
    const state = await counts(c.id);
    expect(state.campaign.reservedUsers).toBe(1);
    expect(state.campaign.reservedNative).toBe(reservation.toString());
    expect(state.ledger).toHaveLength(1);
  });

  it('prevents two active attempts for one invitation with different quotes', async () => {
    const c = await campaign(); const m = await member(c);
    const inputs = await Promise.all([quoteFor(c, m), quoteFor(c, m)]);
    await Promise.all(inputs.map((input) => store.saveQuote(m.sessionToken, input)));
    const results = await Promise.allSettled(inputs.map((input) => store.reserveAttempt(m.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(['conflict', 'quote_unavailable']).toContain(rejected?.reason.code);
    const state = await counts(c.id);
    expect(state.campaign.reservedUsers).toBe(1);
    expect(state.ledger).toHaveLength(1);
    await expect(store.issueInvite({ campaignId: c.id, wallet: m.wallet.toBase58(), expiresAt: new Date(Date.now() + 60_000) })).rejects.toBeDefined();
  });

  it('holds a name globally across campaigns and rolls back the losing reservation', async () => {
    const campaigns = await Promise.all([campaign(), campaign()]);
    const members = await Promise.all(campaigns.map((c) => member(c)));
    const name = uniqueLabel();
    const inputs = await Promise.all(campaigns.map((c, i) => quoteFor(c, members[i]!, name)));
    await Promise.all(inputs.map((input, i) => store.saveQuote(members[i]!.sessionToken, input)));
    const results = await Promise.allSettled(inputs.map((input, i) => store.reserveAttempt(members[i]!.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const states = await Promise.all(campaigns.map((c) => counts(c.id)));
    expect(states.reduce((total, state) => total + BigInt(state.campaign.reservedNative), 0n)).toBe(reservation);
    expect(states.reduce((total, state) => total + state.ledger.length, 0)).toBe(1);
    const losingIndex = results.findIndex((r) => r.status === 'rejected');
    expect(states[losingIndex]!.campaign).toMatchObject({ reservedNative: '0', reservedUsers: 0 });
  });

  it('makes concurrent idempotent retries return the same attempt without charging twice', async () => {
    const c = await campaign(); const m = await member(c);
    const input = await quoteFor(c, m); await store.saveQuote(m.sessionToken, input);
    const request = { quoteId: input.id, idempotencyKey: randomUUID() };
    const attempts = await Promise.all(Array.from({ length: 6 }, () => store.reserveAttempt(m.sessionToken, request)));
    expect(new Set(attempts.map((a) => a.id))).toEqual(new Set([input.id]));
    expect(attempts[0]).toMatchObject({ id: input.id, quoteId: input.id, status: 'prepared', reservationNative: reservation.toString() });
    const state = await counts(c.id);
    expect(state.ledger).toEqual([{ type: 'reserve', amount_native: reservation.toString() }]);
    await expect(store.reserveAttempt(m.sessionToken, { ...request, quoteId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.reserveAttempt(m.sessionToken, { ...request, idempotencyKey: randomUUID() })).rejects.toBeDefined();
  });

  it('transfers only encrypted payer material to the reserved attempt and returns unsigned data', async () => {
    const c = await campaign(); const m = await member(c); const p = await prepared(c, m);
    const storedQuote = await connection!.pool.query('SELECT encrypted_payer_key FROM quotes WHERE id = $1', [p.id]);
    const storedAttempt = await connection!.pool.query('SELECT encrypted_payer_key, payer_public_key FROM attempts WHERE id = $1', [p.id]);
    expect(storedQuote.rows[0].encrypted_payer_key).toBeNull();
    expect(storedAttempt.rows[0].encrypted_payer_key).toBe(p.encryptedPayerKey);
    const secret = openAttemptKey(storedAttempt.rows[0].encrypted_payer_key, wrappingKey, p.id, storedAttempt.rows[0].payer_public_key);
    try { expect(Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(p.quote.attemptPayer); }
    finally { secret.fill(0); }
    const view = await store.getAttempt(m.sessionToken, p.id);
    expect(view).toMatchObject({ unsignedTransactionBase64: p.quote.unsignedTransactionBase64, messageHash: p.quote.messageSha256 });
    expect(JSON.stringify(view)).not.toContain(p.encryptedPayerKey);
    expect(JSON.stringify(view)).not.toMatch(/secretKey|encryptedPayerKey/);
  });

  it('releases an expired unsigned attempt exactly once and preserves another reservation', async () => {
    const c = await campaign(); const first = await member(c); const second = await member(c);
    const p1 = await prepared(c, first); const p2 = await prepared(c, second);
    expect(await store.expireUnsigned(p1.id)).toBe(false);
    await connection!.pool.query("UPDATE attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [p1.id]);
    const released = await Promise.all(Array.from({ length: 4 }, () => store.expireUnsigned(p1.id)));
    expect(released.filter(Boolean)).toHaveLength(1);
    const state = await counts(c.id);
    expect(state.campaign).toMatchObject({ reservedNative: reservation.toString(), reservedUsers: 1, spentNative: '0', consumedUsers: 0 });
    expect(state.ledger.filter((entry) => entry.type === 'release')).toEqual([{ type: 'release', amount_native: reservation.toString() }]);
    const expired = await connection!.pool.query('SELECT status, encrypted_payer_key FROM attempts WHERE id = $1', [p1.id]);
    expect(expired.rows[0]).toEqual({ status: 'expired', encrypted_payer_key: null });
    const activeInvites = await connection!.pool.query('SELECT id, active_attempt_id FROM invites WHERE campaign_id = $1', [c.id]);
    expect(activeInvites.rows.find((row) => row.id === first.inviteId).active_attempt_id).toBeNull();
    expect(activeInvites.rows.find((row) => row.id === second.inviteId).active_attempt_id).toBe(p2.id);
    expect((await store.getAttempt(second.sessionToken, p2.id)).status).toBe('prepared');
    // The released name can be reserved by a different campaign; the first user is still unconsumed.
    const otherCampaign = await campaign(); const otherMember = await member(otherCampaign);
    expect((await prepared(otherCampaign, otherMember, p1.quote.name)).attempt.status).toBe('prepared');
  });

  it.each(['signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'manual_review'])(
    'never releases a %s reservation solely because its unsigned lease expired', async (status) => {
      const c = await campaign(); const m = await member(c); const p = await prepared(c, m);
      await connection!.pool.query("UPDATE attempts SET status = $2, expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [p.id, status]);
      expect(await store.expireUnsigned(p.id)).toBe(false);
      const state = await counts(c.id);
      expect(state.campaign).toMatchObject({ reservedNative: reservation.toString(), reservedUsers: 1 });
      expect(state.ledger).toEqual([{ type: 'reserve', amount_native: reservation.toString() }]);
      const retained = await connection!.pool.query('SELECT encrypted_payer_key FROM attempts WHERE id = $1', [p.id]);
      expect(retained.rows[0].encrypted_payer_key).toBe(p.encryptedPayerKey);
    },
  );

  it('sweeps abandoned quote keys and unsigned holds while retaining signed and unexpired work', async () => {
    const c = await campaign();
    const members = await Promise.all(Array.from({ length: 4 }, () => member(c)));
    const abandoned = await quoteFor(c, members[0]!); await store.saveQuote(members[0]!.sessionToken, abandoned);
    const unsigned = await prepared(c, members[1]!);
    const signed = await prepared(c, members[2]!);
    const fresh = await quoteFor(c, members[3]!); await store.saveQuote(members[3]!.sessionToken, fresh);
    await connection!.pool.query("UPDATE quotes SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [abandoned.id]);
    await connection!.pool.query("UPDATE attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [unsigned.id]);
    await connection!.pool.query("UPDATE attempts SET status = 'signed', expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [signed.id]);
    const result = await store.sweepUnsigned();
    expect(result.attemptsReleased).toBeGreaterThanOrEqual(1);
    expect(result.quotesExpired).toBeGreaterThanOrEqual(1);
    const quoteRows = await connection!.pool.query('SELECT id, status, encrypted_payer_key FROM quotes WHERE id = ANY($1::uuid[])', [[abandoned.id, fresh.id]]);
    expect(quoteRows.rows.find((row) => row.id === abandoned.id)).toEqual({ id: abandoned.id, status: 'expired', encrypted_payer_key: null });
    expect(quoteRows.rows.find((row) => row.id === fresh.id)).toEqual({ id: fresh.id, status: 'quoted', encrypted_payer_key: fresh.encryptedPayerKey });
    const attemptRows = await connection!.pool.query('SELECT id, status, encrypted_payer_key FROM attempts WHERE id = ANY($1::uuid[])', [[unsigned.id, signed.id]]);
    expect(attemptRows.rows.find((row) => row.id === unsigned.id)).toEqual({ id: unsigned.id, status: 'expired', encrypted_payer_key: null });
    expect(attemptRows.rows.find((row) => row.id === signed.id)).toEqual({ id: signed.id, status: 'signed', encrypted_payer_key: signed.encryptedPayerKey });
    const state = await counts(c.id);
    expect(state.campaign).toMatchObject({ reservedNative: reservation.toString(), reservedUsers: 1 });
    expect(state.ledger.filter((row) => row.type === 'release')).toHaveLength(1);
    expect(await store.sweepUnsigned()).toEqual({ attemptsReleased: 0, quotesExpired: 0 });
  });

  it('rejects an expired quote without consuming budget or an invitation', async () => {
    const c = await campaign(); const m = await member(c); const input = await quoteFor(c, m);
    await store.saveQuote(m.sessionToken, input);
    await connection!.pool.query("UPDATE quotes SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [input.id]);
    await expect(store.reserveAttempt(m.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })).rejects.toBeDefined();
    const state = await counts(c.id);
    expect(state.campaign).toMatchObject({ reservedNative: '0', reservedUsers: 0 });
    expect(state.ledger).toEqual([]);
  });

  it.each(['paused', 'revoked', 'invite_expired', 'session_expired', 'campaign_expired'])(
    'rechecks %s at reservation time after a quote has been saved', async (condition) => {
      const c = await campaign(); const m = await member(c); const input = await quoteFor(c, m);
      await store.saveQuote(m.sessionToken, input);
      if (condition === 'paused') await store.setCampaignStatus(c.id, 'paused');
      if (condition === 'revoked') await store.revokeInvite(m.inviteId);
      if (condition === 'invite_expired') await connection!.pool.query("UPDATE invites SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [m.inviteId]);
      if (condition === 'session_expired') await connection!.pool.query("UPDATE capability_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [m.context.sessionId]);
      if (condition === 'campaign_expired') await connection!.pool.query("UPDATE campaigns SET ends_at = clock_timestamp() - interval '1 second' WHERE id = $1", [c.id]);
      await expect(store.reserveAttempt(m.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })).rejects.toBeDefined();
      const state = await counts(c.id);
      expect(state.campaign).toMatchObject({ reservedNative: '0', reservedUsers: 0 });
      expect(state.ledger).toEqual([]);
    },
  );

  it('does not let a second invitation read or reserve another wallet’s quote and attempt', async () => {
    const c = await campaign(); const owner = await member(c); const stranger = await member(c);
    const input = await quoteFor(c, owner); await store.saveQuote(owner.sessionToken, input);
    await expect(store.reserveAttempt(stranger.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })).rejects.toBeDefined();
    await expect(store.saveQuote(stranger.sessionToken, { ...input, id: randomUUID() })).rejects.toBeDefined();
    const attempt = await store.reserveAttempt(owner.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() });
    await expect(store.getAttempt(stranger.sessionToken, attempt.id)).rejects.toBeDefined();
    expect((await store.getAttempt(owner.sessionToken, attempt.id)).wallet).toBe(owner.wallet.toBase58());
  });

  it.each(['cost', 'wallet', 'policy', 'message'])(
    'rejects persisted %s tampering before reserving budget', async (field) => {
      const c = await campaign(); const m = await member(c); const input = await quoteFor(c, m);
      await store.saveQuote(m.sessionToken, input);
      const payload = structuredClone(input.quote) as SponsoredQuote;
      const changes = field === 'cost' ? { cost: { ...payload.cost, maximumReservation: '1' } }
        : field === 'wallet' ? { user: Keypair.generate().publicKey.toBase58() }
          : field === 'policy' ? { configSha256: '0'.repeat(64) }
            : { messageSha256: '0'.repeat(64) };
      await connection!.pool.query('UPDATE quotes SET payload = $2::jsonb WHERE id = $1', [input.id, JSON.stringify({ ...payload, ...changes })]);
      await expect(store.reserveAttempt(m.sessionToken, { quoteId: input.id, idempotencyKey: randomUUID() })).rejects.toBeDefined();
      const state = await counts(c.id);
      expect(state.campaign).toMatchObject({ reservedNative: '0', reservedUsers: 0 });
      expect(state.ledger).toEqual([]);
    },
  );

  it('enforces ledger immutability and campaign conservation in the database', async () => {
    const c = await campaign({ capNative: reservation }); const m = await member(c); await prepared(c, m);
    await expect(connection!.pool.query("UPDATE ledger_entries SET amount_native = amount_native + 1 WHERE campaign_id = $1", [c.id])).rejects.toBeDefined();
    await expect(connection!.pool.query('DELETE FROM ledger_entries WHERE campaign_id = $1', [c.id])).rejects.toBeDefined();
    await expect(connection!.pool.query('TRUNCATE ledger_entries')).rejects.toBeDefined();
    await expect(connection!.pool.query('UPDATE campaigns SET reserved_native = cap_native + 1 WHERE id = $1', [c.id])).rejects.toBeDefined();
    await expect(connection!.pool.query('UPDATE campaigns SET reserved_users = max_users + 1 WHERE id = $1', [c.id])).rejects.toBeDefined();
    expect((await counts(c.id)).ledger).toEqual([{ type: 'reserve', amount_native: reservation.toString() }]);
  });

  it('atomically limits concurrent preparations and persists rejected usage in opaque buckets', async () => {
    const identity = `client-${randomUUID()}`;
    const bucket = { scope: 'prepare-ip', identity, limit: 3, windowMs: 3_600_000 };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => store.takeRateLimit([bucket])));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const rejected of results.filter((r) => r.status === 'rejected')) expect(rejected.reason).toMatchObject({ code: 'rate_limited' });
    const rows = await connection!.pool.query('SELECT key, count FROM rate_limits');
    expect(rows.rows.some((row) => row.count > bucket.limit)).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain(identity);
    expect(rows.rows.every((row) => /^[a-f0-9]{64}$/.test(row.key))).toBe(true);
    await expect(store.takeRateLimit([bucket])).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('enforces shared global limits across separate client buckets', async () => {
    const global = { scope: 'prepare-global', identity: randomUUID(), limit: 2, windowMs: 3_600_000 };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.takeRateLimit([
      global, { scope: 'prepare-wallet', identity: randomUUID(), limit: 5, windowMs: 3_600_000 },
    ])));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(6);
    for (const result of results.filter((r) => r.status === 'rejected')) expect(result.reason).toMatchObject({ code: 'rate_limited' });
  });
});
