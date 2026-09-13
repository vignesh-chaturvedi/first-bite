import 'server-only';
import { getServerConfig } from '../config/server';
import { requireDatabaseUrl } from '../config/schema';
import { createDatabase } from '../db/client';
import { HEARTBEAT_STALE_MS } from './readiness';

let connection: ReturnType<typeof createDatabase> | undefined;

export function getServerDatabase() {
  connection ??= createDatabase(requireDatabaseUrl(getServerConfig()));
  return connection;
}

export async function probeDatabase(): Promise<{ migrated: boolean; workerFresh: boolean }> {
  const { pool } = getServerDatabase();
  const result = await pool.query<{ migrated: boolean; worker_fresh: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM app_metadata WHERE key = 'schema_version' AND value = '{"version":1}'::jsonb
    ) AS migrated,
    EXISTS (
      SELECT 1 FROM service_heartbeats
      WHERE last_seen_at >= now() - ($1::integer * interval '1 millisecond')
        AND last_seen_at <= now() + interval '5 seconds'
    ) AS worker_fresh
  `, [HEARTBEAT_STALE_MS]);
  return { migrated: result.rows[0]?.migrated === true, workerFresh: result.rows[0]?.worker_fresh === true };
}
