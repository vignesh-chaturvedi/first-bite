import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRegistrationServer } from '../scripts/phase0/registration-runner';
import { SmokeRunnerError, type SmokeRunner } from '../src/lib/smoke/runner';

describe('one-registration loopback boundary', () => {
  let server: Awaited<ReturnType<typeof startRegistrationServer>>;
  let token: string;
  const secret = 'never-return-private-state';
  const data = {
    status: 'wallets_signed', id: 'candidate-id', attemptPayer: 'A',
    config: { name: 'onecheck', sponsor: 'S', user: 'U', secret,
      limits: { maxRegistrationPrice: '15000000000000', maxTransactionFee: '100000', recoveryAllowance: '100000', maxTotalSpend: '15001000000000', secret } },
    quote: { messageSha256: 'a'.repeat(64), expiresAtMs: Date.now() + 60000, lastValidBlockHeight: 500, secret,
      cost: { registrationPrice: '15000000000000', transactionFee: '15000', maximumReservation: '15000003469720', secret },
      expected: { domain: 'D', owner: 'U', primary: 'P', primaryName: 'onecheck', secret },
      simulation: { slot: 100, unitsConsumed: 31747, blockHeight: 200, secret } },
    userSigned: true, sponsorSigned: true, transactionSignature: null,
    settlement: { success: true, fee: '15000', debit: '15000003369720', residual: '0', slot: 110, secret },
    observation: { status: 'finalized', finalizedBlockHeight: 220, accountSlot: 120, secret },
    manualReason: null, allowLive: false, phase0GateComplete: true, secret, signedBase64: secret,
  };
  let runner: SmokeRunner;
  async function start(allowLive = false) {
    server = await startRegistrationServer({ runner, port: 0, allowLive });
    const response = await fetch(server.url);
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page).not.toContain('__BOOTSTRAP__');
    token = JSON.parse(page.match(/const bootstrap = (\{[^\n]+\});/)![1]!).token;
  }
  beforeEach(async () => {
    runner = {
      status: vi.fn(async () => data), initialize: vi.fn(async () => data), prepare: vi.fn(async () => data),
      walletRequest: vi.fn(async (role) => ({ role, address: role === 'user' ? 'U' : 'S', transactionBase64: 'unsigned', id: data.id,
        messageSha256: data.quote.messageSha256, expiresAtMs: data.quote.expiresAtMs, secret })),
      acceptSignature: vi.fn(async () => data), submit: vi.fn(async () => data), reconcile: vi.fn(async () => data),
    } as unknown as SmokeRunner;
    await start();
  });
  afterEach(async () => { await server?.close(); });
  const ack = { messageSha256: 'a'.repeat(64), maxTotalSpend: '15001000000000', confirmSpend: true };
  function post(path: string, body: unknown, origin = server.url, session = token) {
    return fetch(`${server.url}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Smoke-Token': session }, body: JSON.stringify(body) });
  }
  it('projects public metadata recursively and keeps payloads out of all state responses', async () => {
    const response = await fetch(`${server.url}/state`, { headers: { 'X-Smoke-Token': token } });
    const state = await response.json();
    expect(state).toMatchObject({ status: 'wallets_signed', phase0GateComplete: false, quote: { expected: { owner: 'U' } }, settlement: { success: true, residual: '0' } });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(state)).not.toContain('signedBase64');
    for (const path of ['/prepare', '/reconcile']) expect(await (await post(path, {})).text()).not.toContain(secret);
  });
  it('requires the unpredictable session token and exact origin', async () => {
    expect((await fetch(`${server.url}/state`)).status).toBe(403);
    expect((await post('/prepare', {}, 'https://other.example')).status).toBe(403);
    expect((await post('/prepare', {}, server.url, '')).status).toBe(403);
    expect((await fetch(`${server.url}/prepare`, { method: 'POST', headers: { 'X-Smoke-Token': token, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect(runner.prepare).not.toHaveBeenCalled();
  });
  it('blocks submit at the HTTP boundary when live sending is disabled', async () => {
    expect((await post('/submit', ack)).status).toBe(403);
    expect(runner.submit).not.toHaveBeenCalled();
  });
  it('passes only the explicit acknowledgement to the live runner and never retries it', async () => {
    await server.close(); await start(true);
    expect((await post('/submit', { ...ack, arbitraryTransaction: secret })).status).toBe(400);
    expect(runner.submit).not.toHaveBeenCalled();
    expect((await post('/submit', ack)).status).toBe(200);
    expect(runner.submit).toHaveBeenCalledExactlyOnceWith(ack);
  });
  it('returns unsigned wallet requests only through the dedicated authenticated route', async () => {
    const value = await (await post('/wallet-request', { role: 'user' })).json();
    expect(value).toEqual({ role: 'user', address: 'U', transactionBase64: 'unsigned', id: data.id, messageSha256: data.quote.messageSha256, expiresAtMs: data.quote.expiresAtMs });
    expect((await post('/wallet-request', { role: 'attempt' })).status).toBe(400);
    expect((await post('/signature', { role: 'user', id: data.id, signedTransactionBase64: 'synthetic' })).status).toBe(200);
    expect(runner.acceptSignature).toHaveBeenCalledExactlyOnceWith('user', data.id, 'synthetic');
  });
  it('rejects extra fields, oversized or malformed bodies and arbitrary routes before calling the runner', async () => {
    for (const path of ['/prepare', '/reconcile', '/wallet-request', '/signature']) expect((await post(path, { secret })).status).toBe(400);
    expect((await post('/prepare', { padding: 'x'.repeat(9000) })).status).toBe(413);
    expect((await post('/initialize', {})).status).toBe(404);
    expect((await post('/sendTransaction', {})).status).toBe(404);
    expect((await post('/prepare', [])).status).toBe(400);
    const response = await fetch(`${server.url}/prepare`, { method: 'POST', headers: { Origin: server.url, 'X-Smoke-Token': token, 'Content-Type': 'application/json' }, body: '{bad' });
    expect(response.status).toBe(400);
    expect(runner.prepare).not.toHaveBeenCalled();
  });
  it('exposes only known error codes without raw RPC or transaction data', async () => {
    vi.mocked(runner.prepare).mockRejectedValueOnce(new Error(secret));
    expect(await (await post('/prepare', {})).json()).toEqual({ code: 'runner_unavailable' });
    vi.mocked(runner.prepare).mockRejectedValueOnce(new SmokeRunnerError('quote_expired'));
    expect(await (await post('/prepare', {})).json()).toEqual({ code: 'quote_expired' });
  });
});
