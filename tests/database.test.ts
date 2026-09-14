import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { DEVELOPMENT_FIXTURE, seedDevelopmentFixture } from '../src/db/fixtures.js';
import { upsertHeartbeat } from '../src/db/heartbeat.js';
import { MIGRATION_LOCK, migrateDatabase } from '../src/db/migrate.js';
import { appMetadata, serviceHeartbeats } from '../src/db/schema.js';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url.js';

describe('database URL boundaries', () => {
  it('accepts PostgreSQL URLs without exposing credentials', () => {
    expect(parseDatabaseUrl('postgresql://user:secret@127.0.0.1:55432/first_bite_dev').hostname).toBe('127.0.0.1');
    expect(() => parseDatabaseUrl('not-a-url-secret')).toThrow('A valid PostgreSQL DATABASE_URL is required');
    expect(() => parseDatabaseUrl('https://secret@example.com/database')).toThrow();
  });

  it('rejects connection overrides that bypass apparent URL boundaries', () => {
    expect(() => parseDatabaseUrl('postgres://user:secret@localhost/first_bite_test?host=remote.example')).toThrow();
    expect(() => parseDatabaseUrl('postgres://user:secret@localhost/first_bite_test?dbname=production')).toThrow();
  });

  it('restricts fixture writes to explicit local development/test databases', () => {
    expect(() => assertLocalFixtureUrl('postgres://user:secret@localhost/first_bite_dev', 'development')).not.toThrow();
    expect(() => assertLocalFixtureUrl('postgres://user:secret@127.0.0.1/first_bite_test', 'test')).not.toThrow();
    expect(() => assertLocalFixtureUrl('postgres://user:secret@db.example/first_bite_dev', 'development')).toThrow();
    expect(() => assertLocalFixtureUrl('postgres://user:secret@localhost/production', 'development')).toThrow();
    expect(() => assertLocalFixtureUrl('postgres://user:secret@localhost/first_bite_dev', 'production')).toThrow();
    expect(() => assertLocalFixtureUrl('postgres://user:secret@localhost/first_bite_dev?options=x', 'development')).toThrow();
  });
});

const databaseTestUrl = process.env.DATABASE_TEST_URL;

