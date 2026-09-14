import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';
import { assertId } from '../campaigns/validation';
import { CampaignStore } from '../campaigns/store';
import { hashToken } from '../security/tokens';
import type { SponsoredQuote } from '../transactions/quote';
import { ExecutionError, type ExecutionAttempt, type ExecutionOperation, type JobLease, type PreflightResult, type Settlement } from './types';

type OperationRow = {
  id: string; attempt_id: string; campaign_id: string; kind: 'registration' | 'recovery'; status: ExecutionOperation['status'];
  message_hash: string; message_base64: string; encrypted_user_payload: string | null; encrypted_signed_payload: string | null;
  signature: string | null; blockhash: string; last_valid_block_height: string; fee_cap_native: string; amount_native: string; authorized_at: Date;
};
type AttemptRow = { id: string; campaign_id: string; invite_id: string; wallet: string; name: string; payer_public_key: string; status: string;
  encrypted_payer_key: string | null; remaining_reservation_native: string; actual_cost_native: string; residual_native: string | null;
  expires_at: Date; signature: string | null; verified_slot: string | number | null; message_hash: string; unsigned_transaction_base64: string };
type CampaignRow = { id: string; status: string; starts_at: Date; ends_at: Date; policy_version: string; reserved_native: string; spent_native: string; cap_native: string; recovery_allowance_native: string; sponsor_public_key: string };
type InviteRow = { id: string; status: string; expires_at: Date; active_attempt_id: string | null; expected_wallet: string };
function operation(row: OperationRow): ExecutionOperation {
  return { id: row.id, attemptId: row.attempt_id, campaignId: row.campaign_id, kind: row.kind, status: row.status,
    messageHash: row.message_hash, messageBase64: row.message_base64, encryptedUserPayload: row.encrypted_user_payload,
    encryptedSignedPayload: row.encrypted_signed_payload, signature: row.signature, blockhash: row.blockhash,
    lastValidBlockHeight: Number(row.last_valid_block_height), feeCapNative: row.fee_cap_native, amountNative: row.amount_native, authorizedAt: row.authorized_at };
}
export interface ExecutionStatusView { attemptId: string; status: string; signature: string | null; verifiedSlot: number | null; actualCostNative: string; residualNative: string | null }

