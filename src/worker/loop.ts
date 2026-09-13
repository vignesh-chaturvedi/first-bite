import { setTimeout as delay } from 'node:timers/promises';
import { logger, type Logger } from '../server/logger';

export const HEARTBEAT_INTERVAL_MS = 10_000;
export type WorkerConnection = { heartbeat: () => Promise<void>; close: () => Promise<void> };
type WorkerOptions = {
  enabled: boolean;
  signal: AbortSignal;
  connect: () => WorkerConnection;
  log?: Logger;
  intervalMs?: number;
};

/** Phase 1 writes service health only. No RPC, signing, queue or transaction jobs. */
export async function runHeartbeatWorker({ enabled, signal, connect, log = logger, intervalMs = HEARTBEAT_INTERVAL_MS }: WorkerOptions): Promise<void> {
  if (!enabled) {
    log('info', 'worker.disabled');
    return;
  }
  if (signal.aborted) return;
  const connection = connect();
  log('info', 'worker.started');
  try {
    while (!signal.aborted) {
      try {
        await connection.heartbeat();
      } catch {
        log('warn', 'worker.heartbeat_failed', { failure: 'database_unavailable' });
      }
      if (signal.aborted) break;
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    await connection.close();
    log('info', 'worker.stopped');
  }
}