describe.skipIf(!databaseTestUrl)('PostgreSQL foundation integration', () => {
  const testSchema = `first_bite_test_${randomBytes(8).toString('hex')}`;
  const migrationsSchema = `${testSchema}_migrations`;
  let admin: ReturnType<typeof createDatabase> | undefined;
  let connection: ReturnType<typeof createDatabase> | undefined;
  let scopedUrl: string;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!databaseTestUrl) throw new Error('DATABASE_TEST_URL is required');
    assertLocalFixtureUrl(databaseTestUrl, 'test');
    const parsed = parseDatabaseUrl(databaseTestUrl);
    if (parsed.pathname !== '/first_bite_test') {
      throw new Error('Integration tests require the dedicated first_bite_test database');
    }
    admin = createDatabase(databaseTestUrl);
    // Identifiers contain only a static prefix and random hexadecimal suffix.
    await admin.pool.query(`CREATE SCHEMA "${testSchema}"`);
    schemaCreated = true;
    parsed.searchParams.set('options', `-c search_path=${testSchema}`);
    scopedUrl = parsed.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema });
    connection = createDatabase(scopedUrl);
  });

  afterAll(async () => {
    await connection?.pool.end();
    try {
      if (schemaCreated && admin) {
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        await admin.pool.query(`DROP SCHEMA IF EXISTS "${migrationsSchema}" CASCADE`);
      }
    } finally {
      await admin?.pool.end();
    }
  });

  it('applies the migration marker and accepts an unchanged second run', async () => {
    await migrateDatabase(scopedUrl, { migrationsSchema });
    const result = await connection!.db.select().from(appMetadata).where(eq(appMetadata.key, 'schema_version'));
    expect(result).toEqual([{ key: 'schema_version', value: { version: 3 } }]);
    const history = await connection!.pool.query(`SELECT count(*)::integer AS count FROM "${migrationsSchema}".__drizzle_migrations`);
    expect(history.rows[0].count).toBe(3);
  });

  it('seeds deterministic non-secret metadata idempotently', async () => {
    await seedDevelopmentFixture(connection!.db);
    await seedDevelopmentFixture(connection!.db);
    const rows = await connection!.db.select().from(appMetadata).where(eq(appMetadata.key, DEVELOPMENT_FIXTURE.key));
    expect(rows).toEqual([DEVELOPMENT_FIXTURE]);
  });

  it('rejects NaN in every numeric accounting and block-height column even through direct SQL', async () => {
    const campaignId = randomUUID();
    const inviteId = randomUUID();
    const attemptId = randomUUID();
    // Database-only records exercise the constraints independently of application
    // validation. These public identifiers and empty quote data never reach a signer.
    const publicKey = '11111111111111111111111111111111';
    const hash = 'a'.repeat(64);
    await connection!.pool.query(`INSERT INTO campaigns
      (id,slug,name,status,starts_at,ends_at,max_users,cap_native,sponsor_public_key,policy_version,
       max_registration_price_native,max_transaction_fee_native,recovery_allowance_native,max_reservation_native)
      VALUES ($1,$2,'Numeric invariants','draft',now(),now()+interval '1 day',10,1000,$3,'test',100,1,1,500)`,
    [campaignId, `numeric-${campaignId}`, publicKey]);
    for (const column of [
      'cap_native', 'reserved_native', 'spent_native', 'max_registration_price_native',
      'max_transaction_fee_native', 'recovery_allowance_native', 'max_reservation_native',
    ]) {
      // Column identifiers come exclusively from the static list above.
      await expect(connection!.pool.query(`UPDATE campaigns SET "${column}"='NaN'::numeric WHERE id=$1`, [campaignId]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await connection!.pool.query(`INSERT INTO invites
      (id,campaign_id,token_hash,expected_wallet,status,expires_at)
      VALUES ($1,$2,$3,$4,'active',now()+interval '1 hour')`, [inviteId, campaignId, hash, publicKey]);
    await connection!.pool.query(`INSERT INTO quotes
      (id,campaign_id,invite_id,wallet,name,payload,status,expires_at)
      VALUES ($1,$2,$3,$4,'test-name','{}'::jsonb,'quoted',now()+interval '1 minute')`,
    [attemptId, campaignId, inviteId, publicKey]);
    await connection!.pool.query(`INSERT INTO attempts
      (id,quote_id,campaign_id,invite_id,idempotency_key,wallet,name,payer_public_key,status,reservation_native,
       message_hash,unsigned_transaction_base64,blockhash,last_valid_block_height,expires_at)
      VALUES ($1,$1,$2,$3,'numeric-test',$4,'test-name',$4,'prepared',100,$5,'AA==',$4,100,now()+interval '1 minute')`,
    [attemptId, campaignId, inviteId, publicKey, hash]);
    for (const column of ['reservation_native', 'last_valid_block_height']) {
      await expect(connection!.pool.query(`UPDATE attempts SET "${column}"='NaN'::numeric WHERE id=$1`, [attemptId]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(connection!.pool.query(`INSERT INTO ledger_entries
      (id,campaign_id,attempt_id,event_key,type,amount_native)
      VALUES ($1,$2,$3,'numeric-test','reserve','NaN'::numeric)`, [randomUUID(), campaignId, attemptId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('updates one worker heartbeat and preserves other workers', async () => {
    const startedAt = new Date('2026-09-13T00:00:00Z');
    const later = new Date('2026-09-13T00:00:10Z');
    await upsertHeartbeat(connection!.db, { workerId: 'worker-a', startedAt, seenAt: startedAt });
    await upsertHeartbeat(connection!.db, { workerId: 'worker-b', startedAt, seenAt: startedAt });
    await upsertHeartbeat(connection!.db, { workerId: 'worker-a', startedAt, seenAt: later });
    const rows = await connection!.db.select().from(serviceHeartbeats).orderBy(serviceHeartbeats.workerId);
    expect(rows).toEqual([
      { workerId: 'worker-a', startedAt, lastSeenAt: later },
      { workerId: 'worker-b', startedAt, lastSeenAt: startedAt },
    ]);
  });

  it('refuses another migrator while its database-wide lock is held', async () => {
    const lockClient = await admin!.pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock($1, $2)', [...MIGRATION_LOCK]);
      await expect(migrateDatabase(scopedUrl, { migrationsSchema })).rejects.toThrow('Another migration is running');
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK]);
      lockClient.release();
    }
  });

  it('detects changed migration history rather than silently proceeding', async () => {
    const history = `"${migrationsSchema}".__drizzle_migrations`;
    const original = await connection!.pool.query<{ id: number; hash: string }>(`SELECT id, hash FROM ${history}`);
    const row = original.rows[0]!;
    try {
      await connection!.pool.query(`UPDATE ${history} SET hash = $1 WHERE id = $2`, ['changed', row.id]);
      await expect(migrateDatabase(scopedUrl, { migrationsSchema })).rejects.toThrow('Applied migration history does not match committed SQL');
    } finally {
      await connection!.pool.query(`UPDATE ${history} SET hash = $1 WHERE id = $2`, [row.hash, row.id]);
    }
  });
});
