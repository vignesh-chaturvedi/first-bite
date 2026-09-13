import { randomBytes } from 'node:crypto';
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
    expect(result).toEqual([{ key: 'schema_version', value: { version: 1 } }]);
    const history = await connection!.pool.query(`SELECT count(*)::integer AS count FROM "${migrationsSchema}".__drizzle_migrations`);
    expect(history.rows[0].count).toBe(1);
  });

  it('seeds deterministic non-secret metadata idempotently', async () => {
    await seedDevelopmentFixture(connection!.db);
    await seedDevelopmentFixture(connection!.db);
    const rows = await connection!.db.select().from(appMetadata).where(eq(appMetadata.key, DEVELOPMENT_FIXTURE.key));
    expect(rows).toEqual([DEVELOPMENT_FIXTURE]);
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
