import type { Pool, PoolClient } from 'pg';
import type { AttemptStatus, CampaignStatus, ExecutionKind, ExecutionStatus, LedgerEntryType } from '../../db/schema';

export type AccountingCode = 'invalid_input' | 'not_found' | 'report_too_large' | 'storage_unavailable';
export class AccountingError extends Error {
  constructor(readonly code: AccountingCode) { super(`Accounting report unavailable: ${code}`); this.name = 'AccountingError'; }
}
export interface AccountingOptions { maxRecords?: number; agedAfterMs?: number }
export interface AccountingFinding {
  code: string; scope: 'campaign' | 'attempt' | 'operation' | 'ledger' | 'invite'; id: string;
  expected?: string; actual?: string;
}
export interface AccountingLedgerTotals {
  entryCount: number; reservedNative: string; releasedNative: string; debitNative: string; feeNative: string;
  recoveredNative: string; heldNative: string; spentNative: string;
}
export interface AccountingAttempt {
  id: string; status: AttemptStatus; initialReservationNative: string; remainingReservationNative: string;
  actualCostNative: string; residualNative: string | null; signature: string | null; verifiedSlot: string | null;
  createdAt: string; updatedAt: string; active: boolean; pending: boolean; manualReview: boolean; aged: boolean;
  ageMs: number; registrationSucceeded: boolean; ledger: AccountingLedgerTotals;
}
export interface AccountingOperation {
  id: string; attemptId: string; kind: ExecutionKind; status: ExecutionStatus; signature: string | null;
  authorizedAt: string; updatedAt: string; feeCapNative: string; amountNative: string;
  actualFeeNative: string | null; actualDebitNative: string | null; recoveredNative: string | null;
  finalizedEvidence: { slot: string; success: boolean; residualNative: string } | null;
  pending: boolean; aged: boolean; ageMs: number;
}
export interface AccountingLedgerEntry {
  id: string; attemptId: string; operationId: string | null; type: LedgerEntryType;
  amountNative: string; signature: string | null; createdAt: string;
}
export interface AccountingReport {
  schemaVersion: 1; source: 'database_snapshot'; asOf: string; consistent: boolean;
  limits: Required<AccountingOptions>;
  health: { migrated: boolean; executionWorkerFresh: boolean; sponsorHeldNative: string };
  campaign: {
    id: string; slug: string; status: CampaignStatus; sponsorPublicKey: string; policyVersion: string;
    startsAt: string; endsAt: string; capNative: string; reservedNative: string; spentNative: string;
    availableNative: string; maxUsers: number; reservedUsers: number; consumedUsers: number; availableUsers: number;
    maxReservationNative: string; maxTransactionFeeNative: string; maxRegistrationPriceNative: string; recoveryAllowanceNative: string;
  };
  ledger: AccountingLedgerTotals;
  totals: {
    attemptCount: number; operationCount: number; invitationCount: number; remainingReservationNative: string;
    actualCostNative: string; residualNative: string; reservedUsers: number; consumedUsers: number;
    activeAttempts: number; pendingAttempts: number; manualReviewAttempts: number; residualAttempts: number;
    agedAttempts: number; pendingOperations: number;
  };
  attempts: AccountingAttempt[]; operations: AccountingOperation[]; entries: AccountingLedgerEntry[];
  /** These operations already hold authorization; pausing does not cancel their signatures or reconciliation. */
  alreadyAuthorizedOperations: AccountingOperation[];
  findings: AccountingFinding[];
}

