const EVENTS = [
  'runtime.config_invalid', 'runtime.request_failed', 'health.not_ready',
  'worker.disabled', 'worker.started', 'worker.heartbeat_failed', 'worker.stopped', 'worker.start_failed',
] as const;
export type LogEvent = typeof EVENTS[number];
type LogLevel = 'info' | 'warn' | 'error';
const FAILURE_CODES = [
  'configuration', 'database_unavailable', 'migration_missing', 'worker_stale', 'timeout',
  'invalid_request', 'not_found', 'conflict', 'service_unavailable', 'internal_error',
] as const;
export type FailureCode = typeof FAILURE_CODES[number];
type Metadata = {
  requestId?: string;
  statusCode?: number;
  durationMs?: number;
  failure?: FailureCode;
};
export type Logger = (level: LogLevel, event: LogEvent, metadata?: Metadata) => void;

/** No message/stack/error/URL/payload fields are accepted, even at runtime. */
export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return (level, event, metadata = {}) => {
    const entry: Record<string, string | number> = {
      timestamp: new Date().toISOString(),
      level: ['info', 'warn', 'error'].includes(level) ? level : 'error',
      event: EVENTS.includes(event) ? event : 'runtime.request_failed',
    };
    if (typeof metadata.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata.requestId)) {
      entry.requestId = metadata.requestId;
    }
    if (Number.isInteger(metadata.statusCode) && metadata.statusCode! >= 100 && metadata.statusCode! <= 599) entry.statusCode = metadata.statusCode!;
    if (typeof metadata.durationMs === 'number' && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0) entry.durationMs = Math.round(metadata.durationMs);
    if (metadata.failure && FAILURE_CODES.includes(metadata.failure)) entry.failure = metadata.failure;
    write(JSON.stringify(entry));
  };
}

export const logger = createLogger();
