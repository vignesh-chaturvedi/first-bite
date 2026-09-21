import { parseConfig } from '../config/schema';
import { logger } from '../server/logger';
import { runExecutionWorker } from './execution';
import { connectWorker } from './runtime';

const stop = new AbortController();
const onSignal = () => stop.abort();
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  const config = parseConfig();
  await runExecutionWorker({
    enabled: config.workerEnabled,
    signal: stop.signal,
    connect: () => connectWorker(config),
  });
} catch {
  logger('error', 'worker.start_failed', { failure: 'configuration' });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
