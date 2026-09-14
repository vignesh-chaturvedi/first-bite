import { describe, expect, it, vi } from 'vitest';
import { runExecutionWorker } from '../src/worker/execution';

describe('execution worker lifecycle', () => {
  it('opens no database or signer while disabled', async () => {
    const connect = vi.fn();
    await runExecutionWorker({ enabled: false, signal: new AbortController().signal, connect, log: () => {} });
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not connect after a pre-existing shutdown', async () => {
    const stop = new AbortController(); stop.abort();
    const connect = vi.fn();
    await runExecutionWorker({ enabled: true, signal: stop.signal, connect, log: () => {} });
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes an asynchronous connection when shutdown arrives during connection setup', async () => {
    const stop = new AbortController();
    const heartbeat = vi.fn(); const tick = vi.fn(); const close = vi.fn(async () => {});
    await runExecutionWorker({ enabled: true, signal: stop.signal, log: () => {},
      connect: async () => { stop.abort(); return { heartbeat, tick, close }; } });
    expect(heartbeat).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps ticks sequential and completes in-flight work before shutdown', async () => {
    const stop = new AbortController();
    const events: string[] = [];
    let finish!: () => void;
    let tickStarted!: () => void;
    const started = new Promise<void>((resolve) => { tickStarted = resolve; });
    const tick = vi.fn(async () => { events.push('tick-start'); tickStarted(); await new Promise<void>((resolve) => { finish = resolve; }); events.push('tick-end'); });
    const close = vi.fn(async () => { events.push('closed'); });
    const running = runExecutionWorker({ enabled: true, signal: stop.signal, intervalMs: 1, log: () => {},
      connect: () => ({ heartbeat: async () => { events.push('heartbeat'); }, tick, close }) });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tick).toHaveBeenCalledOnce();
    stop.abort();
    expect(close).not.toHaveBeenCalled();
    finish(); await running;
    expect(events).toEqual(['heartbeat', 'tick-start', 'tick-end', 'closed']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('survives a leased-job failure and resumes the next tick without logging payloads', async () => {
    const stop = new AbortController(); const records: unknown[] = [];
    const heartbeat = vi.fn(async () => {});
    const tick = vi.fn().mockRejectedValueOnce(new Error('secret-signed-payload postgres://user:key@db'))
      .mockImplementationOnce(async () => { stop.abort(); });
    const close = vi.fn(async () => {});
    await runExecutionWorker({ enabled: true, signal: stop.signal, intervalMs: 1, log: (...args) => records.push(args),
      connect: () => ({ heartbeat, tick, close }) });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).toContain('service_unavailable');
    expect(JSON.stringify(records)).not.toMatch(/secret-signed-payload|postgres|user:key/);
  });

  it('skips execution after a failed heartbeat and resumes once storage is healthy', async () => {
    const stop = new AbortController(); const records: unknown[] = [];
    const heartbeat = vi.fn().mockRejectedValueOnce(new Error('private-database-error')).mockResolvedValue(undefined);
    const tick = vi.fn(async () => { stop.abort(); }); const close = vi.fn(async () => {});
    await runExecutionWorker({ enabled: true, signal: stop.signal, intervalMs: 1, log: (...args) => records.push(args),
      connect: () => ({ heartbeat, tick, close }) });
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).toContain('worker.heartbeat_failed');
    expect(JSON.stringify(records)).not.toContain('private-database-error');
  });

  it('does not begin a tick when shutdown is requested during a heartbeat', async () => {
    const stop = new AbortController(); const tick = vi.fn(); const close = vi.fn(async () => {});
    await runExecutionWorker({ enabled: true, signal: stop.signal, log: () => {},
      connect: () => ({ heartbeat: async () => { stop.abort(); }, tick, close }) });
    expect(tick).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });

  it('interrupts its wait promptly on shutdown', async () => {
    const stop = new AbortController(); let ticked!: () => void;
    const firstTick = new Promise<void>((resolve) => { ticked = resolve; });
    const close = vi.fn(async () => {});
    const running = runExecutionWorker({ enabled: true, signal: stop.signal, intervalMs: 60_000, log: () => {},
      connect: () => ({ heartbeat: async () => {}, tick: async () => { ticked(); }, close }) });
    await firstTick; await new Promise((resolve) => setImmediate(resolve)); stop.abort(); await running;
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a safe error if pool shutdown fails', async () => {
    const stop = new AbortController(); const records: unknown[] = [];
    const running = runExecutionWorker({ enabled: true, signal: stop.signal, log: (...args) => records.push(args),
      connect: () => ({ heartbeat: async () => {}, tick: async () => { stop.abort(); }, close: async () => { throw new Error('private-connection-secret'); } }) });
    await expect(running).rejects.toThrow('Execution worker shutdown failed');
    expect(JSON.stringify(records)).not.toContain('private-connection-secret');
  });

  it.each([0, -1, 0.5, Number.NaN, 60_001])('rejects an invalid polling interval before connecting: %s', async (intervalMs) => {
    const connect = vi.fn();
    await expect(runExecutionWorker({ enabled: true, signal: new AbortController().signal, intervalMs, connect, log: () => {} }))
      .rejects.toThrow('Invalid execution worker interval');
    expect(connect).not.toHaveBeenCalled();
  });
});
