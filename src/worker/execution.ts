import { setTimeout as delay } from 'node:timers/promises';
import { logger, type Logger } from '../server/logger';

export const EXECUTION_INTERVAL_MS = 1_000;
export interface ExecutionWorkerConnection {
  heartbeat(): Promise<void>;
  tick(): Promise<void>;
  close(): Promise<void>;
}
export interface ExecutionWorkerOptions {
  enabled: boolean;
  signal: AbortSignal;
  connect(): ExecutionWorkerConnection | Promise<ExecutionWorkerConnection>;
  log?: Logger;
  intervalMs?: number;
}

/** One awaited leased-job tick at a time; shutdown finishes in-flight work. */
export async function runExecutionWorker({ enabled, signal, connect, log = logger, intervalMs = EXECUTION_INTERVAL_MS }: ExecutionWorkerOptions): Promise<void> {
  if (!enabled) { log('info', 'worker.disabled'); return; }
  if (signal.aborted) return;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) throw new Error('Invalid execution worker interval');
  const connection = await connect();
  log('info', 'worker.started');
  try {
    while (!signal.aborted) {
      let healthy = false;
      try { await connection.heartbeat(); healthy = true; }
      catch { log('warn', 'worker.heartbeat_failed', { failure: 'database_unavailable' }); }
      if (healthy && !signal.aborted) {
        try { await connection.tick(); }
        catch { log('warn', 'runtime.request_failed', { failure: 'service_unavailable' }); }
      }
      if (signal.aborted) break;
      try { await delay(intervalMs, undefined, { signal }); }
      catch { if (!signal.aborted) throw new Error('Execution worker interval failed'); }
    }
  } finally {
    try { await connection.close(); }
    catch {
      log('error', 'runtime.request_failed', { failure: 'database_unavailable' });
      throw new Error('Execution worker shutdown failed');
    } finally { log('info', 'worker.stopped'); }
  }
}
