import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CampaignError, type AttemptView } from '../src/lib/campaigns/types';
import { createExecutionHandlers, type ExecutionHttpDependencies, type ExecutionStatusView } from '../src/lib/execution/http';
import { ExecutionError, type ExecutionCode } from '../src/lib/execution/types';
import { SESSION_COOKIE_NAME } from '../src/lib/security/http';
import { generateToken, hashToken } from '../src/lib/security/tokens';
import { createLogger } from '../src/server/logger';

const origin = 'https://localhost:3000';
const payload = Buffer.from('user-signed-payload-fixture').toString('base64');

function fixture(overrides: Partial<ExecutionHttpDependencies> = {}) {
  const id = randomUUID();
  const token = generateToken();
  const attempt: AttemptView = { id, quoteId: id, status: 'signed', name: 'firstbite', wallet: '11111111111111111111111111111111',
    reservationNative: '15000003384720', messageHash: 'a'.repeat(64), unsignedTransactionBase64: 'AA==', expiresAt: new Date() };
  const status: ExecutionStatusView = { attemptId: id, status: 'broadcast_unknown', signature: '2'.repeat(88),
    verifiedSlot: null, actualCostNative: '0', residualNative: null };
  const store = {
    getAttempt: vi.fn(async () => attempt),
    takeRateLimit: vi.fn<ReturnType<ExecutionHttpDependencies['getCampaignStore']>['takeRateLimit']>(async () => undefined),
  };
  const service = {
    submit: vi.fn<ReturnType<ExecutionHttpDependencies['getService']>['submit']>(async () => status),
    retry: vi.fn<ReturnType<ExecutionHttpDependencies['getService']>['retry']>(async () => status),
  };
  const getCampaignStore = vi.fn(() => store);
  const getService = vi.fn(() => service);
  const lines: string[] = [];
  const handlers = createExecutionHandlers({ enabled: true, appOrigin: origin, trustedIpHeader: 'none',
    getCampaignStore, getService, log: createLogger((line) => lines.push(line)), ...overrides });
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/attempts/${id}/submit`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}`, ...headers },
    body: JSON.stringify(body),
  });
  return { id, token, status, attempt, handlers, store, service, getCampaignStore, getService, lines, post };
}

