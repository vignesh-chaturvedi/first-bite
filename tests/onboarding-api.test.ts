import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJourneyApi } from '../src/lib/onboarding/api';
import { errorCopy, JourneyError, verifiedResult, type JourneyAttempt } from '../src/lib/onboarding/model';

const id = '10000000-0000-4000-8000-000000000001';
const wallet = '2'.repeat(32);
const expiresAt = '2030-01-01T00:00:00.000Z';
const session = { wallet, expiresAt, campaign: { name: 'Local pilot', slug: 'local-pilot', status: 'active' }, attemptId: id };
const cost = { registrationPrice: '15000000000000', domainRent: '1795680', primaryRent: '1559040', transactionFee: '15000',
  recoveryAllowance: '15000', maxSponsorDebit: '15000003369720', maximumReservation: '15000003384720' };
const quote = { quoteId: id, name: 'firstbite', expiresAt, cost,
  expected: { domain: '3'.repeat(32), owner: wallet, primary: '4'.repeat(32), primaryName: 'firstbite' } };
const attempt: JourneyAttempt = { id, quoteId: id, status: 'prepared', name: 'firstbite', wallet, reservationNative: cost.maximumReservation,
  messageHash: 'a'.repeat(64), unsignedTransactionBase64: 'AQ==', expiresAt, signature: null, verifiedSlot: null,
  actualCostNative: '0', residualNative: null, cost };