interface CampaignRow {
  id: string; slug: string; status: CampaignStatus; sponsor_public_key: string; policy_version: string;
  starts_at: Date; ends_at: Date; cap_native: string; reserved_native: string; spent_native: string;
  max_users: number; reserved_users: number; consumed_users: number; max_reservation_native: string; max_transaction_fee_native: string;
  max_registration_price_native: string; recovery_allowance_native: string;
}
interface AttemptRow {
  id: string; invite_id: string; status: AttemptStatus; reservation_native: string; remaining_reservation_native: string;
  actual_cost_native: string; residual_native: string | null; signature: string | null; verified_slot: string | null;
  created_at: Date; updated_at: Date;
}
interface OperationRow {
  id: string; attempt_id: string; kind: ExecutionKind; status: ExecutionStatus; signature: string | null;
  authorized_at: Date; updated_at: Date; fee_cap_native: string; amount_native: string;
  actual_fee_native: string | null; actual_debit_native: string | null; recovered_native: string | null;
  evidence_slot: string | null; evidence_success: string | null; evidence_residual: string | null;
}
interface InviteRow { id: string; status: string; active_attempt_id: string | null }
interface EntryRow {
  id: string; attempt_id: string; operation_id: string | null; type: LedgerEntryType;
  amount_native: string; tx_signature: string | null; created_at: Date;
}
type Sums = Record<LedgerEntryType, bigint> & { count: number };
const emptySums = (): Sums => ({ reserve: 0n, release: 0n, debit: 0n, fee: 0n, recovery: 0n, count: 0 });
const terminal = (status: string) => ['complete', 'failed', 'expired'].includes(status);
const native = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,23})$/.test(value)) throw new AccountingError('storage_unavailable');
  return BigInt(value);
};
function totals(s: Sums): AccountingLedgerTotals {
  return { entryCount: s.count, reservedNative: s.reserve.toString(), releasedNative: s.release.toString(),
    debitNative: s.debit.toString(), feeNative: s.fee.toString(), recoveredNative: s.recovery.toString(),
    // A finalized refund reduces spend, never recreates a reservation.
    heldNative: (s.reserve - s.release - s.debit - s.fee).toString(), spentNative: (s.debit + s.fee - s.recovery).toString() };
}
function finalizedEvidence(row: OperationRow): AccountingOperation['finalizedEvidence'] {
  if (row.evidence_slot === null || !/^(0|[1-9][0-9]{0,15})$/.test(row.evidence_slot)
    || BigInt(row.evidence_slot) > BigInt(Number.MAX_SAFE_INTEGER)
    || !['true', 'false'].includes(row.evidence_success ?? '')
    || row.evidence_residual === null || !/^(0|[1-9][0-9]{0,23})$/.test(row.evidence_residual)) return null;
  return { slot: row.evidence_slot, success: row.evidence_success === 'true', residualNative: row.evidence_residual };
}

/** Read-only operator reporting. This reconciles persisted evidence; it makes no fresh chain-balance claim. */
export class AccountingStore {
  constructor(private readonly pool: Pool) {}

