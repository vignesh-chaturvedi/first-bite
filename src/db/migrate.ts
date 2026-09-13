import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PoolClient } from 'pg';
import { createDatabase } from './client';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
// Session-scoped lock held by the same connection used for DDL.
export const MIGRATION_LOCK = [1_179_208_530, 1] as const;

export async function migrateDatabase(
  databaseUrl: string,
  options: { migrationsSchema?: string } = {},
): Promise<void> {
  const migrationsSchema = options.migrationsSchema ?? 'drizzle';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(migrationsSchema)) {
    throw new Error('Invalid migration schema identifier');
  }
  const { pool } = createDatabase(databaseUrl);
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await pool.connect();
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked', [...MIGRATION_LOCK],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new Error('Another migration is running');

    // Drizzle records hashes, but applied migrations must also be checked before
    // continuing so an edited historical SQL file cannot be silently accepted.
    const historyTable = `"${migrationsSchema}"."__drizzle_migrations"`;
    const exists = await client.query<{ present: string | null }>(
      'SELECT to_regclass($1) AS present', [historyTable],
    );
    if (exists.rows[0]?.present) {
      const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
      const applied = await client.query<{ hash: string; created_at: string }>(
        `SELECT hash, created_at FROM ${historyTable} ORDER BY id`,
      );
      for (const [index, record] of applied.rows.entries()) {
        const file = files[index];
        if (!file || file.hash !== record.hash || String(file.folderMillis) !== String(record.created_at)) {
          throw new Error('Applied migration history does not match committed SQL');
        }
      }
    }
    await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema,
    });
  } finally {
    try {
      if (locked && client) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK]);
      }
    } finally {
      client?.release();
      await pool.end();
    }
  }
}
