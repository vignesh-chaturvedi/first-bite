import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { parseDatabaseUrl } from './url';

/** Each service owns its pool and must await pool.end() during shutdown. */
export function createDatabase(databaseUrl: string) {
  parseDatabaseUrl(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 3_000,
    query_timeout: 3_000,
    application_name: 'first-bite',
  });
  // Idle socket failures are emitted outside a query promise. Installing a
  // listener prevents an uncaught EventEmitter error; never print the raw error.
  pool.on('error', () => {
    console.error(JSON.stringify({ level: 'error', event: 'database.pool_idle_error' }));
  });
  return { db: drizzle(pool, { schema }), pool };
}

export type Database = ReturnType<typeof createDatabase>['db'];
