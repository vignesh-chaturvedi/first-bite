import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import type { Pool } from 'pg';
import { createDatabase } from '../../src/db/client';
import { migrateDatabase } from '../../src/db/migrate';
import { CampaignStore } from '../../src/lib/campaigns/store';
import type { RegistryClient } from '../../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../../src/lib/chain/policy';
import { coSignRegistration, openPayload, sealPayload } from '../../src/lib/execution/crypto';
import { ExecutionStore } from '../../src/lib/execution/store';
import { openAttemptKey, sealAttemptKey } from '../../src/lib/security/attempt-key';
import { prepareSponsoredQuote } from '../../src/lib/transactions/quote';

const CONTAINER_LABEL = 'app.first-bite.restore-drill';
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const TABLES = ['app_metadata', 'service_heartbeats', 'campaigns', 'invites', 'capability_sessions',
  'quotes', 'attempts', 'ledger_entries', 'rate_limits', 'execution_operations', 'execution_jobs', 'execution_audit'] as const;
const USER = 'first_bite';
// These are exclusively disposable fixture credentials; .env and production URLs are never read.
const LOCAL_PASSWORD = 'first_bite_local_only';
export class RestoreDrillError extends Error {
  constructor(readonly code: string) { super('Local restore drill failed'); }
}
function requireCheck(value: unknown, code: string): asserts value {
  if (!value) throw new RestoreDrillError(code);
}
export function parseDrillOptions(args: string[], nodeEnv?: string): { container: string; port: number } {
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true,
      options: { container: { type: 'string' }, port: { type: 'string' } } });
    requireCheck(nodeEnv !== 'production' && positionals.length === 0, 'invalid_options');
    requireCheck(values.container && /^first-bite-(?:phase6-postgres|restore-drill-[a-z0-9]{1,20})$/.test(values.container), 'invalid_options');
    requireCheck(values.port && /^[1-9][0-9]{3,4}$/.test(values.port), 'invalid_options');
    const port = Number(values.port);
    requireCheck(port >= 1024 && port <= 65535, 'invalid_options');
    return { container: values.container, port };
  } catch { throw new RestoreDrillError('invalid_options'); }
}
export function parseLocalDockerHost(output: string): string {
  try {
    const host: unknown = JSON.parse(output);
    requireCheck(typeof host === 'string' && /^unix:\/\/\/[^\s\x00]+\.sock$/.test(host), 'docker_not_local');
    return host;
  } catch { throw new RestoreDrillError('docker_not_local'); }
}
export function assertDrillContainer(output: string, port: number): void {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    requireCheck(value.running === true && value.label === 'local-only'
      && typeof value.image === 'string' && /^postgres:17\.11(?:-alpine)?(?:@sha256:[a-f0-9]{64})?$/.test(value.image), 'container_not_disposable');
    const bindings = value.bindings as Array<{ HostIp: string; HostPort: string }>;
    requireCheck(Array.isArray(bindings) && bindings.length === 1
      && bindings[0]?.HostIp === '127.0.0.1' && bindings[0]?.HostPort === String(port), 'container_not_disposable');
  } catch { throw new RestoreDrillError('container_not_disposable'); }
}
export function drillDatabaseName(runId: string, kind: 'source' | 'restore'): string {
  requireCheck(/^[a-f0-9]{24}$/.test(runId) && (kind === 'source' || kind === 'restore'), 'invalid_database');
  return `first_bite_drill_${runId}_${kind}`;
}
export function drillDatabaseUrl(port: number, database: string): string {
  requireCheck(Number.isInteger(port) && port >= 1024 && port <= 65535
    && /^(?:postgres|first_bite_drill_[a-f0-9]{24}_(?:source|restore))$/.test(database), 'invalid_database');
  return `postgresql://${USER}:${LOCAL_PASSWORD}@127.0.0.1:${port}/${database}`;
}
export function fingerprintRows(rows: string[]): { count: number; sha256: string } {
  return { count: rows.length, sha256: createHash('sha256').update(JSON.stringify([...rows].sort())).digest('hex') };
}