function fixture(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(value, { status }));
  return { api: createJourneyApi(fetcher), fetcher };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('onboarding HTTP client boundaries', () => {
  it('uses fixed same-origin routes with private credential and cache settings for the entire journey', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json({ wallet }))
      .mockResolvedValueOnce(Response.json(quote))
      .mockResolvedValueOnce(Response.json({ attempt }))
      .mockResolvedValueOnce(Response.json({ attempt }))
      .mockResolvedValueOnce(Response.json({ status: 'signing' }))
      .mockResolvedValueOnce(Response.json({ status: 'signing' }));
    const api = createJourneyApi(fetcher);
    expect(await api.session()).toEqual(session);
    await api.exchange('private-invitation-token');
    expect(await api.quote('firstbite', wallet)).toEqual(quote);
    expect(await api.reserve(id, 'reservation-key')).toEqual(attempt);
    expect(await api.attempt(id)).toEqual(attempt);
    await api.submit(id, 'private-user-signature');
    await api.retry(id);
    const calls = fetcher.mock.calls;
    expect(calls.map(([path]) => path)).toEqual(['/api/session', '/api/invites/exchange', '/api/quotes', '/api/attempts',
      `/api/attempts/${id}`, `/api/attempts/${id}/submit`, `/api/attempts/${id}/retry`]);
    expect(calls.map(([, options]) => options?.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'GET', 'POST', 'POST']);
    expect(calls.map(([, options]) => options?.body ? JSON.parse(String(options.body)) : undefined)).toEqual([
      undefined, { token: 'private-invitation-token' }, { name: 'firstbite', wallet }, { quoteId: id, idempotencyKey: 'reservation-key' },
      undefined, { userSignedTransactionBase64: 'private-user-signature' }, {},
    ]);
    for (const [path, options] of calls) {
      expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(options?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('Cookie')).toBe(false);
      if (options?.method === 'POST') expect(headers.get('Content-Type')).toBe('application/json');
      expect(String(path)).not.toContain('private-');
    }
  });

  it('encodes an untrusted attempt identifier inside the fixed local route', async () => {
    const f = fixture({ attempt });
    const untrusted = '../session?token=private#https://other.example';
    await f.api.attempt(untrusted);
    await f.api.submit(untrusted, 'signature');
    await f.api.retry(untrusted);
    expect(f.fetcher.mock.calls.map(([path]) => path)).toEqual([
      `/api/attempts/${encodeURIComponent(untrusted)}`,
      `/api/attempts/${encodeURIComponent(untrusted)}/submit`,
      `/api/attempts/${encodeURIComponent(untrusted)}/retry`,
    ]);
  });

  it('strips undeclared server fields before storing public response values', async () => {
    const privateFields = { sessionToken: 'hidden-capability', encryptedPayerKey: 'hidden-key', signedPayload: 'hidden-payload' };
    const s = fixture({ ...session, ...privateFields, campaign: { ...session.campaign, sponsorSecret: 'hidden-sponsor' } });
    const q = fixture({ ...quote, ...privateFields, cost: { ...cost, ...privateFields } });
    const a = fixture({ attempt: { ...attempt, ...privateFields, cost: { ...cost, ...privateFields } } });
    expect(await s.api.session()).toEqual(session);
    expect(await q.api.quote('firstbite', wallet)).toEqual(quote);
    expect(await a.api.attempt(id)).toEqual(attempt);
  });

  it.each([
    ['missing wallet', { ...session, wallet: undefined }],
    ['non-ISO expiry', { ...session, expiresAt: 'tomorrow' }],
    ['arbitrary campaign status', { ...session, campaign: { ...session.campaign, status: 'funds-sent' } }],
    ['URL instead of attempt ID', { ...session, attemptId: 'https://other.example/attempt' }],
  ])('rejects malformed session data: %s', async (_label, value) => {
    await expect(fixture(value).api.session()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it.each([
    ['inexact number amount', { ...quote, cost: { ...cost, registrationPrice: 15_000_000_000_000 } }],
    ['negative amount', { ...quote, cost: { ...cost, domainRent: '-1' } }],
    ['unbounded amount', { ...quote, cost: { ...cost, maximumReservation: '1'.repeat(25) } }],
    ['missing ownership target', { ...quote, expected: { ...quote.expected, owner: undefined } }],
  ])('rejects malformed quote data: %s', async (_label, value) => {
    await expect(fixture(value).api.quote('firstbite', wallet)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it.each([
    ['unknown status', { ...attempt, status: 'success' }],
    ['unsafe verified slot', { ...attempt, verifiedSlot: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional verified slot', { ...attempt, verifiedSlot: 1.5 }],
    ['invalid signature', { ...attempt, signature: '<private-script>' }],
    ['oversized transaction', { ...attempt, unsignedTransactionBase64: 'a'.repeat(1645) }],
    ['missing signature field', { ...attempt, signature: undefined }],
  ])('rejects malformed attempt data on both read and reserve: %s', async (_label, value) => {
    const f = fixture({ attempt: value });
    await expect(f.api.attempt(id)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(f.api.reserve(id, 'reservation-key')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('requires the attempt envelope and never treats another response shape as a registration', async () => {
    await expect(fixture(attempt).api.attempt(id)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(fixture({ success: true }).api.reserve(id, 'reservation-key')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('accepts finalized proof fields while never treating confirmation or incomplete proof as verified ownership', async () => {
    const finalized: JourneyAttempt = { ...attempt, status: 'finalized', signature: '2'.repeat(88), verifiedSlot: 24_001 };
    expect(await fixture({ attempt: finalized }).api.attempt(id)).toEqual(finalized);
    expect(verifiedResult(finalized)).toBe(true);
    expect(verifiedResult({ ...finalized, status: 'complete' })).toBe(true);
    expect(verifiedResult({ ...finalized, status: 'confirmed' })).toBe(false);
    expect(verifiedResult({ ...finalized, signature: null })).toBe(false);
    expect(verifiedResult({ ...finalized, verifiedSlot: null })).toBe(false);
    expect(verifiedResult(null)).toBe(false);
  });

  it('carries only the safe server error code and uses local public error copy', async () => {
    const f = fixture({ error: { code: 'NAME_UNAVAILABLE', message: 'private-rpc-url', nextAction: 'send-private-token', stack: 'secret-stack' } }, 409);
    const error = await f.api.quote('firstbite', wallet).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(JourneyError);
    expect(error).toMatchObject({ code: 'NAME_UNAVAILABLE', message: 'NAME_UNAVAILABLE' });
    expect(errorCopy(error)).toBe('That name is already registered. Try another name.');
    expect(String(error) + errorCopy(error)).not.toMatch(/private|secret/);
  });

  it.each([null, 123, 'private-rpc-url', '<script>', 'X'.repeat(51)])('filters unsafe error codes: %s', async (code) => {
    const error = await fixture({ error: { code, message: 'private-server-message' } }, 500).api.session().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' });
    expect(errorCopy(error)).not.toContain('private');
  });

  it('uses generic public copy for an unknown but syntactically safe server code', async () => {
    const error = await fixture({ error: { code: 'UNKNOWN_SERVER_ERROR', message: 'private-server-message' } }, 500).api.session().catch((value: unknown) => value);
    expect(errorCopy(error)).not.toContain('UNKNOWN_SERVER_ERROR');
    expect(errorCopy(error)).not.toContain('private-server-message');
  });

  it.each(['malformed JSON', 'empty body', 'fetch rejection', 'stream failure'])('redacts raw transport failures: %s', async (condition) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (condition === 'fetch rejection') throw new Error('private-rpc-and-token');
      if (condition === 'empty body') return new Response(null);
      if (condition === 'stream failure') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-stream')); } }));
      return new Response('{"private-broken-json');
    });
    const error = await createJourneyApi(fetcher).session().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' });
    expect(String(error) + errorCopy(error)).not.toContain('private');
  });

  it('accepts a valid response exactly at the 64 KiB byte ceiling', async () => {
    const body = JSON.stringify(session).padEnd(65_536, ' ');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    expect(await createJourneyApi(fetcher).session()).toEqual(session);
  });

  it('cancels streaming as soon as the response exceeds 64 KiB', async () => {
    const cancel = vi.fn(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls <= 2 ? 32_768 : 1)); }, cancel,
    }, { highWaterMark: 0 });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(createJourneyApi(fetcher).session()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBe(3);
    expect(body.locked).toBe(false);
  });

  it('counts response bytes rather than decoded multibyte character length', async () => {
    const body = JSON.stringify({ ...session, padding: 'é'.repeat(40_000) });
    expect(body.length).toBeLessThan(65_536);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(createJourneyApi(fetcher).session()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it.each(['response headers', 'response body'])('aborts a stalled request after 12 seconds while waiting for %s', async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_path, options) => {
      signal = options!.signal!;
      if (stage === 'response headers') return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('private-network-timeout')), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal!.addEventListener('abort', () => controller.error(new Error('private-body-timeout')), { once: true });
      } }));
    });
    const pending = createJourneyApi(fetcher).session();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
