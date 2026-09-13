import { randomUUID } from 'node:crypto';
import { parseConfig, requireDatabaseUrl } from '../config/schema';
import { createDatabase } from '../db/client';
import { upsertHeartbeat } from '../db/heartbeat';
import { logger } from '../server/logger';
import { runHeartbeatWorker } from './loop';

const stop = new AbortController();
const onSignal = () => stop.abort();
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  const config = parseConfig();
  const workerId = randomUUID();
  const startedAt = new Date();
  await runHeartbeatWorker({
    enabled: config.workerEnabled,
    signal: stop.signal,
    connect: () => {
      const { db, pool } = createDatabase(requireDatabaseUrl(config));
      return {
        heartbeat: () => upsertHeartbeat(db, { workerId, startedAt }),
        close: () => pool.end(),
      };
    },
  });
} catch {
  logger('error', 'worker.start_failed', { failure: 'configuration' });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
