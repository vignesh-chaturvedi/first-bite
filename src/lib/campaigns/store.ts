import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';
import { generateToken, hashToken } from '../security/tokens';
import type { SponsoredQuote } from '../transactions/quote';
import { CampaignError, type AttemptView, type CampaignContext, type CampaignStatus, type CreateCampaign, type RateBucket, type SessionContext } from './types';
import { assertCampaign, assertId, assertWallet, validateStoredQuote } from './validation';

interface CampaignRow {
  id: string; slug: string; name: string; status: CampaignStatus; starts_at: Date; ends_at: Date; max_users: number;
  cap_native: string; reserved_native: string; spent_native: string; reserved_users: number; consumed_users: number;
  sponsor_public_key: string; policy_version: string; max_registration_price_native: string;
  max_transaction_fee_native: string; recovery_allowance_native: string; max_reservation_native: string;
}
interface InviteRow { id: string; campaign_id: string; token_hash: string; expected_wallet: string; status: string; expires_at: Date; active_attempt_id: string | null }
interface SessionRow { id: string; invite_id: string; expires_at: Date; revoked_at: Date | null }
interface QuoteRow { id: string; campaign_id: string; invite_id: string; wallet: string; name: string; payload: SponsoredQuote; encrypted_payer_key: string | null; status: string; expires_at: Date }
interface AttemptRow { id: string; quote_id: string; campaign_id: string; invite_id: string; status: string; name: string; wallet: string; reservation_native: string; message_hash: string; unsigned_transaction_base64: string; expires_at: Date }
function context(c: CampaignRow): CampaignContext {
  return { id: c.id, slug: c.slug, name: c.name, status: c.status, startsAt: c.starts_at, endsAt: c.ends_at,
    maxUsers: c.max_users, capNative: c.cap_native, reservedNative: c.reserved_native, spentNative: c.spent_native,
    reservedUsers: c.reserved_users, consumedUsers: c.consumed_users, sponsorPublicKey: c.sponsor_public_key, policyVersion: c.policy_version,
    limits: { maxRegistrationPrice: BigInt(c.max_registration_price_native), maxTransactionFee: BigInt(c.max_transaction_fee_native),
      recoveryAllowance: BigInt(c.recovery_allowance_native), maxReservation: BigInt(c.max_reservation_native), ttlMs: 45_000 } };
}
function view(a: AttemptRow): AttemptView {
  return { id: a.id, quoteId: a.quote_id, status: a.status, name: a.name, wallet: a.wallet,
    reservationNative: a.reservation_native, messageHash: a.message_hash, unsignedTransactionBase64: a.unsigned_transaction_base64, expiresAt: a.expires_at };
}
function storageError(error: unknown): CampaignError {
  if (error instanceof CampaignError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return new CampaignError('conflict');
  return new CampaignError('storage_unavailable');
}
function tokenHash(value: string, purpose: 'invite' | 'session'): string {
  try { return hashToken(value, purpose); } catch { throw new CampaignError('unauthorized'); }
}
async function dbNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ time: Date }>('SELECT clock_timestamp() AS time');
  return result.rows[0]!.time.getTime();
}
function usableCampaign(c: CampaignRow, now: number): void {
  if (c.status !== 'active' || c.starts_at.getTime() > now || c.ends_at.getTime() <= now || c.policy_version !== COOKIE_REGISTRY_POLICY.id) throw new CampaignError('campaign_unavailable');
}
function usableInvite(i: InviteRow, now: number): void {
  if (i.status !== 'active' || i.expires_at.getTime() <= now) throw new CampaignError('invite_unavailable');
}