/** No shell, inherited Docker overrides, PG credentials, stderr, or payload output. */
async function docker(args: string[], options: { stdin?: number; stdout?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
      stdio: [options.stdin ?? 'ignore', options.stdout ?? 'pipe', 'ignore'],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let output = ''; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.byteLength > 64 * 1024) { exceeded = true; child.kill('SIGKILL'); }
      else output += chunk.toString('utf8');
    });
    child.once('error', () => { clearTimeout(timer); reject(new RestoreDrillError('docker_command_failed')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || exceeded || timedOut) reject(new RestoreDrillError(timedOut ? 'docker_command_timeout' : 'docker_command_failed'));
      else accept(output.trim());
    });
  });
}

// These observations deliberately never instantiate a Connection or call an RPC.
async function seedFixture(pool: Pool, wrappingKey: string, settled = false) {
  const campaigns = new CampaignStore(pool); const execution = new ExecutionStore(pool);
  const sponsor = Keypair.generate(); const user = Keypair.generate(); const payer = Keypair.generate();
  const id = randomUUID(); const operationId = randomUUID(); const now = Date.now();
  const allowance = 15_000n; const reservation = 15_000_003_384_720n;
  const campaign = await campaigns.createCampaign({ slug: `restore-${randomBytes(8).toString('hex')}`,
    name: 'Local backup restore fixture', startsAt: new Date(now - 60_000), endsAt: new Date(now + 3_600_000),
    maxUsers: 5, capNative: reservation * 5n, sponsorPublicKey: sponsor.publicKey.toBase58(),
    limits: { maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: allowance,
      recoveryAllowance: allowance, maxReservation: reservation } });
  await campaigns.setCampaignStatus(campaign.id, 'active');
  const invite = await campaigns.issueInvite({ campaignId: campaign.id, wallet: user.publicKey.toBase58(), expiresAt: new Date(now + 1_800_000) });
  const session = await campaigns.exchangeInvite(invite.token);
  const client: RegistryClient = {
    observe: async ({ label, sponsor, user, attemptPayer }) => ({ label, sponsor, user, attemptPayer,
      feeReceiver: new PublicKey(policy.feeReceiverAddress), registrationPrice: 15_000_000_000_000n,
      domainRent: policy.domainRent, primaryRent: policy.primaryRent, sponsorBalance: reservation * 100n, userBalance: 0n,
      blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 20_000,
      observedSlot: 21_000, blockhashContextSlot: 21_001, observedAtMs: now, genesisHash: policy.genesisHash,
      configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id }),
    getMessageFee: async () => allowance,
  };
  try {
    const quote = await prepareSponsoredQuote({ name: `restore${randomBytes(8).toString('hex')}`, sponsor: sponsor.publicKey,
      user: user.publicKey, attemptPayer: payer.publicKey }, client, session.context.campaign.limits, () => now);
    const encryptedPayerKey = sealAttemptKey(payer.secretKey, wrappingKey, id, payer.publicKey.toBase58());
    await campaigns.saveQuote(session.sessionToken, { id, quote, encryptedPayerKey });
    await campaigns.reserveAttempt(session.sessionToken, { quoteId: id, idempotencyKey: randomUUID() });
    const tx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64')); tx.partialSign(user);
    const userSigned = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const signed = coSignRegistration(quote.unsignedTransactionBase64, userSigned, sponsor.secretKey, payer.secretKey, user.publicKey.toBase58());
    await execution.authorize(session.sessionToken, id, { operationId, messageHash: quote.messageSha256,
      encryptedUserPayload: sealPayload(userSigned, wrappingKey, operationId, 'user'),
      preflight: { checkedAtMs: Date.now(), slot: 21_002, blockHeight: 19_999, fee: allowance, sponsorBalance: reservation * 100n } });
    const lease = await execution.claimJob(randomUUID(), operationId);
    requireCheck(lease, 'fixture_failed');
    const encryptedSignedPayload = sealPayload(signed.signedBase64, wrappingKey, operationId, 'signed');
    await execution.persistSigned(lease, { encryptedSignedPayload, signature: signed.signature, messageHash: signed.messageHash });
    // Record synthetic settlement or an unresolved hold, without a worker or broadcast.
    if (settled) {
      await execution.settle(lease, { success: true, fee: allowance, debit: reservation - allowance,
        recovered: 0n, residual: 0n, slot: 21_010 });
    } else {
      await execution.note(lease, 'broadcast_unknown');
      await execution.reschedule(lease, 60_000);
    }
    await campaigns.setCampaignStatus(campaign.id, 'paused');
    return { id, campaignId: campaign.id, operationId, encryptedSignedPayload, encryptedPayerKey,
      payloadHash: createHash('sha256').update(Buffer.from(signed.signedBase64, 'base64')).digest('hex'),
      payerHash: createHash('sha256').update(payer.secretKey).digest('hex') };
  } finally {
    sponsor.secretKey.fill(0); user.secretKey.fill(0); payer.secretKey.fill(0);
  }
}