/** Internal repository. Capabilities authorize registration; worker mutations require a fenced job lease. */
export class ExecutionStore {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try { client = await this.pool.connect(); await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='2s'");
      const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError('storage_unavailable');
    } finally { client?.release(); }
  }
  private async locked(client: PoolClient, id: string) {
    const initial = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE id=$1', [id])).rows[0];
    if (!initial) throw new ExecutionError('unauthorized');
    const c = (await client.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [initial.campaign_id])).rows[0]!;
    const i = (await client.query<InviteRow>('SELECT * FROM invites WHERE id=$1 FOR UPDATE', [initial.invite_id])).rows[0]!;
    const a = (await client.query<AttemptRow>('SELECT * FROM attempts WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    return { c, i, a };
  }
  private async authenticate(client: PoolClient, token: string, inviteId: string) {
    let hash: string;
    try { hash = hashToken(token, 'session'); } catch { throw new ExecutionError('unauthorized'); }
    const result = await client.query(`SELECT id FROM capability_sessions WHERE token_hash=$1 AND invite_id=$2
      AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [hash, inviteId]);
    if (!result.rowCount) throw new ExecutionError('unauthorized');
  }
  private async audit(client: PoolClient, attemptId: string, operationId: string, event: string) {
    await client.query('INSERT INTO execution_audit (id,attempt_id,operation_id,event) VALUES ($1,$2,$3,$4)', [randomUUID(), attemptId, operationId, event]);
  }
  private async event(client: PoolClient, a: AttemptRow, op: ExecutionOperation, type: string, amount: bigint, suffix: string) {
    if (amount === 0n) return;
    if (amount < 0n) throw new ExecutionError('evidence_invalid');
    await client.query(`INSERT INTO ledger_entries (id,campaign_id,attempt_id,operation_id,tx_signature,event_key,type,amount_native)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), a.campaign_id, a.id, op.id, op.signature, `${op.id}:${suffix}`, type, amount.toString()]);
  }
  private async lease(client: PoolClient, value: JobLease): Promise<void> {
    const result = await client.query(`SELECT id FROM execution_jobs WHERE id=$1 AND operation_id=$2 AND lease_owner=$3
      AND lease_expires_at>clock_timestamp() FOR UPDATE`, [value.id, value.operationId, value.owner]);
    if (!result.rowCount) throw new ExecutionError('conflict');
  }
  async load(id: string, token?: string): Promise<ExecutionAttempt> {
    assertId(id);
    const rows = await this.tx(async (client) => {
      const { a, i } = await this.locked(client, id);
      if (token !== undefined) { await this.authenticate(client, token, i.id); if (i.status === 'revoked') throw new ExecutionError('unauthorized'); }
      const q = (await client.query<{ payload: SponsoredQuote }>('SELECT payload FROM quotes WHERE id=$1', [id])).rows[0]!;
      const op = (await client.query<OperationRow>("SELECT * FROM execution_operations WHERE attempt_id=$1 AND kind='registration'", [id])).rows[0];
      return { a, q, op };
    });
    const campaign = await new CampaignStore(this.pool).inspectCampaign(rows.a.campaign_id);
    return { id, inviteId: rows.a.invite_id, campaignId: rows.a.campaign_id, wallet: rows.a.wallet, name: rows.a.name,
      payerPublicKey: rows.a.payer_public_key, status: rows.a.status, encryptedPayerKey: rows.a.encrypted_payer_key,
      remainingReservationNative: rows.a.remaining_reservation_native, actualCostNative: rows.a.actual_cost_native,
      residualNative: rows.a.residual_native, quote: rows.q.payload, campaign, operation: rows.op ? operation(rows.op) : null };
  }
  async status(id: string, token?: string): Promise<ExecutionStatusView> {
    assertId(id);
    return this.tx(async (client) => {
      const { a, i } = await this.locked(client, id);
      if (token !== undefined) { await this.authenticate(client, token, i.id); if (i.status === 'revoked') throw new ExecutionError('unauthorized'); }
      return { attemptId: a.id, status: a.status, signature: a.signature,
        verifiedSlot: a.verified_slot === null ? null : Number(a.verified_slot), actualCostNative: a.actual_cost_native, residualNative: a.residual_native };
    });
  }
  async inspect(id: string) {
    const status = await this.status(id);
    const operations = await this.tx(async(client)=>(await client.query(`SELECT id,kind,status,signature,fee_cap_native,amount_native,
      actual_fee_native,actual_debit_native,recovered_native,evidence,authorized_at FROM execution_operations WHERE attempt_id=$1 ORDER BY created_at,id`,[id])).rows);
    return { ...status,operations };
  }
  async authorize(token: string, id: string, input: { operationId: string; encryptedUserPayload: string; messageHash: string; preflight: PreflightResult }): Promise<ExecutionOperation> {
    assertId(id); assertId(input.operationId); const v = structuredClone(input);
    if (![v.preflight.checkedAtMs,v.preflight.slot,v.preflight.blockHeight].every((n)=>Number.isSafeInteger(n) && n>=0)
      || typeof v.preflight.fee !== 'bigint' || v.preflight.fee<=0n || typeof v.preflight.sponsorBalance !== 'bigint' || v.preflight.sponsorBalance<0n) throw new ExecutionError('invalid_input');
    return this.tx(async (client) => {
      const { a, c, i } = await this.locked(client, id); await this.authenticate(client, token, i.id);
      const prior = (await client.query<OperationRow>("SELECT * FROM execution_operations WHERE attempt_id=$1 AND kind='registration'", [id])).rows[0];
      if (prior) return operation(prior);
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
      const q = (await client.query<{ payload: SponsoredQuote }>('SELECT payload FROM quotes WHERE id=$1', [id])).rows[0]!.payload;
      if (a.status !== 'prepared' || !a.encrypted_payer_key || i.active_attempt_id !== a.id || i.expected_wallet !== a.wallet
        || c.status !== 'active' || c.starts_at.getTime() > now || c.ends_at.getTime() <= now || i.status !== 'active' || i.expires_at.getTime() <= now
        || c.policy_version !== COOKIE_REGISTRY_POLICY.id || c.policy_version !== q.policyId || c.sponsor_public_key !== q.sponsor) throw new ExecutionError('unavailable');
      if (a.expires_at.getTime() <= now || q.expiresAtMs <= now || v.preflight.checkedAtMs > now + 1_000 || now - v.preflight.checkedAtMs > 5_000
        || v.preflight.blockHeight > q.lastValidBlockHeight) throw new ExecutionError('quote_expired');
      if (a.message_hash !== v.messageHash || q.messageSha256 !== v.messageHash || a.unsigned_transaction_base64 !== q.unsignedTransactionBase64
        || BigInt(a.remaining_reservation_native) !== BigInt(q.cost.maximumReservation) || v.preflight.fee > BigInt(q.cost.transactionFee)
        || v.preflight.fee <= 0n || v.preflight.sponsorBalance < BigInt(a.remaining_reservation_native)) throw new ExecutionError('policy_changed');
      const row = (await client.query<OperationRow>(`INSERT INTO execution_operations
        (id,attempt_id,campaign_id,kind,status,message_hash,message_base64,encrypted_user_payload,blockhash,last_valid_block_height,fee_cap_native,amount_native)
        VALUES ($1,$2,$3,'registration','signing',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [v.operationId, id, c.id, q.messageSha256, q.messageBase64, v.encryptedUserPayload, q.blockhash, q.lastValidBlockHeight.toString(), q.cost.transactionFee, q.cost.maxSponsorDebit])).rows[0]!;
      await client.query("UPDATE attempts SET status='signing',updated_at=clock_timestamp() WHERE id=$1", [id]);
      await client.query('INSERT INTO execution_jobs (id,operation_id) VALUES ($1,$2)', [randomUUID(), row.id]);
      await this.audit(client, id, row.id, 'signing_authorized');
      return operation(row);
    });
  }
  async getOperation(id: string): Promise<ExecutionOperation> {
    assertId(id);
    return this.tx(async (client) => {
      const row = (await client.query<OperationRow>('SELECT * FROM execution_operations WHERE id=$1', [id])).rows[0];
      if (!row) throw new ExecutionError('unavailable'); return operation(row);
    });
  }
  async pendingRecoveries(): Promise<string[]> {
    return this.tx(async (client) => {
      const ids = (await client.query<{ id: string }>(`SELECT a.id FROM attempts a
      WHERE a.status IN ('finalized','manual_review') AND a.residual_native>0 AND a.encrypted_payer_key IS NOT NULL
      AND a.recovery_next_run_at<=clock_timestamp()
      AND EXISTS (SELECT 1 FROM execution_operations r WHERE r.attempt_id=a.id AND r.kind='registration' AND r.status='complete')
      AND NOT EXISTS (SELECT 1 FROM execution_operations r WHERE r.attempt_id=a.id AND r.kind='recovery')
      ORDER BY a.recovery_next_run_at,a.id FOR UPDATE SKIP LOCKED LIMIT 20`)).rows.map((r) => r.id);
      if (ids.length) await client.query("UPDATE attempts SET recovery_next_run_at=clock_timestamp()+interval '60 seconds' WHERE id=ANY($1::uuid[])",[ids]);
      return ids;
    });
  }
  async broadcastPayload(value: JobLease): Promise<ExecutionOperation> {
    return this.withOperation(value, async (_client, _rows, op) => {
      if (!op.encryptedSignedPayload || !op.signature || !['signed','submitted','broadcast_unknown'].includes(op.status)) throw new ExecutionError('conflict');
      return op;
    });
  }
  async claimJob(owner: string, operationId?: string): Promise<JobLease | null> {
    assertId(owner); if (operationId) assertId(operationId);
    return this.tx(async (client) => {
      const row = (await client.query<{ id: string; operation_id: string; retry_count: number }>(`SELECT j.id,j.operation_id,j.retry_count FROM execution_jobs j
        WHERE j.next_run_at<=clock_timestamp() AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp())
        AND ($1::uuid IS NULL OR j.operation_id=$1) ORDER BY j.next_run_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1`, [operationId ?? null])).rows[0];
      if (!row) return null;
      await client.query("UPDATE execution_jobs SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '45 seconds',retry_count=retry_count+1 WHERE id=$1", [row.id, owner]);
      return { id: row.id, operationId: row.operation_id, owner, retryCount: row.retry_count + 1 };
    });
  }
  private async withOperation<T>(value: JobLease, work: (client: PoolClient, rows: Awaited<ReturnType<ExecutionStore['locked']>>, op: ExecutionOperation) => Promise<T>) {
    return this.tx(async (client) => {
      const first = (await client.query<OperationRow>('SELECT * FROM execution_operations WHERE id=$1', [value.operationId])).rows[0];
      if (!first) throw new ExecutionError('unavailable');
      const rows = await this.locked(client, first.attempt_id);
      const op = operation((await client.query<OperationRow>('SELECT * FROM execution_operations WHERE id=$1 FOR UPDATE', [first.id])).rows[0]!);
      await this.lease(client, value); return work(client, rows, op);
    });
  }
  async persistSigned(value: JobLease, input: { encryptedSignedPayload: string; signature: string; messageHash: string }): Promise<ExecutionOperation> {
    const v = { ...input };
    return this.withOperation(value, async (client, { a }, op) => {
      if (op.status !== 'signing' || op.messageHash !== v.messageHash) throw new ExecutionError('conflict');
      await client.query("UPDATE execution_operations SET status='signed',encrypted_signed_payload=$2,signature=$3,encrypted_user_payload=NULL,updated_at=clock_timestamp() WHERE id=$1", [op.id, v.encryptedSignedPayload, v.signature]);
      if (op.kind === 'registration') await client.query("UPDATE attempts SET status='signed',signature=$2,updated_at=clock_timestamp() WHERE id=$1", [a.id, v.signature]);
      await this.audit(client, a.id, op.id, 'payload_persisted');
      return { ...op, status: 'signed', encryptedSignedPayload: v.encryptedSignedPayload, signature: v.signature, encryptedUserPayload: null };
    });
  }
  async note(value: JobLease, state: 'submitted' | 'broadcast_unknown' | 'confirmed'): Promise<void> {
    await this.withOperation(value, async (client, { a }, op) => {
      if (!op.signature || !op.encryptedSignedPayload || !['signed','submitted','broadcast_unknown','confirmed'].includes(op.status)) throw new ExecutionError('conflict');
      if (op.status === 'confirmed' && state !== 'confirmed') return;
      await client.query('UPDATE execution_operations SET status=$2,updated_at=clock_timestamp() WHERE id=$1', [op.id, state]);
      if (op.kind === 'registration') await client.query('UPDATE attempts SET status=$2,updated_at=clock_timestamp() WHERE id=$1', [a.id, state]);
      await this.audit(client, a.id, op.id, state === 'confirmed' ? 'confirmed' : state === 'broadcast_unknown' ? 'broadcast_uncertain' : 'broadcast_attempted');
    });
  }
  async reschedule(value: JobLease, delayMs = 3_000): Promise<void> {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new ExecutionError('invalid_input');
    await this.tx(async (client) => {
      await this.lease(client, value);
      await client.query("UPDATE execution_jobs SET lease_owner=NULL,lease_expires_at=NULL,next_run_at=clock_timestamp()+$2::integer*interval '1 millisecond' WHERE id=$1", [value.id, delayMs]);
    });
  }
  async manualReview(value: JobLease): Promise<void> {
    await this.withOperation(value, async (client, { a }, op) => {
      await client.query("UPDATE execution_operations SET status='manual_review',updated_at=clock_timestamp() WHERE id=$1", [op.id]);
      await client.query("UPDATE attempts SET status='manual_review',error_code='evidence_unresolved',updated_at=clock_timestamp() WHERE id=$1", [a.id]);
      await client.query('DELETE FROM execution_jobs WHERE id=$1', [value.id]);
      await this.audit(client, a.id, op.id, 'manual_review');
    });
  }
  async requestRetry(id: string, token?: string): Promise<void> {
    assertId(id);
    await this.tx(async (client) => {
      const { a, i } = await this.locked(client, id);
      if (token !== undefined) { await this.authenticate(client, token, i.id); if (i.status === 'revoked') throw new ExecutionError('unauthorized'); }
      const ops = (await client.query<OperationRow>("SELECT * FROM execution_operations WHERE attempt_id=$1 AND status NOT IN ('complete','failed','expired','finalized') ORDER BY created_at FOR UPDATE", [a.id])).rows;
      for (const op of ops) {
        // Retry schedules reconciliation of existing bytes, never creates a replacement.
        await client.query(`INSERT INTO execution_jobs (id,operation_id) VALUES ($1,$2)
          ON CONFLICT (operation_id) DO UPDATE SET next_run_at=clock_timestamp()`, [randomUUID(), op.id]);
        await this.audit(client, a.id, op.id, 'retry_requested');
      }
    });
  }
  async settle(value: JobLease, result: Settlement): Promise<void> {
    const v = { ...result };
    for (const amount of [v.fee,v.debit,v.recovered,v.residual]) if (typeof amount !== 'bigint' || amount < 0n) throw new ExecutionError('evidence_invalid');
    if (!Number.isSafeInteger(v.slot) || v.slot < 0) throw new ExecutionError('evidence_invalid');
    await this.withOperation(value, async (client, { a, c, i }, op) => {
      if (!op.signature || !op.encryptedSignedPayload || ['complete','failed','expired','finalized'].includes(op.status)) throw new ExecutionError('conflict');
      if (v.fee > BigInt(op.feeCapNative) || i.active_attempt_id !== a.id) throw new ExecutionError('evidence_invalid');
      const held = BigInt(a.remaining_reservation_native);
      let remaining: bigint; let spentChange: bigint; let status: string;
      if (op.kind === 'registration') {
        if (v.recovered !== 0n || v.debit > BigInt(op.amountNative) || v.debit < v.fee || (!v.success && (v.debit !== v.fee || v.residual !== 0n))) throw new ExecutionError('evidence_invalid');
        remaining = v.success && v.residual > 0n ? BigInt(c.recovery_allowance_native) : 0n;
        spentChange = v.debit; status = v.success ? (remaining > 0n ? 'finalized' : 'complete') : 'failed';
        if (held < spentChange + remaining) throw new ExecutionError('evidence_invalid');
        await this.event(client, a, op, 'debit', v.debit - v.fee, 'debit');
        await this.event(client, a, op, 'fee', v.fee, 'fee');
        await this.event(client, a, op, 'release', held - spentChange - remaining, 'release');
        await client.query(`UPDATE campaigns SET reserved_native=reserved_native-$2::numeric+$3::numeric,spent_native=spent_native+$4::numeric,
          reserved_users=reserved_users-1,consumed_users=consumed_users+$5::integer WHERE id=$1`, [c.id, held.toString(), remaining.toString(), spentChange.toString(), v.success ? 1 : 0]);
        await client.query(`UPDATE invites SET status=CASE WHEN $2 THEN 'consumed' ELSE status END,
          consumed_at=CASE WHEN $2 THEN clock_timestamp() ELSE consumed_at END,active_attempt_id=CASE WHEN $3 THEN active_attempt_id ELSE NULL END WHERE id=$1`, [i.id, v.success, remaining > 0n]);
      } else {
        if (v.success && (v.recovered !== BigInt(op.amountNative) || v.residual !== 0n)) throw new ExecutionError('evidence_invalid');
        if (!v.success && (v.recovered !== 0n || v.residual !== BigInt(op.amountNative))) throw new ExecutionError('evidence_invalid');
        if (held < v.fee) throw new ExecutionError('evidence_invalid');
        remaining = v.success ? 0n : held - v.fee;
        spentChange = v.fee - v.recovered;
        if (BigInt(a.actual_cost_native) + spentChange < 0n) throw new ExecutionError('evidence_invalid');
        status = v.success ? 'complete' : 'manual_review';
        await this.event(client, a, op, 'fee', v.fee, 'fee');
        await this.event(client, a, op, 'recovery', v.recovered, 'recovery');
        await this.event(client, a, op, 'release', held - remaining - v.fee, 'release');
        await client.query('UPDATE campaigns SET reserved_native=reserved_native-$2::numeric+$3::numeric,spent_native=spent_native+$4::numeric WHERE id=$1', [c.id, held.toString(), remaining.toString(), spentChange.toString()]);
        if (v.success) await client.query('UPDATE invites SET active_attempt_id=NULL WHERE id=$1', [i.id]);
      }
      await client.query(`UPDATE execution_operations SET status=$2,actual_fee_native=$3,actual_debit_native=$4,recovered_native=$5,
        evidence=$6,encrypted_signed_payload=NULL,encrypted_user_payload=NULL,updated_at=clock_timestamp() WHERE id=$1`,
      [op.id, v.success ? 'complete' : 'failed', v.fee.toString(), v.debit.toString(), v.recovered.toString(), { slot: v.slot, success: v.success, residual: v.residual.toString() }]);
      await client.query(`UPDATE attempts SET status=$2,remaining_reservation_native=$3,actual_cost_native=actual_cost_native+$4::numeric,
        residual_native=$5,verified_slot=$6,encrypted_payer_key=CASE WHEN $7 THEN NULL ELSE encrypted_payer_key END,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
      [a.id, status, remaining.toString(), spentChange.toString(), v.residual.toString(), v.slot, status === 'complete' || status === 'failed']);
      await client.query('DELETE FROM execution_jobs WHERE id=$1', [value.id]);
      await this.audit(client, a.id, op.id, 'settled');
    });
  }
  async reserveRecovery(id: string, input: { operationId: string; amount: bigint; fee: bigint; blockhash: string; lastValidBlockHeight: number; messageHash: string; messageBase64: string; checkedAtMs: number }): Promise<ExecutionOperation> {
    assertId(id); assertId(input.operationId); const v = { ...input };
    return this.tx(async (client) => {
      const { a, c, i } = await this.locked(client, id);
      const prior = (await client.query<OperationRow>("SELECT * FROM execution_operations WHERE attempt_id=$1 AND kind='recovery' AND status NOT IN ('complete','failed','expired')", [id])).rows[0];
      if (prior) return operation(prior);
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
      if (!['finalized','manual_review'].includes(a.status) || i.status !== 'consumed' || i.active_attempt_id !== a.id || !a.encrypted_payer_key
        || a.residual_native === null || v.amount !== BigInt(a.residual_native) || v.amount <= 0n || v.fee <= 0n || v.fee > BigInt(c.recovery_allowance_native)
        || v.checkedAtMs > now + 1_000 || now - v.checkedAtMs > 5_000) throw new ExecutionError('unavailable');
      const held = BigInt(a.remaining_reservation_native); const extra = v.fee > held ? v.fee - held : 0n;
      if (BigInt(c.reserved_native) + BigInt(c.spent_native) + extra > BigInt(c.cap_native)) throw new ExecutionError('budget_exhausted');
      const op = operation((await client.query<OperationRow>(`INSERT INTO execution_operations
        (id,attempt_id,campaign_id,kind,status,message_hash,message_base64,blockhash,last_valid_block_height,fee_cap_native,amount_native)
        VALUES ($1,$2,$3,'recovery','signing',$4,$5,$6,$7,$8,$9) RETURNING *`, [v.operationId,id,c.id,v.messageHash,v.messageBase64,v.blockhash,String(v.lastValidBlockHeight),v.fee.toString(),v.amount.toString()])).rows[0]!);
      if (extra > 0n) {
        await client.query('UPDATE campaigns SET reserved_native=reserved_native+$2::numeric WHERE id=$1', [c.id,extra.toString()]);
        await client.query('UPDATE attempts SET remaining_reservation_native=remaining_reservation_native+$2::numeric WHERE id=$1', [id,extra.toString()]);
        await this.event(client,a,op,'reserve',extra,'reserve');
      }
      await client.query('INSERT INTO execution_jobs (id,operation_id) VALUES ($1,$2)', [randomUUID(),op.id]);
      await this.audit(client,id,op.id,'recovery_reserved'); return op;
    });
  }
}