describe('execution API boundary', () => {
  it.each(['submit', 'retry'] as const)('keeps disabled %s free of storage and signing work', async (action) => {
    const f = fixture({ enabled: false });
    const response = await f.handlers[action](f.post({}), f.id);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('EXECUTION_DISABLED');
    expect(f.getCampaignStore).not.toHaveBeenCalled();
    expect(f.getService).not.toHaveBeenCalled();
  });

  it.each([{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }])('rejects unsafe mutation headers: %o', async (headers) => {
    const f = fixture();
    const response = await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }, headers), f.id);
    expect([400, 403]).toContain(response.status);
    expect(f.getCampaignStore).not.toHaveBeenCalled();
    expect(f.getService).not.toHaveBeenCalled();
  });

  it.each(['', 'first_bite_session=invalid', 'duplicate'])('requires an unambiguous capability: %s', async (cookie) => {
    const f = fixture();
    const value = cookie === 'duplicate' ? `${SESSION_COOKIE_NAME}=${f.token}; ${SESSION_COOKIE_NAME}=${f.token}` : cookie;
    const response = await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }, { cookie: value }), f.id);
    expect(response.status).toBe(401);
    expect(f.getCampaignStore).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs, unexpected fields and noncanonical base64 before storage', async () => {
    const f = fixture();
    expect((await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }), '../private')).status).toBe(400);
    for (const value of ['', '%%%=', `${payload}\n`, 'AB==', Buffer.alloc(1233).toString('base64')]) {
      expect((await f.handlers.submit(f.post({ userSignedTransactionBase64: value }), f.id)).status).toBe(400);
    }
    expect((await f.handlers.submit(f.post({ userSignedTransactionBase64: payload, sponsorKey: 'private' }), f.id)).status).toBe(400);
    expect((await f.handlers.retry(f.post({ userSignedTransactionBase64: payload }), f.id)).status).toBe(400);
    expect(f.getCampaignStore).not.toHaveBeenCalled();
    expect(f.getService).not.toHaveBeenCalled();
  });

  it('enforces the streamed 4 KiB body bound and redacts malformed JSON', async () => {
    const f = fixture();
    const oversized = await f.handlers.submit(f.post({ userSignedTransactionBase64: 'private'.repeat(800) }), f.id);
    expect(oversized.status).toBe(413);
    const request = new Request(origin, { method: 'POST', headers: { origin, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${f.token}` }, body: '{"private-key":"secret-malformed' });
    const malformed = await f.handlers.submit(request, f.id);
    expect(malformed.status).toBe(400);
    expect(f.getCampaignStore).not.toHaveBeenCalled();
    expect(f.lines.join('')).not.toMatch(/secret-malformed|private-key|userSignedTransactionBase64/);
  });

  it('submits only the bounded payload and returns a public status projection', async () => {
    const f = fixture();
    f.service.submit.mockResolvedValue({ ...f.status, encryptedSignedPayload: 'private-full-signatures' } as ExecutionStatusView);
    const response = await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }), f.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attempt: f.status });
    expect(f.service.submit).toHaveBeenCalledWith(f.token, f.id, payload);
    expect(f.store.getAttempt).toHaveBeenCalledWith(f.token, f.id);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('vary')).toBe('Cookie');
    const buckets = f.store.takeRateLimit.mock.calls.flatMap(([items]) => items);
    expect(buckets.map((item) => item.scope)).toEqual(['execution:global', 'execution:ip', 'execution:session', 'execution:wallet', 'execution:attempt']);
    expect(buckets[2]!.identity).toBe(hashToken(f.token, 'session'));
    expect(JSON.stringify(buckets)).not.toContain(f.token);
    expect(f.lines).toEqual([]);
  });

  it('leaves paused-campaign idempotency to the execution service without a preparation-session gate', async () => {
    const f = fixture();
    // getAttempt authenticates progress reads even when a campaign is paused.
    // There is deliberately no getSession call requiring an active campaign.
    const one = await f.handlers.retry(f.post({}), f.id);
    const two = await f.handlers.retry(f.post({}), f.id);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(await two.json());
    expect(f.service.retry).toHaveBeenNthCalledWith(1, f.token, f.id);
    expect(f.service.retry).toHaveBeenNthCalledWith(2, f.token, f.id);
  });

  it('commits global limits before creating client buckets and prevents service work when denied', async () => {
    const f = fixture();
    f.store.takeRateLimit.mockRejectedValueOnce(new CampaignError('rate_limited'));
    const response = await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }), f.id);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(f.store.takeRateLimit).toHaveBeenCalledExactlyOnceWith([{ scope: 'execution:global', identity: 'all', limit: 30, windowMs: 60_000 }]);
    expect(f.store.getAttempt).not.toHaveBeenCalled();
    expect(f.getService).not.toHaveBeenCalled();
  });

  it('shares wallet and session limits between submit and retry', async () => {
    const f = fixture();
    await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }), f.id);
    const submitBuckets = f.store.takeRateLimit.mock.calls.flatMap(([items]) => items);
    f.store.takeRateLimit.mockClear();
    await f.handlers.retry(f.post({}), f.id);
    expect(f.store.takeRateLimit.mock.calls.flatMap(([items]) => items)).toEqual(submitBuckets);
  });

  it('does not reach the service when the invitation cannot read the attempt', async () => {
    const f = fixture();
    f.store.getAttempt.mockRejectedValue(new CampaignError('attempt_unavailable'));
    const response = await f.handlers.retry(f.post({}), f.id);
    expect(response.status).toBe(404);
    expect(f.getService).not.toHaveBeenCalled();
  });

  it('uses only the explicitly trusted IP header', async () => {
    const f = fixture({ trustedIpHeader: 'x-real-ip' });
    expect((await f.handlers.retry(f.post({}, { 'x-forwarded-for': '192.0.2.4' }), f.id)).status).toBe(503);
    expect(f.getService).not.toHaveBeenCalled();
    expect((await f.handlers.retry(f.post({}, { 'x-real-ip': '192.0.2.4' }), f.id)).status).toBe(200);
    expect(f.store.takeRateLimit.mock.calls.flatMap(([items]) => items)).toContainEqual({ scope: 'execution:ip', identity: '192.0.2.4', limit: 10, windowMs: 60_000 });
  });

  it.each<[ExecutionCode, number, string]>([
    ['disabled', 503, 'EXECUTION_DISABLED'], ['unauthorized', 401, 'SESSION_REQUIRED'], ['invalid_input', 400, 'INVALID_REQUEST'],
    ['signature_invalid', 400, 'SIGNATURE_INVALID'], ['policy_changed', 409, 'POLICY_CHANGED'], ['quote_expired', 409, 'QUOTE_EXPIRED'],
    ['unavailable', 503, 'SERVICE_UNAVAILABLE'], ['conflict', 409, 'ATTEMPT_UNRESOLVED'], ['budget_exhausted', 409, 'BUDGET_EXHAUSTED'],
    ['storage_unavailable', 503, 'SERVICE_UNAVAILABLE'], ['evidence_invalid', 503, 'SERVICE_UNAVAILABLE'],
  ])('maps %s to a fixed public error', async (code, expectedStatus, expectedCode) => {
    const f = fixture();
    f.service.submit.mockRejectedValue(new ExecutionError(code));
    const response = await f.handlers.submit(f.post({ userSignedTransactionBase64: payload }), f.id);
    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.code).toBe(expectedCode);
    expect(f.lines.join('')).not.toContain(payload);
    expect(f.lines.join('')).not.toContain(f.token);
  });

  it('rejects malformed or misattributed service responses without serializing private values', async () => {
    const f = fixture();
    for (const value of [{ ...f.status, signature: 'private-signing-key' }, { ...f.status, attemptId: randomUUID() },
      { ...f.status, verifiedSlot: Number.MAX_SAFE_INTEGER + 1 }, { ...f.status, actualCostNative: '-1' }]) {
      f.service.retry.mockResolvedValueOnce(value);
      const response = await f.handlers.retry(f.post({}), f.id);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private-signing-key');
    }
    f.service.retry.mockRejectedValueOnce(new Error('postgres://private:secret@database signed-payload'));
    const failed = await f.handlers.retry(f.post({}), f.id);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toMatch(/postgres|secret|signed-payload/);
    expect(f.lines.join('')).not.toMatch(/postgres|secret|signed-payload|private-signing-key/);
  });
});