async function snapshot(pool: Pool) {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of [...TABLES, 'drizzle.__drizzle_migrations']) {
    const identifier = table === 'drizzle.__drizzle_migrations' ? 'drizzle.__drizzle_migrations' : `public."${table}"`;
    const rows = await pool.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM ${identifier} AS t`);
    result[table] = fingerprintRows(rows.rows.map((row) => row.row));
  }
  const constraints = await pool.query<{ row: string }>(`SELECT concat(n.nspname,'.',t.relname,':',c.conname,':',pg_get_constraintdef(c.oid)) AS row
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname IN ('public','drizzle')`);
  result.constraints = fingerprintRows(constraints.rows.map((row) => row.row));
  const indexes = await pool.query<{ row: string }>(`SELECT concat(schemaname,'.',tablename,':',indexname,':',indexdef) AS row
    FROM pg_indexes WHERE schemaname IN ('public','drizzle')`);
  result.indexes = fingerprintRows(indexes.rows.map((row) => row.row));
  const triggers = await pool.query<{ row: string }>(`SELECT concat(n.nspname,'.',c.relname,':',pg_get_triggerdef(t.oid),':',pg_get_functiondef(t.tgfoid)) AS row
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname IN ('public','drizzle')`);
  result.triggers = fingerprintRows(triggers.rows.map((row) => row.row));
  const sequences = await pool.query<{ row: string }>(`SELECT to_jsonb(s)::text AS row FROM pg_sequences s
    WHERE schemaname IN ('public','drizzle')`);
  result.sequences = fingerprintRows(sequences.rows.map((row) => row.row));
  return result;
}

async function expectRejected(pool: Pool, sql: string, code: string): Promise<void> {
  let actual: unknown;
  // A savepoint makes a missing guard a failed drill without changing restored evidence.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { await client.query(sql); } catch (error) { actual = (error as { code?: string }).code; }
    finally { await client.query('ROLLBACK'); }
  } finally { client.release(); }
  requireCheck(actual === code, 'restored_guard_missing');
}

async function verifyRestore(pool: Pool, fixture: Awaited<ReturnType<typeof seedFixture>>, wrappingKey: string) {
  const attempt = (await pool.query<{ encrypted_payer_key: string; payer_public_key: string; status: string; remaining_reservation_native: string }>(
    'SELECT encrypted_payer_key,payer_public_key,status,remaining_reservation_native FROM attempts WHERE id=$1', [fixture.id])).rows[0];
  const op = (await pool.query<{ encrypted_signed_payload: string; status: string }>(
    'SELECT encrypted_signed_payload,status FROM execution_operations WHERE id=$1', [fixture.operationId])).rows[0];
  requireCheck(attempt && op && attempt.status === 'broadcast_unknown' && op.status === 'broadcast_unknown'
    && BigInt(attempt.remaining_reservation_native) > 0n, 'pending_state_lost');
  requireCheck(op.encrypted_signed_payload === fixture.encryptedSignedPayload && attempt.encrypted_payer_key === fixture.encryptedPayerKey, 'ciphertext_changed');
  const payload = Buffer.from(openPayload(op.encrypted_signed_payload, wrappingKey, fixture.operationId, 'signed'), 'base64');
  const payer = openAttemptKey(attempt.encrypted_payer_key, wrappingKey, fixture.id, attempt.payer_public_key);
  try {
    requireCheck(createHash('sha256').update(payload).digest('hex') === fixture.payloadHash
      && createHash('sha256').update(payer).digest('hex') === fixture.payerHash, 'decryption_changed');
    requireCheck(Transaction.from(payload).verifySignatures(true), 'restored_signature_invalid');
  } finally { payload.fill(0); payer.fill(0); }
  const invalid = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM campaigns c
    WHERE c.status<>'paused' OR c.reserved_native<>(SELECT coalesce(sum(remaining_reservation_native),0) FROM attempts a WHERE a.campaign_id=c.id)
      OR c.spent_native<>(SELECT coalesce(sum(actual_cost_native),0) FROM attempts a WHERE a.campaign_id=c.id)
      OR c.reserved_native<>(SELECT coalesce(sum(CASE WHEN type='reserve' THEN amount_native WHEN type IN ('release','debit','fee') THEN -amount_native ELSE 0 END),0) FROM ledger_entries l WHERE l.campaign_id=c.id)
      OR c.spent_native<>(SELECT coalesce(sum(CASE WHEN type IN ('debit','fee') THEN amount_native WHEN type='recovery' THEN -amount_native ELSE 0 END),0) FROM ledger_entries l WHERE l.campaign_id=c.id)
      OR c.reserved_users<>(SELECT count(*) FROM attempts a WHERE a.campaign_id=c.id AND a.status IN ('prepared','signing','signed','submitted','broadcast_unknown','confirmed','manual_review'))
      OR c.consumed_users<>(SELECT count(*) FROM invites i WHERE i.campaign_id=c.id AND i.status='consumed')`);
  requireCheck(invalid.rows[0]?.count === 0, 'accounting_mismatch');
  const relations = await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM attempts a
    JOIN invites i ON i.id=a.invite_id JOIN execution_operations o ON o.attempt_id=a.id
    JOIN execution_jobs j ON j.operation_id=o.id WHERE a.id=$1 AND i.active_attempt_id=a.id
    AND i.expected_wallet=a.wallet AND i.campaign_id=a.campaign_id AND o.campaign_id=a.campaign_id
    AND j.lease_owner IS NULL AND j.lease_expires_at IS NULL AND j.retry_count=1
    AND EXISTS (SELECT 1 FROM execution_audit e WHERE e.operation_id=o.id AND e.event='payload_persisted')
    AND EXISTS (SELECT 1 FROM execution_audit e WHERE e.operation_id=o.id AND e.event='broadcast_uncertain')`, [fixture.id]);
  requireCheck(relations.rows[0]?.count === 1, 'relations_changed');
  for (const table of ['ledger_entries', 'execution_audit']) {
    for (const mutation of [`UPDATE ${table} SET id=id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      await expectRejected(pool, mutation, '55000');
    }
  }
  await expectRejected(pool, 'UPDATE campaigns SET reserved_native=cap_native+1', '23514');
  await expectRejected(pool, 'UPDATE attempts SET remaining_reservation_native=-1', '23514');
  await expectRejected(pool, 'INSERT INTO execution_jobs (id,operation_id) SELECT gen_random_uuid(),operation_id FROM execution_jobs', '23505');
  await expectRejected(pool, `INSERT INTO execution_jobs (id,operation_id) VALUES (gen_random_uuid(),gen_random_uuid())`, '23503');
  return { encryptedBytesPreserved: true, decryptAndSignaturesVerified: true, accountingConsistent: true,
    pendingJobAndAuditPreserved: true, appendOnlyGuards: 6, constraintGuards: 4, campaignsPaused: true, workersStarted: 0, broadcasts: 0 };
}