  async inspectCampaign(campaignId: string, options: AccountingOptions = {}): Promise<AccountingReport> {
    const maxRecords = options.maxRecords ?? 1_000;
    const agedAfterMs = options.agedAfterMs ?? 15 * 60_000;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(campaignId)
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10_000
      || !Number.isSafeInteger(agedAfterMs) || agedAfterMs < 1_000 || agedAfterMs > 30 * 24 * 60 * 60_000) throw new AccountingError('invalid_input');
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='3s'");
      const asOf = (await client.query<{ now: Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now;
      // Explicit projections deliberately never read signer envelopes, raw evidence, quote messages or capabilities.
      const c = (await client.query<CampaignRow>(`SELECT id,slug,status,sponsor_public_key,policy_version,starts_at,ends_at,
        cap_native,reserved_native,spent_native,max_users,reserved_users,consumed_users,max_reservation_native,max_transaction_fee_native,
        max_registration_price_native,recovery_allowance_native
        FROM campaigns WHERE id=$1`, [campaignId])).rows[0];
      if (!c) throw new AccountingError('not_found');
      const healthRow = (await client.query<{ migrated: boolean; execution_worker_fresh: boolean; sponsor_held_native: string }>(`SELECT
        EXISTS (SELECT 1 FROM app_metadata WHERE key='schema_version' AND value->'version'='3'::jsonb) AS migrated,
        EXISTS (SELECT 1 FROM service_heartbeats WHERE worker_id ~ '^execution:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{64})?$'
          AND last_seen_at >= transaction_timestamp()-interval '30 seconds'
          AND last_seen_at <= transaction_timestamp()+interval '5 seconds') AS execution_worker_fresh,
        (SELECT COALESCE(SUM(reserved_native),0)::text FROM campaigns WHERE sponsor_public_key=$1) AS sponsor_held_native`, [c.sponsor_public_key])).rows[0]!;
      const health = { migrated: healthRow.migrated, executionWorkerFresh: healthRow.execution_worker_fresh,
        sponsorHeldNative: healthRow.sponsor_held_native };
      const bounded = <T>(rows: T[]): T[] => {
        if (rows.length > maxRecords) throw new AccountingError('report_too_large');
        return rows;
      };
      const params = [campaignId, maxRecords + 1];
      const attemptRows = bounded((await client.query<AttemptRow>(`SELECT id,invite_id,status,reservation_native,remaining_reservation_native,
        actual_cost_native,residual_native,signature,verified_slot::text,created_at,updated_at
        FROM attempts WHERE campaign_id=$1 ORDER BY created_at,id LIMIT $2`, params)).rows);
      const operationRows = bounded((await client.query<OperationRow>(`SELECT id,attempt_id,kind,status,signature,authorized_at,updated_at,
        fee_cap_native,amount_native,actual_fee_native,actual_debit_native,recovered_native,
        evidence->>'slot' AS evidence_slot,evidence->>'success' AS evidence_success,evidence->>'residual' AS evidence_residual
        FROM execution_operations WHERE campaign_id=$1 ORDER BY authorized_at,id LIMIT $2`, params)).rows);
      const inviteRows = bounded((await client.query<InviteRow>(`SELECT id,status,active_attempt_id
        FROM invites WHERE campaign_id=$1 ORDER BY created_at,id LIMIT $2`, params)).rows);
      const entryRows = bounded((await client.query<EntryRow>(`SELECT id,attempt_id,operation_id,type,amount_native,tx_signature,created_at
        FROM ledger_entries WHERE campaign_id=$1 ORDER BY created_at,id LIMIT $2`, params)).rows);
      const report = this.report(c, asOf, attemptRows, operationRows, inviteRows, entryRows, { maxRecords, agedAfterMs }, health);
      await client.query('COMMIT');
      return report;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AccountingError) throw error;
      throw new AccountingError('storage_unavailable');
    } finally { client?.release(); }
  }

  private report(c: CampaignRow, asOf: Date, attemptRows: AttemptRow[], operationRows: OperationRow[],
    inviteRows: InviteRow[], entryRows: EntryRow[], limits: Required<AccountingOptions>, health: AccountingReport['health']): AccountingReport {
    const findings: AccountingFinding[] = [];
    const issue = (code: string, scope: AccountingFinding['scope'], id: string, expected?: string, actual?: string) => {
      findings.push({ code, scope, id, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
    };
    const compare = (code: string, scope: AccountingFinding['scope'], id: string, expected: bigint, actual: bigint) => {
      if (expected !== actual) issue(code, scope, id, expected.toString(), actual.toString());
    };
    const attemptMap = new Map(attemptRows.map((a) => [a.id, a]));
    const operationMap = new Map(operationRows.map((op) => [op.id, op]));
    const inviteMap = new Map(inviteRows.map((i) => [i.id, i]));
    const registrationMap = new Map(operationRows.filter((op) => op.kind === 'registration').map((op) => [op.attempt_id, op]));
    const latestSettlement = new Map<string, { slot: bigint; residual: bigint }>();
    for (const op of operationRows) {
      const evidence = finalizedEvidence(op);
      if (['complete', 'failed'].includes(op.status) && evidence) {
        const prior = latestSettlement.get(op.attempt_id);
        if (!prior || BigInt(evidence.slot) >= prior.slot) latestSettlement.set(op.attempt_id,
          { slot: BigInt(evidence.slot), residual: BigInt(evidence.residualNative) });
      }
    }
    const attemptSums = new Map<string, Sums>(); const operationSums = new Map<string, Sums>(); const all = emptySums();
    const initialReservations = new Map<string, { count: number; amount: bigint }>();
    const add = (s: Sums, row: EntryRow) => { s[row.type] += native(row.amount_native); s.count++; };
    for (const row of entryRows) {
      add(all, row);
      const a = attemptSums.get(row.attempt_id) ?? emptySums(); add(a, row); attemptSums.set(row.attempt_id, a);
      if (!attemptMap.has(row.attempt_id)) issue('ledger_attempt_missing', 'ledger', row.id);
      if (row.operation_id) {
        const s = operationSums.get(row.operation_id) ?? emptySums(); add(s, row); operationSums.set(row.operation_id, s);
        const op = operationMap.get(row.operation_id);
        if (!op || op.attempt_id !== row.attempt_id) issue('ledger_operation_identity_mismatch', 'ledger', row.id);
        else {
          // Extra recovery fees are reserved before a signature exists.
          if (row.type !== 'reserve' && row.tx_signature !== op.signature) issue('ledger_operation_signature_mismatch', 'ledger', row.id);
          if (row.type === 'reserve' && op.kind !== 'recovery') issue('ledger_unexpected_operation_reserve', 'ledger', row.id);
          if (row.type !== 'reserve' && !['complete', 'failed'].includes(op.status)) issue('ledger_unsettled_operation', 'ledger', row.id);
          if (row.type === 'recovery' && (op.kind !== 'recovery' || op.status !== 'complete')) issue('ledger_unverified_recovery', 'ledger', row.id);
          if (row.type === 'debit' && op.kind !== 'registration') issue('ledger_unexpected_debit', 'ledger', row.id);
        }
      } else if (row.type === 'reserve') {
        const initial = initialReservations.get(row.attempt_id) ?? { count: 0, amount: 0n };
        initial.count++; initial.amount += native(row.amount_native); initialReservations.set(row.attempt_id, initial);
      } else if (row.type !== 'release' || attemptMap.get(row.attempt_id)?.status !== 'expired') {
        issue('ledger_operation_required', 'ledger', row.id);
      }
    }
    const elapsed = (at: Date) => Math.max(0, asOf.getTime() - at.getTime());
    const operations = operationRows.map((op): AccountingOperation => {
      const settled = ['complete', 'failed'].includes(op.status);
      const s = operationSums.get(op.id) ?? emptySums();
      const evidence = finalizedEvidence(op);
      if (!attemptMap.has(op.attempt_id)) issue('operation_attempt_missing', 'operation', op.id);
      if (settled) {
        if (!op.signature || !evidence || evidence.success !== (op.status === 'complete')) issue('operation_finalized_evidence_missing', 'operation', op.id);
        if (op.actual_fee_native === null || op.actual_debit_native === null || op.recovered_native === null) {
          issue('operation_settlement_amount_missing', 'operation', op.id);
        } else {
          const fee = native(op.actual_fee_native); const debit = native(op.actual_debit_native); const recovered = native(op.recovered_native);
          compare('operation_ledger_fee_mismatch', 'operation', op.id, fee, s.fee);
          compare('operation_ledger_debit_mismatch', 'operation', op.id, op.kind === 'registration' ? debit - fee : 0n, s.debit);
          compare('operation_ledger_recovery_mismatch', 'operation', op.id, recovered, s.recovery);
          if (fee > native(op.fee_cap_native) || debit < fee || (op.kind === 'registration' && debit > native(op.amount_native))) issue('operation_cost_exceeds_policy', 'operation', op.id);
          if ((op.kind === 'registration' && recovered !== 0n) || (op.kind === 'recovery' && debit !== fee)
            || (op.kind === 'recovery' && op.status === 'complete' && recovered !== native(op.amount_native))
            || (op.status === 'failed' && (recovered !== 0n || debit !== fee))) issue('operation_settlement_amount_invalid', 'operation', op.id);
        }
      } else if (op.actual_fee_native !== null || op.actual_debit_native !== null || op.recovered_native !== null) {
        issue('operation_unsettled_amounts', 'operation', op.id);
      }
      const pending = !terminal(op.status); const ageMs = elapsed(op.authorized_at);
      return { id: op.id, attemptId: op.attempt_id, kind: op.kind, status: op.status, signature: op.signature,
        authorizedAt: op.authorized_at.toISOString(), updatedAt: op.updated_at.toISOString(), feeCapNative: op.fee_cap_native,
        amountNative: op.amount_native, actualFeeNative: op.actual_fee_native, actualDebitNative: op.actual_debit_native,
        recoveredNative: op.recovered_native, finalizedEvidence: evidence, pending, aged: pending && ageMs >= limits.agedAfterMs, ageMs };
    });
    let reservedUsers = 0; let consumedUsers = 0; let held = 0n; let spent = 0n; let residual = 0n;
    const attempts = attemptRows.map((a): AccountingAttempt => {
      const s = totals(attemptSums.get(a.id) ?? emptySums());
      const remaining = native(a.remaining_reservation_native); const cost = native(a.actual_cost_native);
      const remainingResidual = a.residual_native === null ? 0n : native(a.residual_native);
      held += remaining; spent += cost; residual += remainingResidual;
      compare('attempt_ledger_held_mismatch', 'attempt', a.id, BigInt(s.heldNative), remaining);
      compare('attempt_ledger_spent_mismatch', 'attempt', a.id, BigInt(s.spentNative), cost);
      if (BigInt(s.heldNative) < 0n || BigInt(s.spentNative) < 0n) issue('attempt_negative_accounting', 'attempt', a.id);
      const initial = initialReservations.get(a.id);
      if (!initial || initial.count !== 1) issue('attempt_initial_reservation_count', 'attempt', a.id, '1', String(initial?.count ?? 0));
      compare('attempt_initial_reservation_mismatch', 'attempt', a.id, native(a.reservation_native), initial?.amount ?? 0n);
      const registration = registrationMap.get(a.id); const registrationSucceeded = registration?.status === 'complete';
      const active = !terminal(a.status); const ageMs = elapsed(a.created_at);
      const pending = active && a.status !== 'prepared';
      if (registrationSucceeded) consumedUsers++;
      else if (active) reservedUsers++;
      const invite = inviteMap.get(a.invite_id);
      if (!invite || (active && invite.active_attempt_id !== a.id) || (!active && invite.active_attempt_id === a.id)) issue('attempt_invite_pointer_mismatch', 'attempt', a.id);
      if (registrationSucceeded && invite?.status !== 'consumed') issue('attempt_consumed_invite_mismatch', 'attempt', a.id);
      if (terminal(a.status) && (remaining !== 0n || remainingResidual !== 0n)) issue('attempt_terminal_funds_unresolved', 'attempt', a.id);
      if (a.status === 'prepared' && registration) issue('attempt_prepared_authorized', 'attempt', a.id);
      if (!['prepared', 'expired'].includes(a.status) && !registration) issue('attempt_registration_missing', 'attempt', a.id);
      if (['complete', 'finalized'].includes(a.status) && !registrationSucceeded) issue('attempt_success_unverified', 'attempt', a.id);
      if (a.status === 'failed' && registration?.status !== 'failed') issue('attempt_failure_unverified', 'attempt', a.id);
      if (registration && registration.signature !== a.signature) issue('attempt_registration_signature_mismatch', 'attempt', a.id);
      const settlement = latestSettlement.get(a.id);
      if (settlement) {
        if (a.verified_slot === null) issue('attempt_verified_slot_missing', 'attempt', a.id);
        else compare('attempt_verified_slot_mismatch', 'attempt', a.id, settlement.slot, native(a.verified_slot));
        if (a.residual_native === null) issue('attempt_residual_evidence_missing', 'attempt', a.id);
        else compare('attempt_residual_evidence_mismatch', 'attempt', a.id, settlement.residual, remainingResidual);
      }
      return { id: a.id, status: a.status, initialReservationNative: a.reservation_native, remainingReservationNative: a.remaining_reservation_native,
        actualCostNative: a.actual_cost_native, residualNative: a.residual_native, signature: a.signature, verifiedSlot: a.verified_slot,
        createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString(), active, pending,
        manualReview: a.status === 'manual_review', aged: active && ageMs >= limits.agedAfterMs, ageMs, registrationSucceeded, ledger: s };
    });
    const ledger = totals(all);
    compare('campaign_ledger_held_mismatch', 'campaign', c.id, BigInt(ledger.heldNative), native(c.reserved_native));
    compare('campaign_ledger_spent_mismatch', 'campaign', c.id, BigInt(ledger.spentNative), native(c.spent_native));
    compare('campaign_attempt_held_mismatch', 'campaign', c.id, held, native(c.reserved_native));
    compare('campaign_attempt_spent_mismatch', 'campaign', c.id, spent, native(c.spent_native));
    compare('campaign_reserved_users_mismatch', 'campaign', c.id, BigInt(reservedUsers), BigInt(c.reserved_users));
    compare('campaign_consumed_users_mismatch', 'campaign', c.id, BigInt(consumedUsers), BigInt(c.consumed_users));
    compare('campaign_consumed_invites_mismatch', 'campaign', c.id, BigInt(consumedUsers), BigInt(inviteRows.filter((i) => i.status === 'consumed').length));
    for (const i of inviteRows) {
      if (i.active_attempt_id) {
        const a = attemptMap.get(i.active_attempt_id);
        if (!a || a.invite_id !== i.id || terminal(a.status)) issue('invite_active_attempt_mismatch', 'invite', i.id);
      }
    }
    if (BigInt(ledger.heldNative) < 0n || BigInt(ledger.spentNative) < 0n
      || BigInt(ledger.heldNative) + BigInt(ledger.spentNative) > native(c.cap_native)) issue('campaign_reconstructed_budget_invalid', 'campaign', c.id);
    if (reservedUsers + consumedUsers > c.max_users) issue('campaign_reconstructed_capacity_invalid', 'campaign', c.id);
    const count = (test: (a: AccountingAttempt) => boolean) => attempts.filter(test).length;
    return { schemaVersion: 1, source: 'database_snapshot', asOf: asOf.toISOString(), consistent: findings.length === 0, limits, health,
      campaign: { id: c.id, slug: c.slug, status: c.status, sponsorPublicKey: c.sponsor_public_key, policyVersion: c.policy_version,
        startsAt: c.starts_at.toISOString(), endsAt: c.ends_at.toISOString(), capNative: c.cap_native, reservedNative: c.reserved_native,
        spentNative: c.spent_native, availableNative: (native(c.cap_native) - native(c.reserved_native) - native(c.spent_native)).toString(),
        maxUsers: c.max_users, reservedUsers: c.reserved_users, consumedUsers: c.consumed_users,
        availableUsers: c.max_users - c.reserved_users - c.consumed_users,
        maxReservationNative: c.max_reservation_native, maxTransactionFeeNative: c.max_transaction_fee_native,
        maxRegistrationPriceNative: c.max_registration_price_native, recoveryAllowanceNative: c.recovery_allowance_native },
      ledger, totals: { attemptCount: attempts.length, operationCount: operations.length, invitationCount: inviteRows.length,
        remainingReservationNative: held.toString(), actualCostNative: spent.toString(), residualNative: residual.toString(),
        reservedUsers, consumedUsers, activeAttempts: count((a) => a.active), pendingAttempts: count((a) => a.pending),
        manualReviewAttempts: count((a) => a.manualReview), residualAttempts: count((a) => BigInt(a.residualNative ?? '0') > 0n),
        agedAttempts: count((a) => a.aged), pendingOperations: operations.filter((op) => op.pending).length },
      attempts, operations, entries: entryRows.map((e) => ({ id: e.id, attemptId: e.attempt_id, operationId: e.operation_id,
        type: e.type, amountNative: e.amount_native, signature: e.tx_signature, createdAt: e.created_at.toISOString() })),
      alreadyAuthorizedOperations: operations.filter((op) => op.pending), findings };
  }
}