/** No RPC or signing inside this store. All accounting mutations use one PostgreSQL transaction. */
export class CampaignStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw storageError(error);
    } finally { client?.release(); }
  }

  private async lockInvite(client: PoolClient, id: string) {
    const initial = (await client.query<InviteRow>('SELECT * FROM invites WHERE id=$1', [id])).rows[0];
    if (!initial) throw new CampaignError('unauthorized');
    // Every campaign mutation uses campaign → invite → session/quote/attempt order.
    const c = (await client.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [initial.campaign_id])).rows[0]!;
    const i = (await client.query<InviteRow>('SELECT * FROM invites WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    return { c, i };
  }

  private async lockSession(client: PoolClient, hash: string, requireActive = true) {
    const initial = (await client.query<SessionRow>('SELECT * FROM capability_sessions WHERE token_hash=$1', [hash])).rows[0];
    if (!initial) throw new CampaignError('unauthorized');
    const { c, i } = await this.lockInvite(client, initial.invite_id);
    const s = (await client.query<SessionRow>('SELECT * FROM capability_sessions WHERE id=$1 FOR UPDATE', [initial.id])).rows[0]!;
    const now = await dbNow(client);
    if (s.revoked_at || s.expires_at.getTime() <= now) throw new CampaignError('unauthorized');
    if (requireActive) { usableCampaign(c, now); usableInvite(i, now); }
    else if (i.status === 'revoked') throw new CampaignError('unauthorized');
    return { c, i, s, now };
  }

  async createCampaign(input: CreateCampaign): Promise<CampaignContext> {
    assertCampaign(input);
    const v = structuredClone(input);
    return this.transaction(async (client) => {
      const r = await client.query<CampaignRow>(`INSERT INTO campaigns
        (id,slug,name,status,starts_at,ends_at,max_users,cap_native,sponsor_public_key,policy_version,
         max_registration_price_native,max_transaction_fee_native,recovery_allowance_native,max_reservation_native)
        VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [randomUUID(), v.slug, v.name, v.startsAt, v.endsAt, v.maxUsers, v.capNative.toString(), v.sponsorPublicKey, COOKIE_REGISTRY_POLICY.id,
        v.limits.maxRegistrationPrice.toString(), v.limits.maxTransactionFee.toString(), v.limits.recoveryAllowance.toString(), v.limits.maxReservation.toString()]);
      return context(r.rows[0]!);
    });
  }

  async setCampaignStatus(id: string, status: 'active' | 'paused' | 'ended'): Promise<void> {
    assertId(id);
    if (!['active', 'paused', 'ended'].includes(status)) throw new CampaignError('invalid_input');
    await this.transaction(async (client) => {
      const c = (await client.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c || c.status === 'ended') throw new CampaignError('campaign_unavailable');
      await client.query('UPDATE campaigns SET status=$2 WHERE id=$1', [id, status]);
    });
  }

  async inspectCampaign(id: string): Promise<CampaignContext> {
    assertId(id);
    return this.transaction(async (client) => {
      const c = (await client.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0];
      if (!c) throw new CampaignError('campaign_unavailable');
      return context(c);
    });
  }

  async publicCampaign(slug: string) {
    if (typeof slug !== 'string' || slug.length > 64) throw new CampaignError('invalid_input');
    return this.transaction(async (client) => {
      const c = (await client.query<CampaignRow>("SELECT * FROM campaigns WHERE slug=$1 AND status <> 'draft'", [slug])).rows[0];
      if (!c) throw new CampaignError('campaign_unavailable');
      return { name: c.name, slug: c.slug, status: c.status, startsAt: c.starts_at, endsAt: c.ends_at, nameRule: '4–32 lowercase letters, numbers, and internal hyphens' };
    });
  }

  async listInvites(campaignId: string) {
    assertId(campaignId);
    return this.transaction(async (client) => {
      const result = await client.query<Pick<InviteRow, 'id' | 'expected_wallet' | 'status' | 'expires_at' | 'active_attempt_id'>>(
        'SELECT id,expected_wallet,status,expires_at,active_attempt_id FROM invites WHERE campaign_id=$1 ORDER BY created_at,id LIMIT 1000', [campaignId]);
      return result.rows.map((i) => ({ id: i.id, wallet: i.expected_wallet, status: i.status, expiresAt: i.expires_at, activeAttemptId: i.active_attempt_id }));
    });
  }

  async issueInvite(input: { campaignId: string; wallet: string; expiresAt: Date }) {
    assertId(input.campaignId); assertWallet(input.wallet);
    const v = structuredClone(input);
    if (!Number.isFinite(v.expiresAt.getTime())) throw new CampaignError('invalid_input');
    const token = generateToken();
    const hash = hashToken(token, 'invite');
    return this.transaction(async (client) => {
      const c = (await client.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [v.campaignId])).rows[0];
      const now = await dbNow(client);
      if (!c || c.status === 'ended' || v.expiresAt.getTime() <= now || v.expiresAt > c.ends_at || v.wallet === c.sponsor_public_key) throw new CampaignError('invite_unavailable');
      const id = randomUUID();
      await client.query("INSERT INTO invites (id,campaign_id,token_hash,expected_wallet,status,expires_at) VALUES ($1,$2,$3,$4,'active',$5)", [id, c.id, hash, v.wallet, v.expiresAt]);
      return { inviteId: id, token };
    });
  }

  async revokeInvite(id: string): Promise<void> {
    assertId(id);
    await this.transaction(async (client) => {
      const { i } = await this.lockInvite(client, id);
      if (i.status === 'consumed') throw new CampaignError('invite_unavailable');
      await client.query("UPDATE invites SET status='revoked' WHERE id=$1", [id]);
      await client.query('UPDATE capability_sessions SET revoked_at=clock_timestamp() WHERE invite_id=$1 AND revoked_at IS NULL', [id]);
      // Reservation release is separate and must still obey the unsigned-only gate.
    });
  }

  /** Recover a lost/revoked capability without creating a second pass for the wallet. */
  async rotateInvite(input: { inviteId: string; expiresAt: Date }) {
    assertId(input.inviteId);
    const v = structuredClone(input);
    if (!Number.isFinite(v.expiresAt.getTime())) throw new CampaignError('invalid_input');
    const token = generateToken();
    return this.transaction(async (client) => {
      const { c, i } = await this.lockInvite(client, v.inviteId);
      const now = await dbNow(client);
      if (c.status === 'ended' || i.status === 'consumed' || i.active_attempt_id || v.expiresAt.getTime() <= now || v.expiresAt > c.ends_at) throw new CampaignError('invite_unavailable');
      await client.query("UPDATE invites SET token_hash=$2,status='active',expires_at=$3 WHERE id=$1", [i.id, hashToken(token, 'invite'), v.expiresAt]);
      await client.query('UPDATE capability_sessions SET revoked_at=clock_timestamp() WHERE invite_id=$1 AND revoked_at IS NULL', [i.id]);
      await client.query("UPDATE quotes SET status='expired',encrypted_payer_key=NULL WHERE invite_id=$1 AND status='quoted'", [i.id]);
      return { inviteId: i.id, token };
    });
  }

  async exchangeInvite(token: string) {
    const hash = tokenHash(token, 'invite');
    const sessionToken = generateToken();
    return this.transaction(async (client) => {
      const initial = (await client.query<InviteRow>('SELECT * FROM invites WHERE token_hash=$1', [hash])).rows[0];
      if (!initial) throw new CampaignError('unauthorized');
      const { c, i } = await this.lockInvite(client, initial.id);
      const now = await dbNow(client);
      // Token rotation may have committed while this request waited for the lock.
      if (i.token_hash !== hash) throw new CampaignError('unauthorized');
      usableCampaign(c, now); usableInvite(i, now);
      const expiresAt = new Date(Math.min(now + 15 * 60_000, i.expires_at.getTime(), c.ends_at.getTime()));
      const sessionId = randomUUID();
      // At most five active sessions: preserve four existing sessions, then add one.
      await client.query(`UPDATE capability_sessions SET revoked_at=clock_timestamp() WHERE id IN
        (SELECT id FROM capability_sessions WHERE invite_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC OFFSET 4)`, [i.id]);
      await client.query('INSERT INTO capability_sessions (id,invite_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)', [sessionId, i.id, hashToken(sessionToken, 'session'), expiresAt]);
      return { sessionToken, expiresAt, context: { sessionId, inviteId: i.id, campaignId: c.id, wallet: i.expected_wallet, campaign: context(c) } satisfies SessionContext };
    });
  }

  async getSession(token: string): Promise<SessionContext> {
    const hash = tokenHash(token, 'session');
    return this.transaction(async (client) => {
      const { c, i, s } = await this.lockSession(client, hash);
      return { sessionId: s.id, inviteId: i.id, campaignId: c.id, wallet: i.expected_wallet, campaign: context(c) };
    });
  }

  async saveQuote(token: string, input: { id: string; quote: SponsoredQuote; encryptedPayerKey: string }) {
    assertId(input.id);
    const hash = tokenHash(token, 'session');
    const v = structuredClone(input);
    if (!/^fbak1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{86}\.[A-Za-z0-9_-]{22}$/.test(v.encryptedPayerKey)) throw new CampaignError('invalid_input');
    return this.transaction(async (client) => {
      const { c, i, now } = await this.lockSession(client, hash);
      validateStoredQuote(v.quote, context(c), i.expected_wallet, now);
      if (i.active_attempt_id) throw new CampaignError('conflict');
      // New quotes supersede only unreserved quotes, never an attempt or its key.
      await client.query("UPDATE quotes SET status='expired',encrypted_payer_key=NULL WHERE invite_id=$1 AND status='quoted'", [i.id]);
      await client.query(`INSERT INTO quotes (id,campaign_id,invite_id,wallet,name,payload,encrypted_payer_key,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'quoted',$8)`, [v.id, c.id, i.id, i.expected_wallet, v.quote.name, v.quote, v.encryptedPayerKey, new Date(v.quote.expiresAtMs)]);
      return { quoteId: v.id, expiresAt: new Date(v.quote.expiresAtMs), cost: v.quote.cost };
    });
  }

  async reserveAttempt(token: string, input: { quoteId: string; idempotencyKey: string }): Promise<AttemptView> {
    assertId(input.quoteId);
    const { quoteId, idempotencyKey } = input;
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) throw new CampaignError('invalid_input');
    const hash = tokenHash(token, 'session');
    return this.transaction(async (client) => {
      const { c, i, now } = await this.lockSession(client, hash);
      const prior = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE invite_id=$1 AND idempotency_key=$2', [i.id, idempotencyKey])).rows[0];
      if (prior) { if (prior.quote_id !== quoteId) throw new CampaignError('conflict'); return view(prior); }
      if (i.active_attempt_id) throw new CampaignError('conflict');
      const q = (await client.query<QuoteRow>('SELECT * FROM quotes WHERE id=$1 AND invite_id=$2 FOR UPDATE', [quoteId, i.id])).rows[0];
      if (!q || q.status !== 'quoted' || !q.encrypted_payer_key || q.expires_at.getTime() <= now || q.wallet !== i.expected_wallet
        || q.name !== q.payload.name || q.expires_at.getTime() !== q.payload.expiresAtMs) throw new CampaignError('quote_unavailable');
      const reservation = validateStoredQuote(q.payload, context(c), i.expected_wallet, now);
      if (BigInt(c.reserved_native) + BigInt(c.spent_native) + reservation > BigInt(c.cap_native)) throw new CampaignError('budget_exhausted');
      if (c.reserved_users + c.consumed_users >= c.max_users) throw new CampaignError('capacity_exhausted');
      const a = (await client.query<AttemptRow>(`INSERT INTO attempts
        (id,quote_id,campaign_id,invite_id,wallet,name,payer_public_key,status,reservation_native,encrypted_payer_key,
        message_hash,unsigned_transaction_base64,blockhash,last_valid_block_height,expires_at,idempotency_key)
        VALUES ($1,$1,$2,$3,$4,$5,$6,'prepared',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [q.id, c.id, i.id, q.wallet, q.name, q.payload.attemptPayer, reservation.toString(), q.encrypted_payer_key, q.payload.messageSha256,
        q.payload.unsignedTransactionBase64, q.payload.blockhash, String(q.payload.lastValidBlockHeight), q.expires_at, idempotencyKey])).rows[0]!;
      await client.query('UPDATE campaigns SET reserved_native=reserved_native+$2::numeric,reserved_users=reserved_users+1 WHERE id=$1', [c.id, reservation.toString()]);
      await client.query('UPDATE invites SET active_attempt_id=$2 WHERE id=$1', [i.id, a.id]);
      await client.query("UPDATE quotes SET status='reserved',encrypted_payer_key=NULL WHERE id=$1", [q.id]);
      await client.query("INSERT INTO ledger_entries (id,campaign_id,attempt_id,event_key,type,amount_native) VALUES ($1,$2,$3,$4,'reserve',$5)", [randomUUID(), c.id, a.id, `reserve:${a.id}`, reservation.toString()]);
      return view(a);
    });
  }

  async getAttempt(token: string, id: string): Promise<AttemptView> {
    assertId(id); const hash = tokenHash(token, 'session');
    return this.transaction(async (client) => {
      const { i } = await this.lockSession(client, hash, false);
      const a = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE id=$1 AND invite_id=$2', [id, i.id])).rows[0];
      if (!a) throw new CampaignError('attempt_unavailable');
      return view(a);
    });
  }

  async expireUnsigned(id: string): Promise<boolean> {
    assertId(id);
    return this.transaction(async (client) => {
      const initial = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE id=$1', [id])).rows[0];
      if (!initial) return false;
      const { c, i } = await this.lockInvite(client, initial.invite_id);
      const a = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      const now = await dbNow(client);
      // Never release signing, signed, broadcast-uncertain, or review holds on a timer.
      if (a.status !== 'prepared' || a.expires_at.getTime() > now) return false;
      if (i.active_attempt_id !== a.id || BigInt(c.reserved_native) < BigInt(a.reservation_native) || c.reserved_users < 1) throw new CampaignError('conflict');
      await client.query("UPDATE attempts SET status='expired',encrypted_payer_key=NULL,updated_at=clock_timestamp() WHERE id=$1", [a.id]);
      await client.query('UPDATE campaigns SET reserved_native=reserved_native-$2::numeric,reserved_users=reserved_users-1 WHERE id=$1', [c.id, a.reservation_native]);
      await client.query('UPDATE invites SET active_attempt_id=NULL WHERE id=$1', [i.id]);
      await client.query("UPDATE quotes SET status='expired',encrypted_payer_key=NULL WHERE id=$1", [a.quote_id]);
      await client.query("INSERT INTO ledger_entries (id,campaign_id,attempt_id,event_key,type,amount_native) VALUES ($1,$2,$3,$4,'release',$5)", [randomUUID(), c.id, a.id, `release:${a.id}`, a.reservation_native]);
      return true;
    });
  }

  /** Operator/worker housekeeping; each attempt release still takes the normal accounting locks. */
  async sweepUnsigned(): Promise<{ attemptsReleased: number; quotesExpired: number }> {
    const ids = await this.transaction(async (client) => (await client.query<{ id: string }>(
      "SELECT id FROM attempts WHERE status='prepared' AND expires_at <= clock_timestamp() ORDER BY expires_at,id LIMIT 500",
    )).rows.map((row) => row.id));
    let attemptsReleased = 0;
    for (const id of ids) if (await this.expireUnsigned(id)) attemptsReleased++;
    const quotesExpired = await this.transaction(async (client) => {
      // Quote-only cleanup acquires no later campaign/invite locks. SKIP LOCKED
      // lets an in-progress reservation finish; its status predicate is rechecked.
      const result = await client.query(`UPDATE quotes SET status='expired',encrypted_payer_key=NULL WHERE id IN
        (SELECT id FROM quotes WHERE status='quoted' AND expires_at <= clock_timestamp()
         ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 500) AND status='quoted'`);
      return result.rowCount ?? 0;
    });
    return { attemptsReleased, quotesExpired };
  }

  async takeRateLimit(buckets: readonly RateBucket[]): Promise<void> {
    if (!buckets.length || buckets.length > 8) throw new CampaignError('invalid_input');
    const rules = buckets.map((b) => {
      if (!/^[a-z0-9:_-]{1,64}$/.test(b.scope) || typeof b.identity !== 'string' || b.identity.length > 256
        || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > 100_000 || !Number.isInteger(b.windowMs) || b.windowMs < 1_000 || b.windowMs > 3_600_000) throw new CampaignError('invalid_input');
      return { ...b, key: createHash('sha256').update(JSON.stringify(['first-bite-rate-v1', b.scope, b.identity])).digest('hex') };
    }).sort((a, b) => a.key.localeCompare(b.key));
    if (new Set(rules.map((r) => r.key)).size !== rules.length) throw new CampaignError('invalid_input');
    const allowed = await this.transaction(async (client) => {
      const now = await dbNow(client); let allow = true;
      for (const r of rules) {
        const start = Math.floor(now / r.windowMs) * r.windowMs;
        const row = (await client.query<{ count: number }>(`INSERT INTO rate_limits (key,window_start,count,expires_at) VALUES ($1,$2,1,$3)
          ON CONFLICT (key,window_start) DO UPDATE SET count=least(rate_limits.count+1,$4) RETURNING count`, [r.key, start, new Date(start + r.windowMs), r.limit + 1])).rows[0]!;
        if (row.count > r.limit) allow = false;
      }
      return allow; // Commit denied counts too; rollback would make a failing bucket free.
    });
    if (!allowed) throw new CampaignError('rate_limited');
  }
}
