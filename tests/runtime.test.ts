import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema';
import { apiErrorResponse, ApiError } from '../src/server/errors';
import { createLogger, type Logger } from '../src/server/logger';
import { evaluateReadiness } from '../src/server/readiness';
import { GET as getLiveness } from '../src/app/healthz/route';

afterEach(() => vi.useRealTimers());

describe('public runtime diagnostics', () => {
  it('returns liveness without configuration or database access', async () => {
    const response = getLiveness();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'alive' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never logs arbitrary metadata, credential URLs, errors or payloads', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const unsafe = {
      requestId: 'https://user:secret@example.com', failure: 'secret', statusCode: Infinity,
      error: new Error('private-key-secret'), payload: 'signed-transaction', databaseUrl: 'secret',
    } as unknown as Parameters<Logger>[2];
    log('error', 'runtime.request_failed', unsafe);
    expect(JSON.parse(lines[0]!)).toEqual({ timestamp: expect.any(String), level: 'error', event: 'runtime.request_failed' });
    expect(lines.join('')).not.toMatch(/secret|payload|transaction|https/);
  });

  it('keeps diagnostic identifiers and supported numeric/code metadata', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line))('warn', 'health.not_ready', {
      requestId: '72a5b0cc-98a6-4c22-b237-107884be1670', statusCode: 503, durationMs: 11.6, failure: 'worker_stale',
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({ statusCode: 503, durationMs: 12, failure: 'worker_stale', requestId: '72a5b0cc-98a6-4c22-b237-107884be1670' });
  });

  it('returns a generic error and fresh request ID without raw error details', async () => {
    const lines: string[] = [];
    const response = apiErrorResponse(new Error('postgres://user:secret@private/database'), createLogger((line) => lines.push(line)));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.code).toBe('internal_error');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
    expect(JSON.stringify(body) + lines.join('')).not.toMatch(/secret|private|postgres/);
    expect(apiErrorResponse(new ApiError('invalid_request'), () => {}).status).toBe(400);
  });
});

describe('foundation readiness', () => {
  const configured = () => parseConfig({ DATABASE_URL: 'postgresql://localhost/first_bite_test' });

  it('fails closed before a database is configured without probing', async () => {
    const probe = vi.fn();
    expect(await evaluateReadiness(parseConfig({}), probe)).toEqual({ ready: false, reason: 'database_unavailable' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('requires the migration marker and hides database failures', async () => {
    expect(await evaluateReadiness(configured(), async () => ({ migrated: false, workerFresh: true }))).toEqual({ ready: false, reason: 'migration_missing' });
    expect(await evaluateReadiness(configured(), async () => { throw new Error('secret-db-url'); })).toEqual({ ready: false, reason: 'database_unavailable' });
  });

  it('requires a recent heartbeat only when the worker is enabled', async () => {
    const probe = async () => ({ migrated: true, workerFresh: false });
    expect(await evaluateReadiness(configured(), probe)).toEqual({ ready: true });
    const enabled = parseConfig({ DATABASE_URL: 'postgresql://localhost/test', WORKER_ENABLED: 'true' });
    expect(await evaluateReadiness(enabled, probe)).toEqual({ ready: false, reason: 'worker_stale' });
    expect(await evaluateReadiness(enabled, async () => ({ migrated: true, workerFresh: true }))).toEqual({ ready: true });
  });

  it('bounds a stalled database probe without exposing diagnostics', async () => {
    vi.useFakeTimers();
    const pending = evaluateReadiness(configured(), () => new Promise(() => {}), 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ ready: false, reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
