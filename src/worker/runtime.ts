import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../config/schema';
import { requireDatabaseUrl } from '../config/schema';
import { createDatabase } from '../db/client';
import { upsertExecutionHeartbeat, upsertHeartbeat } from '../db/heartbeat';
import { createWorkerRuntime } from '../lib/execution/runtime';
import { executionIdentity } from '../lib/execution/runtime-identity';
import { loadWorkerSigner } from './signer';
import type { ExecutionWorkerConnection } from './execution';

/** Startup owns the secret; no web module imports this loader. */
export function connectWorker(config: RuntimeConfig): ExecutionWorkerConnection {
  const workerId = randomUUID();
  const startedAt = new Date();
  const signer = config.relayEnabled ? loadWorkerSigner(config.sponsorPublicKey!) : undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    database = createDatabase(requireDatabaseUrl(config));
    const { db, pool } = database;
    const identity = config.relayEnabled ? executionIdentity(config) : undefined;
    const heartbeatId = identity ? `execution:${workerId}:${identity}` : workerId;
    const runtime = signer ? createWorkerRuntime(pool, config, signer) : undefined;
    let closed = false;
    return {
      heartbeat: async () => {
        await runtime?.assertRuntime();
        if (identity) await upsertExecutionHeartbeat(db, { workerId, startedAt, identity });
        else await upsertHeartbeat(db, { workerId, startedAt });
      },
      tick: async () => { await runtime?.service.tick(); },
      async close() {
        if (closed) return;
        closed = true;
        try { await pool.query('DELETE FROM service_heartbeats WHERE worker_id=$1', [heartbeatId]); }
        finally { try { await pool.end(); } finally { signer?.close(); } }
      },
    };
  } catch (error) {
    signer?.close();
    void database?.pool.end().catch(() => undefined);
    throw error;
  }
}
