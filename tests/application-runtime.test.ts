import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema';
import { createDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { createSubmissionRuntime } from '../src/lib/execution/runtime';
import { assertRuntimeBinding } from '../src/lib/execution/runtime-binding';
import { executionHeartbeatPattern, executionIdentity } from '../src/lib/execution/runtime-identity';
import { connectWorker } from '../src/worker/runtime';
import { runExecutionWorker } from '../src/worker/execution';

const databaseUrl = process.env.DATABASE_TEST_URL;
describe.skipIf(!databaseUrl)('application custody binding and worker process connection', () => {
  const schema = `first_bite_runtime_${randomBytes(8).toString('hex')}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let scopedUrl: string;
  beforeAll(async () => {
    assertLocalFixtureUrl(databaseUrl!, 'test');
    const url = parseDatabaseUrl(databaseUrl);
    if (url.pathname !== '/first_bite_test') throw new Error('Dedicated test database required');
    admin = createDatabase(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema: `${schema}_migrations` });
    db = createDatabase(scopedUrl);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}_migrations" CASCADE`);
      await admin.pool.end();
    }
  });
  function settings() {
    const sponsor = Keypair.generate();
    const config = parseConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://first-bite.example',
      DATABASE_URL: scopedUrl, RELAY_ENABLED: 'true', PREPARATION_ENABLED: 'true', WORKER_ENABLED: 'true',
      SPONSOR_PUBLIC_KEY: sponsor.publicKey.toBase58(), ATTEMPT_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    return { config, sponsor };
  }

  it('pins custody atomically and never overwrites it for a mismatched replica', async () => {
    const { config } = settings();
    const changed = { ...config, attemptEncryptionKey: randomBytes(32).toString('base64') };
    const results = await Promise.allSettled([assertRuntimeBinding(db.pool, config), assertRuntimeBinding(db.pool, changed)]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? config : changed;
    const loser = winner === config ? changed : config;
    await assertRuntimeBinding(db.pool, winner);
    await expect(assertRuntimeBinding(db.pool, loser)).rejects.toMatchObject({ code: 'policy_changed' });
    const saved = (await db.pool.query('SELECT value FROM app_metadata WHERE key=$1', [`execution_identity:${config.sponsorPublicKey}`])).rows[0];
    expect(saved.value).toEqual({ identity: executionIdentity(winner) });
    expect(JSON.stringify(saved)).not.toContain(winner.attemptEncryptionKey);
    await assertRuntimeBinding(db.pool, settings().config);
  });

  it('provides a submission-only web interface without loading a worker secret', async () => {
    const { config } = settings();
    vi.stubEnv('SPONSOR_SECRET_KEY_BASE64', 'deliberately-invalid');
    const runtime = createSubmissionRuntime(db.pool, config);
    expect(Object.keys(runtime.service).sort()).toEqual(['retry', 'submit']);
    await runtime.assertRuntime();
    expect(() => connectWorker(config)).toThrow('Worker signing key is unavailable');
    expect((await db.pool.query('SELECT worker_id FROM service_heartbeats')).rowCount).toBe(0);
  });

  it('runs the real worker connection, publishes matching custody health and removes it on shutdown', async () => {
    const { config, sponsor } = settings();
    vi.stubEnv('SPONSOR_SECRET_KEY_BASE64', Buffer.from(sponsor.secretKey).toString('base64'));
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests permitted'));
    const stop = new AbortController();
    let calls = 0;
    await runExecutionWorker({ enabled: true, signal: stop.signal, log: () => {},
      connect: () => {
        const connection = connectWorker(config);
        return { ...connection, async tick() {
          calls++;
          const health = await db.pool.query('SELECT worker_id FROM service_heartbeats WHERE worker_id ~ $1',
            [executionHeartbeatPattern(executionIdentity(config))]);
          expect(health.rowCount).toBe(1);
          await connection.tick();
          stop.abort();
        } };
      } });
    expect(calls).toBe(1);
    expect(external).not.toHaveBeenCalled();
    expect((await db.pool.query('SELECT worker_id FROM service_heartbeats')).rowCount).toBe(0);
  });

  it('rejects wrong custody before publishing a heartbeat', async () => {
    const { config, sponsor } = settings();
    await assertRuntimeBinding(db.pool, config);
    vi.stubEnv('SPONSOR_SECRET_KEY_BASE64', Buffer.from(sponsor.secretKey).toString('base64'));
    const connection = connectWorker({ ...config, attemptEncryptionKey: randomBytes(32).toString('base64') });
    try {
      await expect(connection.heartbeat()).rejects.toMatchObject({ code: 'policy_changed' });
      await expect(connection.tick()).rejects.toMatchObject({ code: 'policy_changed' });
      expect((await db.pool.query('SELECT worker_id FROM service_heartbeats')).rowCount).toBe(0);
    } finally { await connection.close(); }
  });

  it('keeps an ordinary heartbeat distinct from an execution worker', async () => {
    vi.stubEnv('SPONSOR_SECRET_KEY_BASE64', 'ignored-invalid-secret');
    const connection = connectWorker(parseConfig({ DATABASE_URL: scopedUrl, WORKER_ENABLED: 'true' }));
    try {
      await connection.heartbeat(); await connection.tick();
      const ids = (await db.pool.query('SELECT worker_id FROM service_heartbeats')).rows;
      expect(ids).toHaveLength(1); expect(ids[0].worker_id).not.toContain('execution:');
    } finally { await connection.close(); }
  });

  it('does not connect or load custody when the worker is disabled', async () => {
    vi.stubEnv('SPONSOR_SECRET_KEY_BASE64', 'ignored-invalid-secret');
    const connect = vi.fn(() => connectWorker(parseConfig({})));
    await runExecutionWorker({ enabled: false, signal: new AbortController().signal, connect, log: () => {} });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects malformed identity patterns before a SQL call', () => {
    expect(() => executionHeartbeatPattern(randomUUID())).toThrow();
    expect(() => executionIdentity(parseConfig({}))).toThrow();
  });
});
