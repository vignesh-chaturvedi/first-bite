import type { RuntimeConfig } from '../config/schema';

export const READINESS_TIMEOUT_MS = 3_500;
export const HEARTBEAT_STALE_MS = 30_000;
export type ReadinessResult =
  | { ready: true }
  | { ready: false; reason: 'database_unavailable' | 'migration_missing' | 'worker_stale' | 'timeout' };
export type DatabaseProbe = () => Promise<{ migrated: boolean; workerFresh: boolean }>;

/** Readiness covers the Phase 1 foundation only, never permission to sponsor. */
export async function evaluateReadiness(
  config: RuntimeConfig,
  probe: DatabaseProbe,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  if (!config.databaseUrl) return { ready: false, reason: 'database_unavailable' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol('readiness timeout');
  try {
    const result = await Promise.race([
      probe(),
      new Promise<typeof expired>((resolve) => { timer = setTimeout(() => resolve(expired), timeoutMs); }),
    ]);
    if (result === expired) return { ready: false, reason: 'timeout' };
    if (!result.migrated) return { ready: false, reason: 'migration_missing' };
    if (config.workerEnabled && !result.workerFresh) return { ready: false, reason: 'worker_stale' };
    return { ready: true };
  } catch {
    return { ready: false, reason: 'database_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
