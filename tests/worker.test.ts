import { describe, expect, it, vi } from 'vitest';
import { runHeartbeatWorker } from '../src/worker/loop';

describe('unfunded heartbeat worker', () => {
  it('exits without opening a connection while disabled', async () => {
    const connect = vi.fn();
    await runHeartbeatWorker({ enabled: false, signal: new AbortController().signal, connect, log: () => {} });
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not start after shutdown has already been requested', async () => {
    const stop = new AbortController();
    stop.abort();
    const connect = vi.fn();
    await runHeartbeatWorker({ enabled: true, signal: stop.signal, connect, log: () => {} });
    expect(connect).not.toHaveBeenCalled();
  });

  it('finishes an in-flight heartbeat before closing its pool exactly once', async () => {
    const stop = new AbortController();
    let finish!: () => void;
    const heartbeat = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const close = vi.fn(async () => {});
    const running = runHeartbeatWorker({ enabled: true, signal: stop.signal, connect: () => ({ heartbeat, close }), log: () => {} });
    stop.abort();
    expect(close).not.toHaveBeenCalled();
    finish();
    await running;
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('interrupts the waiting interval promptly on shutdown', async () => {
    const stop = new AbortController();
    const close = vi.fn(async () => {});
    let markHeartbeat!: () => void;
    const heartbeated = new Promise<void>((resolve) => { markHeartbeat = resolve; });
    const running = runHeartbeatWorker({
      enabled: true, signal: stop.signal, intervalMs: 60_000,
      connect: () => ({ heartbeat: async () => markHeartbeat(), close }), log: () => {},
    });
    await heartbeated;
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    await running;
    expect(close).toHaveBeenCalledOnce();
  });

  it('survives a failed heartbeat, retries, and logs no raw database error', async () => {
    const stop = new AbortController();
    const records: unknown[] = [];
    const heartbeat = vi.fn()
      .mockRejectedValueOnce(new Error('postgres://user:secret@db/private'))
      .mockImplementationOnce(async () => stop.abort());
    const close = vi.fn(async () => {});
    await runHeartbeatWorker({
      enabled: true, signal: stop.signal, intervalMs: 1,
      connect: () => ({ heartbeat, close }), log: (...args) => records.push(args),
    });
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).toContain('worker.heartbeat_failed');
    expect(JSON.stringify(records)).not.toMatch(/secret|postgres|private/);
  });
});