export async function runRestoreDrill(args: string[], nodeEnv?: string) {
  const options = parseDrillOptions(args, nodeEnv);
  const runId = randomBytes(12).toString('hex');
  const source = drillDatabaseName(runId, 'source'); const restored = drillDatabaseName(runId, 'restore');
  const owned = new Set<string>(); const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const assertRunning = () => requireCheck(!controller.signal.aborted, 'interrupted');
  let directory: string | undefined;
  let admin: ReturnType<typeof createDatabase> | undefined;
  let sourceDb: ReturnType<typeof createDatabase> | undefined;
  let restoredDb: ReturnType<typeof createDatabase> | undefined;
  let result: Record<string, unknown> | undefined; let failure: unknown;
  const wrappingKey = randomBytes(32);
  try {
    // Resolve a local Unix socket once, then pin every command to it. Remote Docker contexts are refused.
    const host = parseLocalDockerHost(await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { signal: controller.signal }));
    const prefix = ['--host', host];
    const format = `{\"running\":{{json .State.Running}},\"label\":{{json (index .Config.Labels \"${CONTAINER_LABEL}\")}},\"image\":{{json .Config.Image}},\"bindings\":{{json (index .NetworkSettings.Ports \"5432/tcp\")}}}`;
    assertDrillContainer(await docker([...prefix, 'container', 'inspect', '--format', format, options.container], { signal: controller.signal }), options.port);
    assertRunning();
    admin = createDatabase(drillDatabaseUrl(options.port, 'postgres'));
    for (const name of [source, restored]) {
      // Identifiers are freshly generated and never caller-supplied. No IF EXISTS, FORCE, or reused database.
      await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      owned.add(name); assertRunning();
    }
    await migrateDatabase(drillDatabaseUrl(options.port, source));
    assertRunning();
    sourceDb = createDatabase(drillDatabaseUrl(options.port, source));
    const fixture = await seedFixture(sourceDb.pool, wrappingKey.toString('base64'));
    await seedFixture(sourceDb.pool, wrappingKey.toString('base64'), true);
    const before = await snapshot(sourceDb.pool);
    requireCheck(before['drizzle.__drizzle_migrations']?.count === 3 && before.attempts?.count === 2
      && before.execution_operations?.count === 2 && before.execution_jobs?.count === 1, 'fixture_incomplete');
    directory = await mkdtemp(join(tmpdir(), 'first-bite-restore-')); await chmod(directory, 0o700);
    const archivePath = join(directory, 'fixture.dump');
    const archive = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    // PostgreSQL client variables inside the container are replaced, not inherited.
    const pgArgs = [...prefix, 'exec', '-i', options.container, 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
      'PGCONNECT_TIMEOUT=3', 'PGOPTIONS=-c statement_timeout=20000 -c lock_timeout=3000'];
    try {
      assertRunning();
      await docker([...pgArgs, 'pg_dump', '--host=/var/run/postgresql', `--username=${USER}`, `--dbname=${source}`,
        '--format=custom', '--no-owner', '--no-acl', '--lock-wait-timeout=3s'], { stdout: archive.fd, signal: controller.signal });
      await archive.sync();
    } finally { await archive.close(); }
    const archiveStat = await stat(archivePath);
    requireCheck(archiveStat.isFile() && (archiveStat.mode & 0o777) === 0o600 && archiveStat.size > 5 && archiveStat.size <= MAX_ARCHIVE_BYTES, 'archive_invalid');
    const archiveBytes = await readFile(archivePath);
    requireCheck(archiveBytes.subarray(0, 5).toString('ascii') === 'PGDMP', 'archive_invalid');
    const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex'); archiveBytes.fill(0);
    const input = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertRunning();
      await docker([...pgArgs, 'pg_restore', '--host=/var/run/postgresql', `--username=${USER}`, `--dbname=${restored}`,
        '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], { stdin: input.fd, signal: controller.signal });
    } finally { await input.close(); }
    assertRunning();
    // Also proves restored migration hashes are accepted without replaying old migrations.
    await migrateDatabase(drillDatabaseUrl(options.port, restored));
    restoredDb = createDatabase(drillDatabaseUrl(options.port, restored));
    const after = await snapshot(restoredDb.pool);
    requireCheck(JSON.stringify(before) === JSON.stringify(after), 'restore_snapshot_mismatch');
    const checks = await verifyRestore(restoredDb.pool, fixture, wrappingKey.toString('base64'));
    requireCheck(JSON.stringify(after) === JSON.stringify(await snapshot(restoredDb.pool)), 'guard_test_mutated_data');
    result = { ok: true, event: 'restore_drill.complete', scope: 'synthetic_local_only', archiveBytes: archiveStat.size,
      archiveSha256, archiveMode: '0600', schemaVersion: 3, tables: after, checks };
  } catch (error) { failure = error; }
  finally {
    wrappingKey.fill(0);
    for (const db of [sourceDb, restoredDb]) {
      try { await db?.pool.end(); } catch { failure = new RestoreDrillError('cleanup_failed'); }
    }
    for (const name of owned) {
      try { await admin!.pool.query(`DROP DATABASE "${name}"`); }
      catch { failure = new RestoreDrillError('cleanup_failed'); }
    }
    try { await admin?.pool.end(); } catch { failure = new RestoreDrillError('cleanup_failed'); }
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { failure = new RestoreDrillError('cleanup_failed'); }
    }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (failure) throw failure instanceof RestoreDrillError ? failure : new RestoreDrillError('drill_failed');
  requireCheck(result, 'drill_failed');
  return { ...result, cleanup: { ownedDatabasesRemoved: owned.size, archiveRemoved: true } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runRestoreDrill(process.argv.slice(2), process.env.NODE_ENV), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, event: 'restore_drill.failed', code: error instanceof RestoreDrillError ? error.code : 'drill_failed' }));
    process.exitCode = 1;
  }
}
