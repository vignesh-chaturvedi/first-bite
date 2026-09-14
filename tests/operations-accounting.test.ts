import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { CampaignStore } from '../src/lib/campaigns/store';
import { ExecutionStore } from '../src/lib/execution/store';
import { AccountingError, AccountingStore } from '../src/lib/operations/accounting';

describe('accounting report input and storage boundaries', () => {
  it.each([
    { maxRecords: 0 }, { maxRecords: 10_001 }, { maxRecords: 1.5 },
    { agedAfterMs: 999 }, { agedAfterMs: Number.NaN }, { agedAfterMs: 31 * 24 * 60 * 60_000 },
  ])('rejects invalid bounds before opening a database: %j', async (options) => {
    const connect = vi.fn(); const store = new AccountingStore({ connect } as unknown as Pool);
    await expect(store.inspectCampaign(randomUUID(), options)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects invalid campaign identifiers without returning their value', async () => {
    const connect = vi.fn(); const store = new AccountingStore({ connect } as unknown as Pool);
    await expect(store.inspectCampaign('private-invalid-token')).rejects.toThrow('Accounting report unavailable: invalid_input');
    expect(connect).not.toHaveBeenCalled();
  });

  it('sanitizes storage failures and releases a failed read transaction', async () => {
    const query = vi.fn().mockRejectedValue(new Error('postgres://private-user:private-password@database/private'));
    const release = vi.fn();
    const store = new AccountingStore({ connect: async () => ({ query, release }) } as unknown as Pool);
    await expect(store.inspectCampaign(randomUUID())).rejects.toEqual(new AccountingError('storage_unavailable'));
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });
});

const databaseTestUrl = process.env.DATABASE_TEST_URL;
const key = () => Keypair.generate().publicKey.toBase58();
const signature = () => key() + key();
const PRIVATE = 'private-accounting-fixture-sentinel';
const baseReservation = 1_100n;

describe.skipIf(!databaseTestUrl)('PostgreSQL exact accounting snapshots', () => {
  const schema = `first_bite_accounting_test_${randomBytes(8).toString('hex')}`;
  const migrationsSchema = `${schema}_migrations`;
  let admin: ReturnType<typeof createDatabase> | undefined;
  let connection: ReturnType<typeof createDatabase> | undefined;
  let execution: ExecutionStore;
  let accounting: AccountingStore;
  let campaigns: CampaignStore;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!databaseTestUrl) throw new Error('DATABASE_TEST_URL is required');
    assertLocalFixtureUrl(databaseTestUrl, 'test');
    const parsed = parseDatabaseUrl(databaseTestUrl);
    if (parsed.pathname !== '/first_bite_test') throw new Error('Integration tests require the dedicated first_bite_test database');
    admin = createDatabase(databaseTestUrl);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    parsed.searchParams.set('options', `-c search_path=${schema}`);
    const scopedUrl = parsed.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema });
    connection = createDatabase(scopedUrl);
    execution = new ExecutionStore(connection.pool);
    accounting = new AccountingStore(connection.pool);
    campaigns = new CampaignStore(connection.pool);
  });

  afterAll(async () => {
    await connection?.pool.end();
    try {
      if (schemaCreated && admin) {
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`);
      }
    } finally { await admin?.pool.end(); }
  });

  // Database-only prepared records deliberately contain no valid chain message or
  // keys. Actual repository settlement transitions exercise the ledger below.
  async function campaign(reservation = baseReservation, sponsor = key()) {
    const id = randomUUID();
    await connection!.pool.query(`INSERT INTO campaigns (id,slug,name,status,starts_at,ends_at,max_users,cap_native,
      sponsor_public_key,policy_version,max_registration_price_native,max_transaction_fee_native,recovery_allowance_native,max_reservation_native)
      VALUES ($1,$2,'Accounting fixture','active',now()-interval '1 hour',now()+interval '1 day',20,$3,$4,'accounting-fixture',$3,100,100,$5)`,
    [id, `accounting-${id}`, (reservation * 20n).toString(), sponsor, reservation.toString()]);
    return { id, sponsor, reservation };
  }
  type Campaign = Awaited<ReturnType<typeof campaign>>;
  async function attempt(c: Campaign) {
    const id = randomUUID(); const inviteId = randomUUID(); const wallet = key(); const payer = key();
    const name = `acct${randomBytes(8).toString('hex')}`; const tokenHash = randomBytes(32).toString('hex');
    await connection!.pool.query(`INSERT INTO invites (id,campaign_id,token_hash,expected_wallet,status,expires_at)
      VALUES ($1,$2,$3,$4,'active',now()+interval '1 hour')`, [inviteId, c.id, tokenHash, wallet]);
    await connection!.pool.query(`INSERT INTO quotes (id,campaign_id,invite_id,wallet,name,payload,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'reserved',now()+interval '1 minute')`, [id, c.id, inviteId, wallet, name, { private: PRIVATE }]);
    await connection!.pool.query(`INSERT INTO attempts
      (id,quote_id,campaign_id,invite_id,idempotency_key,wallet,name,payer_public_key,status,reservation_native,remaining_reservation_native,
       message_hash,unsigned_transaction_base64,blockhash,last_valid_block_height,expires_at,encrypted_payer_key)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7,'prepared',$8,$8,$9,$4,$7,100,now()+interval '1 minute',$4)`,
    [id, c.id, inviteId, PRIVATE, wallet, name, payer, c.reservation.toString(), 'a'.repeat(64)]);
    await connection!.pool.query('UPDATE invites SET active_attempt_id=$2 WHERE id=$1', [inviteId, id]);
    await connection!.pool.query('UPDATE campaigns SET reserved_native=reserved_native+$2::numeric,reserved_users=reserved_users+1 WHERE id=$1', [c.id, c.reservation.toString()]);
    await connection!.pool.query(`INSERT INTO ledger_entries (id,campaign_id,attempt_id,event_key,type,amount_native)
      VALUES ($1,$2,$3,$4,'reserve',$5)`, [randomUUID(), c.id, id, `${PRIVATE}:${id}`, c.reservation.toString()]);
    return { id, inviteId, campaign: c, wallet, payer, name, tokenHash };
  }
  type Attempt = Awaited<ReturnType<typeof attempt>>;
  async function authorize(a: Attempt) {
    const id = randomUUID();
    await connection!.pool.query(`INSERT INTO execution_operations
      (id,attempt_id,campaign_id,kind,status,message_hash,message_base64,encrypted_user_payload,blockhash,last_valid_block_height,fee_cap_native,amount_native)
      VALUES ($1,$2,$3,'registration','signing',$4,$5,$5,$6,100,100,1000)`,
    [id, a.id, a.campaign.id, 'a'.repeat(64), PRIVATE, a.payer]);
    await connection!.pool.query("UPDATE attempts SET status='signing' WHERE id=$1", [a.id]);
    await connection!.pool.query('INSERT INTO execution_jobs (id,operation_id) VALUES ($1,$2)', [randomUUID(), id]);
    return { id, attempt: a };
  }
  async function signed(a: Attempt) {
    const op = await authorize(a); const lease = (await execution.claimJob(randomUUID(), op.id))!;
    const txSignature = signature();
    await execution.persistSigned(lease, { encryptedSignedPayload: PRIVATE, signature: txSignature, messageHash: 'a'.repeat(64) });
    return { ...op, lease, signature: txSignature };
  }
  async function registered(a: Attempt, residual = 0n) {
    const op = await signed(a);
    await execution.settle(op.lease, { success: true, fee: 10n, debit: 1_000n, recovered: 0n, residual, slot: 500 });
    return op;
  }
  async function recovery(a: Attempt, amount = 500n, fee = 10n) {
    const id = randomUUID();
    await execution.reserveRecovery(a.id, { operationId: id, amount, fee, blockhash: key(), lastValidBlockHeight: 200,
      messageHash: 'b'.repeat(64), messageBase64: PRIVATE, checkedAtMs: Date.now() });
    const lease = (await execution.claimJob(randomUUID(), id))!;
    await execution.persistSigned(lease, { encryptedSignedPayload: PRIVATE, signature: signature(), messageHash: 'b'.repeat(64) });
    return { id, lease };
  }
  async function clean(c: Campaign) {
    const report = await accounting.inspectCampaign(c.id);
    expect(report.findings).toEqual([]); expect(report.consistent).toBe(true);
    return report;
  }

  it('returns an empty complete snapshot and distinguishes a missing campaign', async () => {
    const c = await campaign(); const r = await clean(c);
    expect(r).toMatchObject({ schemaVersion: 1, source: 'database_snapshot', health: { migrated: true, sponsorHeldNative: '0' },
      ledger: { entryCount: 0, heldNative: '0', spentNative: '0', recoveredNative: '0' },
      totals: { attemptCount: 0, invitationCount: 0, reservedUsers: 0, consumedUsers: 0 },
      attempts: [], operations: [], entries: [], alreadyAuthorizedOperations: [] });
    await expect(accounting.inspectCampaign(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('preserves amounts above JavaScript safe integers as exact JSON decimal strings', async () => {
    const amount = 9_007_199_254_740_993n; const c = await campaign(amount); const a = await attempt(c);
    const r = await clean(c); const json = JSON.parse(JSON.stringify(r));
    expect(json.ledger.heldNative).toBe('9007199254740993');
    expect(json.campaign.availableNative).toBe((amount * 19n).toString());
    expect(json.attempts[0]).toMatchObject({ id: a.id, remainingReservationNative: amount.toString(), active: true, pending: false });
    expect(json.health.sponsorHeldNative).toBe(amount.toString());
  });

  it.each(['signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'manual_review'] as const)(
    'keeps %s authorization visible after a pause without releasing any money', async (status) => {
      const c = await campaign(); const a = await attempt(c);
      let op: { id: string };
      if (status === 'signing') op = await authorize(a);
      else {
        const s = await signed(a); op = s;
        if (status === 'manual_review') await execution.manualReview(s.lease);
        else if (status !== 'signed') await execution.note(s.lease, status);
      }
      await campaigns.setCampaignStatus(c.id, 'paused');
      await connection!.pool.query("UPDATE attempts SET created_at=now()-interval '20 minutes' WHERE id=$1", [a.id]);
      await connection!.pool.query("UPDATE execution_operations SET authorized_at=now()-interval '20 minutes' WHERE id=$1", [op.id]);
      const r = await clean(c);
      expect(r.campaign).toMatchObject({ status: 'paused', reservedNative: '1100', spentNative: '0', reservedUsers: 1 });
      expect(r.totals).toMatchObject({ activeAttempts: 1, pendingAttempts: 1, agedAttempts: 1, manualReviewAttempts: status === 'manual_review' ? 1 : 0 });
      expect(r.alreadyAuthorizedOperations).toMatchObject([{ id: op.id, status, pending: true, aged: true }]);
      expect(r.ledger.recoveredNative).toBe('0');
    });

  it('reconciles finalized success, charged failure and unsigned expiry with their exact ledger entries', async () => {
    const c = await campaign();
    const success = await attempt(c); await registered(success);
    const failure = await attempt(c); const op = await signed(failure);
    await execution.settle(op.lease, { success: false, fee: 10n, debit: 10n, recovered: 0n, residual: 0n, slot: 501 });
    const expired = await attempt(c);
    await connection!.pool.query("UPDATE attempts SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    expect(await campaigns.expireUnsigned(expired.id)).toBe(true);
    const r = await clean(c);
    expect(r.campaign).toMatchObject({ reservedNative: '0', spentNative: '1010', reservedUsers: 0, consumedUsers: 1 });
    expect(r.ledger).toMatchObject({ reservedNative: '3300', releasedNative: '2290', debitNative: '990', feeNative: '20', recoveredNative: '0', heldNative: '0', spentNative: '1010' });
    expect(r.totals).toMatchObject({ activeAttempts: 0, pendingAttempts: 0, reservedUsers: 0, consumedUsers: 1 });
    expect(r.attempts.map((a) => a.status).sort()).toEqual(['complete', 'expired', 'failed']);
    expect(r.alreadyAuthorizedOperations).toEqual([]);
  });

  it('retains residual recovery reservations until recovery finalizes and never pre-credits a pending sweep', async () => {
    const c = await campaign(); const a = await attempt(c); await registered(a, 500n);
    const before = await clean(c);
    expect(before.totals).toMatchObject({ residualNative: '500', remainingReservationNative: '100', consumedUsers: 1, reservedUsers: 0 });
    const sweep = await recovery(a); await execution.note(sweep.lease, 'broadcast_unknown');
    const pending = await clean(c);
    expect(pending.ledger).toMatchObject({ spentNative: '1000', heldNative: '100', recoveredNative: '0' });
    expect(pending.alreadyAuthorizedOperations).toMatchObject([{ id: sweep.id, kind: 'recovery', status: 'broadcast_unknown' }]);
    await execution.settle(sweep.lease, { success: true, fee: 10n, debit: 10n, recovered: 500n, residual: 0n, slot: 502 });
    const after = await clean(c);
    expect(after.ledger).toMatchObject({ spentNative: '510', heldNative: '0', recoveredNative: '500', feeNative: '20', releasedNative: '90' });
    expect(after.attempts[0]).toMatchObject({ status: 'complete', actualCostNative: '510', residualNative: '0' });
  });

  it('accounts for a charged recovery failure and additional retry reservation before final recovery', async () => {
    const c = await campaign(); const a = await attempt(c); await registered(a, 500n);
    const failed = await recovery(a, 500n, 80n);
    await execution.settle(failed.lease, { success: false, fee: 80n, debit: 80n, recovered: 0n, residual: 500n, slot: 502 });
    const before = await clean(c);
    expect(before.ledger).toMatchObject({ spentNative: '1080', heldNative: '20', recoveredNative: '0' });
    expect(before.totals.manualReviewAttempts).toBe(1);
    const retry = await recovery(a, 500n, 80n);
    const retrying = await clean(c);
    expect(retrying.ledger).toMatchObject({ reservedNative: '1160', heldNative: '80', recoveredNative: '0' });
    await execution.settle(retry.lease, { success: true, fee: 80n, debit: 80n, recovered: 500n, residual: 0n, slot: 503 });
    const after = await clean(c);
    expect(after.ledger).toMatchObject({ spentNative: '660', heldNative: '0', recoveredNative: '500', feeNative: '170' });
  });

  it('detects campaign counter drift while reconstructing amounts independently', async () => {
    const c = await campaign(); await attempt(c);
    await connection!.pool.query('UPDATE campaigns SET reserved_native=1000,reserved_users=0 WHERE id=$1', [c.id]);
    const r = await accounting.inspectCampaign(c.id);
    expect(r.consistent).toBe(false);
    expect(r.findings).toEqual(expect.arrayContaining([
      { code: 'campaign_ledger_held_mismatch', scope: 'campaign', id: c.id, expected: '1100', actual: '1000' },
      { code: 'campaign_attempt_held_mismatch', scope: 'campaign', id: c.id, expected: '1100', actual: '1000' },
      { code: 'campaign_reserved_users_mismatch', scope: 'campaign', id: c.id, expected: '1', actual: '0' },
    ]));
  });

  it('detects attempt counter tampering even when the campaign and ledger agree', async () => {
    const c = await campaign(); const a = await attempt(c);
    await connection!.pool.query('UPDATE attempts SET remaining_reservation_native=1099,actual_cost_native=1 WHERE id=$1', [a.id]);
    const r = await accounting.inspectCampaign(c.id);
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['attempt_ledger_held_mismatch', 'attempt_ledger_spent_mismatch', 'campaign_attempt_held_mismatch', 'campaign_attempt_spent_mismatch']));
  });

  it('flags an invented refund instead of subtracting it from a pending operation silently', async () => {
    const c = await campaign(); const a = await attempt(c); const op = await signed(a);
    await connection!.pool.query(`INSERT INTO ledger_entries (id,campaign_id,attempt_id,operation_id,event_key,type,amount_native,tx_signature)
      VALUES ($1,$2,$3,$4,$5,'recovery',1,$6)`, [randomUUID(), c.id, a.id, op.id, randomUUID(), op.signature]);
    const r = await accounting.inspectCampaign(c.id);
    expect(r.consistent).toBe(false); expect(r.ledger.spentNative).toBe('-1');
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['ledger_unsettled_operation', 'ledger_unverified_recovery', 'campaign_reconstructed_budget_invalid']));
  });

  it('detects mismatched operation identity, settled amounts and unverified success evidence', async () => {
    const c = await campaign(); const a = await attempt(c); const op = await registered(a);
    await connection!.pool.query('UPDATE execution_operations SET actual_fee_native=11,evidence=$2 WHERE id=$1', [op.id, { slot: PRIVATE, success: true, residual: '0', secret: PRIVATE }]);
    const other = await attempt(c); const otherOp = await signed(other);
    await connection!.pool.query(`INSERT INTO ledger_entries (id,campaign_id,attempt_id,operation_id,event_key,type,amount_native,tx_signature)
      VALUES ($1,$2,$3,$4,$5,'fee',1,$6)`, [randomUUID(), c.id, a.id, otherOp.id, randomUUID(), otherOp.signature]);
    const r = await accounting.inspectCampaign(c.id);
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['operation_finalized_evidence_missing', 'operation_ledger_fee_mismatch', 'ledger_operation_identity_mismatch']));
    expect(r.operations.find((o) => o.id === op.id)?.finalizedEvidence).toBeNull();
    expect(JSON.stringify(r)).not.toContain(PRIVATE);
  });

  it('exports public accounting projections without keys, capability hashes, messages, identities or raw evidence', async () => {
    const c = await campaign(); const a = await attempt(c); const op = await signed(a);
    await connection!.pool.query('UPDATE execution_operations SET evidence=$2 WHERE id=$1', [op.id, { slot: 500, success: true, residual: '0', private: PRIVATE }]);
    const r = await accounting.inspectCampaign(c.id); const json = JSON.stringify(r);
    for (const secret of [PRIVATE, a.wallet, a.payer, a.name, a.tokenHash, 'encrypted', 'message', 'eventKey', 'tokenHash', 'inviteId']) expect(json).not.toContain(secret);
    expect(r.operations[0]?.signature).toBe(op.signature);
    expect(r.campaign.sponsorPublicKey).toBe(c.sponsor);
  });

  it('detects a stale verification slot or erased residual despite otherwise balanced accounting', async () => {
    const c = await campaign(); const a = await attempt(c); await registered(a, 500n);
    await connection!.pool.query('UPDATE attempts SET verified_slot=499,residual_native=0 WHERE id=$1', [a.id]);
    const r = await accounting.inspectCampaign(c.id);
    expect(r.consistent).toBe(false);
    expect(r.findings).toEqual(expect.arrayContaining([
      { code: 'attempt_verified_slot_mismatch', scope: 'attempt', id: a.id, expected: '500', actual: '499' },
      { code: 'attempt_residual_evidence_mismatch', scope: 'attempt', id: a.id, expected: '500', actual: '0' },
    ]));
  });

  it('fails explicitly when any complete report collection exceeds the requested bound', async () => {
    const c = await campaign(); const a = await attempt(c); await registered(a);
    // One attempt and operation fit, but its four ledger entries must not be truncated.
    await expect(accounting.inspectCampaign(c.id, { maxRecords: 1 })).rejects.toMatchObject({ code: 'report_too_large' });
    const r = await accounting.inspectCampaign(c.id, { maxRecords: 4 });
    expect(r.entries).toHaveLength(4); expect(r.ledger.spentNative).toBe('1000');
  });

  it('reads campaign, ledger and readiness inputs from one snapshot during a concurrent atomic settlement', async () => {
    const c = await campaign(); const a = await attempt(c); const op = await signed(a);
    let settled = false;
    const wrapped = { connect: async () => {
      const client = await connection!.pool.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (!settled && sql.includes('FROM campaigns WHERE id=$1')) {
            settled = true;
            await execution.settle(op.lease, { success: true, fee: 10n, debit: 1000n, recovered: 0n, residual: 0n, slot: 504 });
          }
          return result;
        },
        release: () => client.release(),
      } as unknown as PoolClient;
    } } as unknown as Pool;
    const before = await new AccountingStore(wrapped).inspectCampaign(c.id);
    expect(settled).toBe(true); expect(before.consistent).toBe(true);
    expect(before.campaign).toMatchObject({ reservedNative: '1100', spentNative: '0' });
    expect(before.health.sponsorHeldNative).toBe('1100'); expect(before.ledger.spentNative).toBe('0');
    const after = await clean(c);
    expect(after.campaign).toMatchObject({ reservedNative: '0', spentNative: '1000' });
    expect(after.health.sponsorHeldNative).toBe('0');
  });

  it('includes paused same-sponsor holds and accepts only fresh execution-worker heartbeats', async () => {
    const c = await campaign(); await attempt(c);
    const other = await campaign(9_007_199_254_740_993n, c.sponsor); await attempt(other);
    await campaigns.setCampaignStatus(other.id, 'paused');
    const workerId = `execution:${randomUUID()}`;
    await connection!.pool.query('INSERT INTO service_heartbeats (worker_id,last_seen_at,started_at) VALUES ($1,now(),now())', [randomUUID()]);
    const before = await clean(c);
    expect(before.health).toMatchObject({ migrated: true, executionWorkerFresh: false, sponsorHeldNative: '9007199254742093' });
    await connection!.pool.query('INSERT INTO service_heartbeats (worker_id,last_seen_at,started_at) VALUES ($1,now(),now())', [workerId]);
    expect((await clean(c)).health.executionWorkerFresh).toBe(true);
    await connection!.pool.query("UPDATE service_heartbeats SET last_seen_at=now()-interval '31 seconds' WHERE worker_id=$1", [workerId]);
    expect((await clean(c)).health.executionWorkerFresh).toBe(false);
    await connection!.pool.query("UPDATE service_heartbeats SET last_seen_at=now()+interval '6 seconds' WHERE worker_id=$1", [workerId]);
    expect((await clean(c)).health.executionWorkerFresh).toBe(false);
  });
});
