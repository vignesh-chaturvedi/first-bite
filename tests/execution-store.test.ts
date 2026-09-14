import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { CampaignStore } from '../src/lib/campaigns/store';
import type { RegistryClient } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { buildRecoveryTransaction, coSignRecovery, coSignRegistration, openPayload, sealPayload } from '../src/lib/execution/crypto';
import { ExecutionStore } from '../src/lib/execution/store';
import type { PreflightResult } from '../src/lib/execution/types';
import { sealAttemptKey } from '../src/lib/security/attempt-key';
import { generateToken } from '../src/lib/security/tokens';
import { prepareSponsoredQuote } from '../src/lib/transactions/quote';

const databaseTestUrl = process.env.DATABASE_TEST_URL;
const reservation = 15_000_003_384_720n;
const allowance = 15_000n;
const debit = reservation - allowance;
const wrappingKey = randomBytes(32).toString('base64');
const label = () => `execute${randomBytes(8).toString('hex')}`;

describe.skipIf(!databaseTestUrl)('PostgreSQL execution persistence and accounting', () => {
  const schema = `first_bite_exec_test_${randomBytes(8).toString('hex')}`;
  const migrationsSchema = `${schema}_migrations`;
  let admin: ReturnType<typeof createDatabase> | undefined;
  let connection: ReturnType<typeof createDatabase> | undefined;
  let campaigns: CampaignStore;
  let execution: ExecutionStore;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!databaseTestUrl) throw new Error('DATABASE_TEST_URL is required');
    assertLocalFixtureUrl(databaseTestUrl, 'test');
    const parsed = parseDatabaseUrl(databaseTestUrl);
    if (parsed.pathname !== '/first_bite_test') throw new Error('Integration tests require the dedicated first_bite_test database');
    admin = createDatabase(databaseTestUrl);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    parsed.searchParams.set('options', `-c search_path=${schema}`);
    const scopedUrl = parsed.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema });
    connection = createDatabase(scopedUrl);
    campaigns = new CampaignStore(connection.pool);
    execution = new ExecutionStore(connection.pool);
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

  async function fixture(capNative = reservation * 5n) {
    const sponsor = Keypair.generate(); const user = Keypair.generate(); const payer = Keypair.generate();
    const campaign = await campaigns.createCampaign({ slug: label(), name: 'Execution integration test',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
      maxUsers: 5, capNative, sponsorPublicKey: sponsor.publicKey.toBase58(),
      limits: { maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: allowance, recoveryAllowance: allowance, maxReservation: reservation } });
    await campaigns.setCampaignStatus(campaign.id, 'active');
    const invite = await campaigns.issueInvite({ campaignId: campaign.id, wallet: user.publicKey.toBase58(), expiresAt: new Date(Date.now() + 1_800_000) });
    const session = await campaigns.exchangeInvite(invite.token);
    const id = randomUUID(); const now = Date.now();
    const client: RegistryClient = {
      observe: async ({ label, sponsor, user, attemptPayer }) => ({ label, sponsor, user, attemptPayer,
        feeReceiver: new PublicKey(policy.feeReceiverAddress), registrationPrice: 15_000_000_000_000n,
        domainRent: policy.domainRent, primaryRent: policy.primaryRent, sponsorBalance: reservation * 100n,
        blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 20_000,
        observedSlot: 21_000, blockhashContextSlot: 21_001, observedAtMs: now, genesisHash: policy.genesisHash,
        configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id }),
      getMessageFee: async () => allowance,
    };
    const quote = await prepareSponsoredQuote({ name: label(), sponsor: sponsor.publicKey, user: user.publicKey, attemptPayer: payer.publicKey }, client, session.context.campaign.limits, () => now);
    await campaigns.saveQuote(session.sessionToken, { id, quote, encryptedPayerKey: sealAttemptKey(payer.secretKey, wrappingKey, id, payer.publicKey.toBase58()) });
    await campaigns.reserveAttempt(session.sessionToken, { quoteId: id, idempotencyKey: randomUUID() });
    const tx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64')); tx.partialSign(user);
    const userSignedBase64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const signed = coSignRegistration(quote.unsignedTransactionBase64, userSignedBase64, sponsor.secretKey, payer.secretKey, user.publicKey.toBase58());
    const auth = (preflight: Partial<PreflightResult> = {}) => {
      const operationId = randomUUID();
      return { operationId, messageHash: quote.messageSha256,
        encryptedUserPayload: sealPayload(userSignedBase64, wrappingKey, operationId, 'user'),
        preflight: { checkedAtMs: Date.now(), slot: 21_002, blockHeight: 19_999, fee: allowance, sponsorBalance: reservation * 100n, ...preflight } };
    };
    return { id, sponsor, user, payer, campaign, invite, token: session.sessionToken, session, quote, userSignedBase64, signed, auth };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function authorized(f: Fixture) { return execution.authorize(f.token, f.id, f.auth()); }
  async function signedRegistration(f: Fixture) {
    const op = await authorized(f);
    const lease = (await execution.claimJob(randomUUID(), op.id))!;
    expect(lease).not.toBeNull();
    const encryptedSignedPayload = sealPayload(f.signed.signedBase64, wrappingKey, op.id, 'signed');
    await execution.persistSigned(lease, { encryptedSignedPayload, signature: f.signed.signature, messageHash: f.signed.messageHash });
    return { op, lease, encryptedSignedPayload };
  }
  async function residualRegistration(f: Fixture, residual = 5_000n) {
    const registration = await signedRegistration(f);
    await execution.settle(registration.lease, { success: true, fee: allowance, debit, recovered: 0n, residual, slot: 21_010 });
    return { ...registration, residual };
  }
  function recoveryInput(f: Fixture, amount: bigint, fee = 10_000n) {
    const actors = { sponsor: f.sponsor.publicKey.toBase58(), payer: f.payer.publicKey.toBase58(), amount, blockhash: Keypair.generate().publicKey.toBase58() };
    const tx = buildRecoveryTransaction(actors);
    const signed = coSignRecovery(tx.unsignedBase64, actors, f.sponsor.secretKey, f.payer.secretKey);
    const input = { operationId: randomUUID(), amount, fee, blockhash: actors.blockhash, lastValidBlockHeight: 20_100,
      messageHash: tx.messageHash, messageBase64: tx.messageBase64, checkedAtMs: Date.now() };
    return { input, signed };
  }
  async function signedRecovery(f: Fixture, amount: bigint, fee = 10_000n) {
    const recovery = recoveryInput(f, amount, fee);
    const op = await execution.reserveRecovery(f.id, recovery.input);
    const lease = (await execution.claimJob(randomUUID(), op.id))!;
    await execution.persistSigned(lease, { encryptedSignedPayload: sealPayload(recovery.signed.signedBase64, wrappingKey, op.id, 'signed'),
      signature: recovery.signed.signature, messageHash: recovery.signed.messageHash });
    return { op, lease, ...recovery };
  }
  async function state(f: Fixture) {
    const campaign = await campaigns.inspectCampaign(f.campaign.id);
    const attempt = (await connection!.pool.query('SELECT * FROM attempts WHERE id=$1', [f.id])).rows[0];
    const invite = (await connection!.pool.query('SELECT * FROM invites WHERE id=$1', [f.invite.inviteId])).rows[0];
    const ledger = (await connection!.pool.query('SELECT type,amount_native,event_key,operation_id FROM ledger_entries WHERE attempt_id=$1 ORDER BY created_at,id', [f.id])).rows;
    const operations = (await connection!.pool.query('SELECT * FROM execution_operations WHERE attempt_id=$1 ORDER BY created_at,id', [f.id])).rows;
    const jobs = (await connection!.pool.query('SELECT j.* FROM execution_jobs j JOIN execution_operations o ON o.id=j.operation_id WHERE o.attempt_id=$1', [f.id])).rows;
    const audit = (await connection!.pool.query('SELECT event FROM execution_audit WHERE attempt_id=$1 ORDER BY created_at,id', [f.id])).rows.map((r) => r.event);
    return { campaign, attempt, invite, ledger, operations, jobs, audit };
  }

  it('initializes Phase 3 reservations in the remaining execution budget', async () => {
    const f = await fixture(); const s = await state(f);
    expect(s.attempt.remaining_reservation_native).toBe(reservation.toString());
    expect(s.attempt.actual_cost_native).toBe('0');
    expect(s.attempt.residual_native).toBeNull();
    expect(s.operations).toEqual([]); expect(s.jobs).toEqual([]);
    expect(s.campaign.reservedNative).toBe(reservation.toString());
  });

  it.each(['paused', 'invite-expired', 'invite-revoked', 'session-expired', 'wrong-session', 'attempt-expired'] as const)('blocks new authorization when %s', async (condition) => {
    const f = await fixture(); let token = f.token;
    if (condition === 'paused') await campaigns.setCampaignStatus(f.campaign.id, 'paused');
    if (condition === 'invite-expired') await connection!.pool.query("UPDATE invites SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.invite.inviteId]);
    if (condition === 'invite-revoked') await connection!.pool.query("UPDATE invites SET status='revoked' WHERE id=$1", [f.invite.inviteId]);
    if (condition === 'session-expired') await connection!.pool.query("UPDATE capability_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.session.context.sessionId]);
    if (condition === 'wrong-session') token = generateToken();
    if (condition === 'attempt-expired') await connection!.pool.query("UPDATE attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.id]);
    await expect(execution.authorize(token, f.id, f.auth())).rejects.toBeDefined();
    const s = await state(f); expect(s.operations).toEqual([]); expect(s.jobs).toEqual([]);
    expect(s.campaign.reservedNative).toBe(reservation.toString());
    expect(s.ledger).toHaveLength(1);
  });

  it.each<Partial<PreflightResult>>([{ checkedAtMs: 1 }, { checkedAtMs: Date.now() + 60_000 }, { blockHeight: 20_001 }, { fee: allowance + 1n }, { fee: 0n }, { sponsorBalance: reservation - 1n }])('rejects stale or insufficient preflight observations: %o', async (preflight) => {
    const f = await fixture();
    await expect(execution.authorize(f.token, f.id, f.auth(preflight))).rejects.toBeDefined();
    expect((await state(f)).operations).toEqual([]);
  });

  it('serializes competing authorization into exactly one durable operation and job', async () => {
    const f = await fixture();
    const operations = await Promise.all(Array.from({ length: 8 }, () => execution.authorize(f.token, f.id, f.auth())));
    expect(new Set(operations.map((op) => op.id)).size).toBe(1);
    const s = await state(f); expect(s.operations).toHaveLength(1); expect(s.jobs).toHaveLength(1);
    expect(s.audit).toEqual(['signing_authorized']); expect(s.attempt.status).toBe('signing');
    expect(s.ledger).toHaveLength(1);
    expect(openPayload(s.operations[0].encrypted_user_payload, wrappingKey, operations[0]!.id, 'user')).toBe(f.userSignedBase64);
  });

  it('preserves already-authorized work across a campaign pause', async () => {
    const f = await fixture(); const op = await authorized(f);
    await campaigns.setCampaignStatus(f.campaign.id, 'paused');
    expect((await execution.authorize(f.token, f.id, f.auth())).id).toBe(op.id);
    const lease = (await execution.claimJob(randomUUID(), op.id))!;
    const persisted = await execution.persistSigned(lease, { encryptedSignedPayload: sealPayload(f.signed.signedBase64, wrappingKey, op.id, 'signed'), signature: f.signed.signature, messageHash: f.signed.messageHash });
    expect(persisted.status).toBe('signed');
    expect((await state(f)).campaign.status).toBe('paused');
  });

  it('allows one concurrent lease and fences a worker after lease reclamation', async () => {
    const f = await fixture(); const op = await authorized(f);
    const candidates = await Promise.all(Array.from({ length: 8 }, () => execution.claimJob(randomUUID(), op.id)));
    const acquired = candidates.filter((v) => v !== null); expect(acquired).toHaveLength(1);
    const old = acquired[0]!;
    await connection!.pool.query("UPDATE execution_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    const current = (await execution.claimJob(randomUUID(), op.id))!;
    expect(current.id).toBe(old.id); expect(current.retryCount).toBe(2);
    const payload = { encryptedSignedPayload: sealPayload(f.signed.signedBase64, wrappingKey, op.id, 'signed'), signature: f.signed.signature, messageHash: f.signed.messageHash };
    await expect(execution.persistSigned(old, payload)).rejects.toMatchObject({ code: 'conflict' });
    await execution.persistSigned(current, payload);
    await expect(execution.note(old, 'submitted')).rejects.toMatchObject({ code: 'conflict' });
    await expect(execution.reschedule(old)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('exposes bytes for broadcast only after the exact signed envelope is committed', async () => {
    const f = await fixture(); const op = await authorized(f); const lease = (await execution.claimJob(randomUUID(), op.id))!;
    await expect(execution.broadcastPayload(lease)).rejects.toMatchObject({ code: 'conflict' });
    await expect(execution.note(lease, 'submitted')).rejects.toMatchObject({ code: 'conflict' });
    const encryptedSignedPayload = sealPayload(f.signed.signedBase64, wrappingKey, op.id, 'signed');
    await execution.persistSigned(lease, { encryptedSignedPayload, signature: f.signed.signature, messageHash: f.signed.messageHash });
    const restartedStore = new ExecutionStore(connection!.pool);
    const committed = await restartedStore.broadcastPayload(lease);
    expect(committed.encryptedSignedPayload).toBe(encryptedSignedPayload);
    expect(openPayload(committed.encryptedSignedPayload!, wrappingKey, op.id, 'signed')).toBe(f.signed.signedBase64);
    expect(committed.encryptedUserPayload).toBeNull();
    expect(committed.signature).toBe(f.signed.signature);
    await execution.note(lease, 'confirmed'); await execution.note(lease, 'submitted');
    expect((await execution.getOperation(op.id)).status).toBe('confirmed');
  });

  it('settles successful registration once, releases the unused allowance and removes keys', async () => {
    const f = await fixture(); const p = await signedRegistration(f);
    const settlement = { success: true, fee: allowance, debit, recovered: 0n, residual: 0n, slot: 21_010 };
    await execution.settle(p.lease, settlement);
    const s = await state(f);
    expect(s.campaign).toMatchObject({ reservedNative: '0', spentNative: debit.toString(), reservedUsers: 0, consumedUsers: 1 });
    expect(s.attempt).toMatchObject({ status: 'complete', remaining_reservation_native: '0', actual_cost_native: debit.toString(), encrypted_payer_key: null });
    expect(s.invite).toMatchObject({ status: 'consumed', active_attempt_id: null });
    expect(s.operations[0]).toMatchObject({ status: 'complete', encrypted_signed_payload: null, encrypted_user_payload: null });
    expect(s.jobs).toEqual([]);
    expect(s.ledger).toHaveLength(4);
    expect(Object.fromEntries(s.ledger.map((r) => [r.type, r.amount_native]))).toEqual({
      reserve: reservation.toString(), debit: (debit - allowance).toString(), fee: allowance.toString(), release: allowance.toString(),
    });
    await expect(execution.settle(p.lease, settlement)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state(f)).toEqual(s);
    expect(await execution.status(f.id, f.token)).toMatchObject({ status: 'complete', actualCostNative: debit.toString(), verifiedSlot: 21_010, signature: f.signed.signature });
  });

  it('retains the recovery allowance, payer key and active pointer when registration leaves a residual', async () => {
    const f = await fixture(); await residualRegistration(f);
    const s = await state(f);
    expect(s.campaign).toMatchObject({ reservedNative: allowance.toString(), spentNative: debit.toString(), reservedUsers: 0, consumedUsers: 1 });
    expect(s.attempt).toMatchObject({ status: 'finalized', remaining_reservation_native: allowance.toString(), residual_native: '5000' });
    expect(s.attempt.encrypted_payer_key).not.toBeNull();
    expect(s.invite).toMatchObject({ status: 'consumed', active_attempt_id: f.id });
    expect(await execution.pendingRecoveries()).toContain(f.id);
    expect(await execution.pendingRecoveries()).not.toContain(f.id);
    await connection!.pool.query("UPDATE attempts SET recovery_next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.id]);
    expect(await execution.pendingRecoveries()).toContain(f.id);
    expect(s.operations[0].encrypted_signed_payload).toBeNull();
  });

  it('charges only a verified failed registration fee and frees the invitation', async () => {
    const f = await fixture(); const p = await signedRegistration(f);
    await execution.settle(p.lease, { success: false, fee: allowance, debit: allowance, recovered: 0n, residual: 0n, slot: 21_010 });
    const s = await state(f);
    expect(s.campaign).toMatchObject({ reservedNative: '0', spentNative: allowance.toString(), reservedUsers: 0, consumedUsers: 0 });
    expect(s.attempt).toMatchObject({ status: 'failed', actual_cost_native: allowance.toString(), encrypted_payer_key: null });
    expect(s.invite).toMatchObject({ status: 'active', active_attempt_id: null });
    expect(s.ledger).toHaveLength(3);
    expect(Object.fromEntries(s.ledger.map((r) => [r.type, r.amount_native]))).toEqual({
      reserve: reservation.toString(), fee: allowance.toString(), release: (reservation - allowance).toString(),
    });
  });

  it('keeps all holds and signed evidence during broadcast uncertainty and manual review', async () => {
    const f = await fixture(); const p = await signedRegistration(f);
    await execution.note(p.lease, 'broadcast_unknown');
    expect((await execution.status(f.id, f.token)).status).toBe('broadcast_unknown');
    await execution.manualReview(p.lease);
    const s = await state(f);
    expect(s.campaign).toMatchObject({ reservedNative: reservation.toString(), spentNative: '0', reservedUsers: 1 });
    expect(s.attempt).toMatchObject({ status: 'manual_review', remaining_reservation_native: reservation.toString() });
    expect(s.attempt.encrypted_payer_key).not.toBeNull();
    expect(s.operations[0].encrypted_signed_payload).toBe(p.encryptedSignedPayload);
    expect(s.invite.active_attempt_id).toBe(f.id); expect(s.jobs).toEqual([]); expect(s.ledger).toHaveLength(1);
  });

  it('reserves one recovery and applies its verified refund and fee to net campaign spending', async () => {
    const f = await fixture(); const r = await residualRegistration(f);
    await campaigns.setCampaignStatus(f.campaign.id, 'paused');
    const input = recoveryInput(f, r.residual);
    const ops = await Promise.all(Array.from({ length: 5 }, () => execution.reserveRecovery(f.id, { ...input.input, operationId: randomUUID() })));
    expect(new Set(ops.map((op) => op.id)).size).toBe(1);
    const op = ops[0]!; const lease = (await execution.claimJob(randomUUID(), op.id))!;
    await execution.persistSigned(lease, { encryptedSignedPayload: sealPayload(input.signed.signedBase64, wrappingKey, op.id, 'signed'), signature: input.signed.signature, messageHash: input.signed.messageHash });
    expect((await execution.pendingRecoveries()).includes(f.id)).toBe(false);
    await execution.settle(lease, { success: true, fee: 10_000n, debit: 10_000n, recovered: r.residual, residual: 0n, slot: 21_020 });
    const s = await state(f); const cost = debit + 10_000n - r.residual;
    expect(s.campaign).toMatchObject({ reservedNative: '0', spentNative: cost.toString(), consumedUsers: 1, reservedUsers: 0 });
    expect(s.attempt).toMatchObject({ status: 'complete', actual_cost_native: cost.toString(), residual_native: '0', encrypted_payer_key: null });
    expect(s.invite.active_attempt_id).toBeNull(); expect(s.jobs).toEqual([]);
    const recoveryLedger = s.ledger.filter((v) => v.operation_id === op.id);
    expect(recoveryLedger).toHaveLength(3);
    expect(Object.fromEntries(recoveryLedger.map((v) => [v.type, v.amount_native]))).toEqual({
      fee: '10000', recovery: r.residual.toString(), release: '5000',
    });
  });

  it('retains failed-recovery funds, reserves any additional retry fee before signing and enforces the cap', async () => {
    const f = await fixture(reservation); const r = await residualRegistration(f); const p = await signedRecovery(f, r.residual);
    await execution.settle(p.lease, { success: false, fee: 10_000n, debit: 10_000n, recovered: 0n, residual: r.residual, slot: 21_020 });
    const before = await state(f);
    expect(before.campaign).toMatchObject({ reservedNative: '5000', spentNative: (debit + 10_000n).toString() });
    expect(before.attempt).toMatchObject({ status: 'manual_review', remaining_reservation_native: '5000', residual_native: r.residual.toString() });
    expect(before.attempt.encrypted_payer_key).not.toBeNull(); expect(before.invite.active_attempt_id).toBe(f.id);
    const retry = recoveryInput(f, r.residual, allowance);
    await expect(execution.reserveRecovery(f.id, retry.input)).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect((await state(f)).operations).toHaveLength(2);
    await connection!.pool.query('UPDATE campaigns SET cap_native=cap_native+10000 WHERE id=$1', [f.campaign.id]);
    const op = await execution.reserveRecovery(f.id, retry.input);
    const after = await state(f);
    expect(after.campaign.reservedNative).toBe(allowance.toString());
    expect(after.attempt.remaining_reservation_native).toBe(allowance.toString());
    expect(after.ledger).toContainEqual({ type: 'reserve', amount_native: '10000', event_key: `${op.id}:reserve`, operation_id: op.id });
    expect(op.status).toBe('signing'); expect(op.encryptedSignedPayload).toBeNull();
  });

  it('retry schedules only existing operations and never creates replacement bytes', async () => {
    const f = await fixture(); const p = await signedRegistration(f); await execution.manualReview(p.lease);
    const original = await execution.getOperation(p.op.id);
    await campaigns.setCampaignStatus(f.campaign.id, 'paused');
    await execution.requestRetry(f.id, f.token); await execution.requestRetry(f.id, f.token);
    const s = await state(f);
    expect(s.operations).toHaveLength(1); expect(s.jobs).toHaveLength(1);
    expect(await execution.getOperation(p.op.id)).toEqual(original);
    expect(s.ledger).toHaveLength(1);
    await expect(execution.requestRetry(f.id, generateToken())).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects invalid settlement evidence atomically', async () => {
    const f = await fixture(); const p = await signedRegistration(f); const before = await state(f);
    for (const change of [{ fee: allowance + 1n }, { debit: reservation + 1n }, { recovered: 1n }, { residual: -1n }, { slot: Number.MAX_SAFE_INTEGER + 1 }, { success: false, residual: 1n }]) {
      await expect(execution.settle(p.lease, { success: true, fee: allowance, debit, recovered: 0n, residual: 0n, slot: 21_010, ...change }))
        .rejects.toMatchObject({ code: 'evidence_invalid' });
    }
    expect(await state(f)).toEqual(before);
  });

  it('enforces append-only execution audit and finite accounting even through direct SQL', async () => {
    const f = await fixture(); const op = await authorized(f);
    for (const command of ["UPDATE execution_audit SET event='confirmed' WHERE attempt_id=$1", 'DELETE FROM execution_audit WHERE attempt_id=$1']) {
      await expect(connection!.pool.query(command, [f.id])).rejects.toMatchObject({ code: '55000' });
    }
    await expect(connection!.pool.query('TRUNCATE execution_audit')).rejects.toMatchObject({ code: '55000' });
    for (const column of ['remaining_reservation_native', 'actual_cost_native', 'residual_native']) {
      await expect(connection!.pool.query(`UPDATE attempts SET "${column}"='NaN'::numeric WHERE id=$1`, [f.id])).rejects.toMatchObject({ code: '23514' });
      await expect(connection!.pool.query(`UPDATE attempts SET "${column}"=-1 WHERE id=$1`, [f.id])).rejects.toMatchObject({ code: '23514' });
    }
    for (const column of ['last_valid_block_height', 'fee_cap_native', 'amount_native', 'actual_fee_native', 'actual_debit_native', 'recovered_native']) {
      await expect(connection!.pool.query(`UPDATE execution_operations SET "${column}"='NaN'::numeric WHERE id=$1`, [op.id])).rejects.toMatchObject({ code: '23514' });
      await expect(connection!.pool.query(`UPDATE execution_operations SET "${column}"='Infinity'::numeric WHERE id=$1`, [op.id])).rejects.toMatchObject({ code: '22003' });
    }
    await expect(connection!.pool.query('UPDATE attempts SET verified_slot=9007199254740992 WHERE id=$1', [f.id])).rejects.toMatchObject({ code: '23514' });
    const job = (await state(f)).jobs[0];
    await expect(connection!.pool.query('UPDATE execution_jobs SET lease_owner=$2 WHERE id=$1', [job.id, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(connection!.pool.query('UPDATE execution_jobs SET retry_count=-1 WHERE id=$1', [job.id])).rejects.toMatchObject({ code: '23514' });
    expect((await state(f)).audit).toEqual(['signing_authorized']);
  });
});
