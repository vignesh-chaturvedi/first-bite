import { describe, expect, it, vi } from 'vitest';
import { createJourneyApi } from '../src/lib/onboarding/api';
import { JourneyController } from '../src/lib/onboarding/controller';
import {
  COOKIE_GENESIS, JourneyError, errorCopy, formatCook, normalizeLabel, verifiedResult,
  type JourneyApi, type JourneyAttempt, type JourneyQuote, type JourneySession,
} from '../src/lib/onboarding/model';
import { WalletError, type createNightlyWallet, type WalletSnapshot } from '../src/lib/onboarding/wallet';

const now = 1_789_344_000_000;
const walletAddress = '11111111111111111111111111111111';
const otherWallet = '22222222222222222222222222222222';
const quoteId = '10000000-0000-4000-8000-000000000001';
const attemptId = '20000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(43);
const cost = {
  registrationPrice: '15000000000000', domainRent: '1927920', primaryRent: '1426800',
  transactionFee: '15000', recoveryAllowance: '15000', maxSponsorDebit: '15000003369720', maximumReservation: '15000003384720',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(executionEnabled = true) {
  const session: JourneySession = {
    wallet: walletAddress, expiresAt: new Date(now + 600_000).toISOString(),
    campaign: { name: 'Local onboarding', slug: 'local-onboarding', status: 'active' }, attemptId: null,
  };
  const quote: JourneyQuote = {
    quoteId, name: 'firstbite', cost: { ...cost }, expiresAt: new Date(now + 30_000).toISOString(),
    expected: { domain: otherWallet, owner: walletAddress, primary: otherWallet, primaryName: 'firstbite' },
  };
  const attempt: JourneyAttempt = {
    id: attemptId, quoteId, status: 'prepared', name: 'firstbite', wallet: walletAddress,
    reservationNative: cost.maximumReservation, messageHash: 'a'.repeat(64), unsignedTransactionBase64: 'synthetic-unsigned',
    expiresAt: new Date(now + 30_000).toISOString(), signature: null, verifiedSlot: null,
    actualCostNative: '0', residualNative: null, cost: { ...cost },
  };
  const api = {
    session: vi.fn<JourneyApi['session']>().mockResolvedValue(session).mockRejectedValueOnce(new JourneyError('SESSION_REQUIRED')),
    exchange: vi.fn<JourneyApi['exchange']>().mockResolvedValue(undefined),
    quote: vi.fn<JourneyApi['quote']>().mockResolvedValue(quote),
    reserve: vi.fn<JourneyApi['reserve']>().mockResolvedValue(attempt),
    attempt: vi.fn<JourneyApi['attempt']>().mockResolvedValue(attempt),
    submit: vi.fn<JourneyApi['submit']>().mockResolvedValue(undefined),
    retry: vi.fn<JourneyApi['retry']>().mockResolvedValue(undefined),
  } satisfies JourneyApi;
  const walletState: WalletSnapshot = { installed: true, address: walletAddress, genesisHash: COOKIE_GENESIS, canSign: true };
  const wallet = {
    snapshot: vi.fn(() => ({ ...walletState })),
    connect: vi.fn(async () => ({ ...walletState })),
    switchToCookie: vi.fn(async () => ({ ...walletState })),
    disconnect: vi.fn(async () => undefined),
    sign: vi.fn<ReturnType<typeof createNightlyWallet>['sign']>().mockResolvedValue('synthetic-user-signature'),
    subscribe: vi.fn(() => () => undefined),
  } satisfies ReturnType<typeof createNightlyWallet>;
  let currentTime = now;
  const controller = new JourneyController(api, wallet, executionEnabled, () => currentTime);
  async function ready() {
    await controller.restore();
    await controller.exchange(token);
    controller.continueFromWallet();
    expect(controller.getSnapshot().step).toBe('name');
  }
  async function reviewed() {
    await ready();
    controller.editName('FirstBite.cook');
    await controller.checkName();
    await controller.reserve();
    expect(controller.getSnapshot().step).toBe('review');
  }
  return { controller, api, wallet, walletState, quote, attempt, session, ready, reviewed,
    advance: (milliseconds: number) => { currentTime += milliseconds; } };
}

describe('newcomer journey coordination', () => {
  it('blocks invitation exchange while the initial session restore is unresolved', async () => {
    const f = fixture();
    const pending = deferred<JourneySession>();
    f.api.session.mockReset().mockReturnValue(pending.promise);
    const restoring = f.controller.restore();
    await f.controller.exchange(token);
    await f.controller.restore();
    expect(f.api.exchange).not.toHaveBeenCalled();
    expect(f.api.session).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().restoring).toBe(true);
    pending.reject(new JourneyError('SESSION_REQUIRED'));
    await restoring;
    expect(f.controller.getSnapshot()).toMatchObject({ restoring: false, error: null, session: null });
    f.api.session.mockResolvedValue(f.session);
    await f.controller.exchange(token);
    expect(f.api.exchange).toHaveBeenCalledOnce();
  });

  it('ignores an older quote that resolves after a newer name check', async () => {
    const f = fixture(); await f.ready();
    const old = deferred<JourneyQuote>();
    f.api.quote.mockReturnValueOnce(old.promise);
    f.controller.editName('firstbite');
    const firstCheck = f.controller.checkName();
    f.controller.editName('newcomer');
    const latest = { ...f.quote, name: 'newcomer', expected: { ...f.quote.expected, primaryName: 'newcomer' } };
    f.api.quote.mockResolvedValue(latest);
    await f.controller.checkName();
    old.resolve(f.quote); await firstCheck;
    expect(f.controller.getSnapshot()).toMatchObject({ name: 'newcomer', quote: latest, checking: false, error: null });
    expect(f.api.quote.mock.calls).toEqual([['firstbite', walletAddress], ['newcomer', walletAddress]]);
  });

  it('does not show an outdated unavailable-name error after the name changes', async () => {
    const f = fixture(); await f.ready();
    const old = deferred<JourneyQuote>();
    f.api.quote.mockReturnValueOnce(old.promise);
    f.controller.editName('firstbite'); const checking = f.controller.checkName();
    f.controller.editName('newcomer');
    old.reject(new JourneyError('NAME_UNAVAILABLE')); await checking;
    expect(f.controller.getSnapshot()).toMatchObject({ quote: null, name: 'newcomer', checking: false, error: null });
  });

  it.each(['wallet', 'network', 'offline'] as const)('invalidates a quote and its pending response when %s changes', async (change) => {
    const f = fixture(); await f.ready(); f.controller.editName('firstbite');
    await f.controller.checkName(); expect(f.controller.getSnapshot().quote).not.toBeNull();
    const pending = deferred<JourneyQuote>(); f.api.quote.mockReturnValueOnce(pending.promise);
    const checking = f.controller.checkName();
    if (change === 'offline') f.controller.setOffline(true);
    else {
      if (change === 'wallet') f.walletState.address = otherWallet;
      else f.walletState.genesisHash = 'another-network';
      f.controller.refreshWallet();
    }
    pending.resolve(f.quote); await checking;
    expect(f.controller.getSnapshot()).toMatchObject({ quote: null, checking: false });
    await f.controller.reserve();
    expect(f.api.reserve).not.toHaveBeenCalled();
  });

  it('rejects quotes for a different owner or name and quotes that already expired', async () => {
    for (const patch of [
      { name: 'different' }, { expected: { ...fixture().quote.expected, owner: otherWallet } },
      { expected: { ...fixture().quote.expected, primaryName: 'different' } },
      { expiresAt: new Date(now).toISOString() },
    ]) {
      const f = fixture(); await f.ready(); f.controller.editName('firstbite');
      f.api.quote.mockResolvedValue({ ...f.quote, ...patch });
      await f.controller.checkName();
      expect(f.controller.getSnapshot()).toMatchObject({ quote: null, error: errorCopy(new JourneyError('QUOTE_CHANGED')) });
      expect(f.api.reserve).not.toHaveBeenCalled();
    }
  });

  it('allows only one in-flight reservation and keeps its server idempotency key', async () => {
    const f = fixture(); await f.ready(); f.controller.editName('firstbite'); await f.controller.checkName();
    const pending = deferred<JourneyAttempt>(); f.api.reserve.mockReturnValueOnce(pending.promise);
    const first = f.controller.reserve(); await f.controller.reserve();
    expect(f.api.reserve).toHaveBeenCalledOnce();
    expect(f.api.reserve.mock.calls[0]).toEqual([quoteId, expect.stringMatching(/^[a-f0-9-]{36}$/)]);
    pending.resolve(f.attempt); await first;
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'review', attempt: f.attempt, busy: null });
  });

  it('recovers a committed reservation after its response is lost', async () => {
    const f = fixture(); await f.ready(); f.controller.editName('firstbite'); await f.controller.checkName();
    f.api.reserve.mockRejectedValueOnce(new Error('lost response'));
    f.api.session.mockResolvedValue({ ...f.session, attemptId });
    await f.controller.reserve();
    expect(f.api.reserve).toHaveBeenCalledOnce();
    expect(f.api.attempt).toHaveBeenCalledWith(attemptId);
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'review', attempt: f.attempt, uncertain: false, error: null });
  });

  it('reuses the reservation key when session recovery proves that no attempt committed', async () => {
    const f = fixture(); await f.ready(); f.controller.editName('firstbite'); await f.controller.checkName();
    f.api.reserve.mockRejectedValueOnce(new Error('request interrupted'));
    await f.controller.reserve(); await f.controller.reserve();
    expect(f.api.reserve).toHaveBeenCalledTimes(2);
    expect(f.api.reserve.mock.calls[1]).toEqual(f.api.reserve.mock.calls[0]);
    expect(f.controller.getSnapshot().attempt?.id).toBe(attemptId);
  });

  it('restores a signed attempt on reload without reconnecting or signing again', async () => {
    const f = fixture();
    const signed: JourneyAttempt = { ...f.attempt, status: 'signed', signature: '3'.repeat(88) };
    f.api.session.mockReset().mockResolvedValue({ ...f.session, attemptId });
    f.api.attempt.mockResolvedValue(signed);
    await f.controller.restore();
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'progress', attempt: signed, restoring: false, uncertain: false });
    expect(f.wallet.connect).not.toHaveBeenCalled();
    expect(f.wallet.sign).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
  });

  it.each([
    { signature: null, verifiedSlot: 123 },
    { signature: '3'.repeat(88), verifiedSlot: null },
  ])('does not turn an unverified terminal response into success: %s', async (proof) => {
    const f = fixture(); await f.reviewed();
    f.api.attempt.mockResolvedValue({ ...f.attempt, status: 'complete', ...proof });
    await f.controller.refresh();
    expect(f.controller.getSnapshot().attempt?.status).toBe('prepared');
    expect(verifiedResult(f.controller.getSnapshot().attempt)).toBe(false);
    expect(f.controller.getSnapshot().error).toBe(errorCopy(new JourneyError('RESTORE_FAILED')));
  });

  it('does not sign, submit or retry when execution is disabled', async () => {
    const f = fixture(false); await f.reviewed();
    await f.controller.approve(); await f.controller.retry();
    expect(f.wallet.sign).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.api.retry).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'review', error: errorCopy(new JourneyError('EXECUTION_DISABLED')) });
  });

  it('keeps wallet rejection reviewable without submitting anything', async () => {
    const f = fixture(); await f.reviewed();
    f.wallet.sign.mockRejectedValueOnce(new WalletError('rejected'));
    await f.controller.approve();
    expect(f.wallet.sign).toHaveBeenCalledOnce();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'review', attempt: f.attempt, uncertain: false, error: errorCopy(new WalletError('rejected')) });
  });

  it('preserves an ambiguous submission and blocks another approval until status is checked', async () => {
    const f = fixture(); await f.reviewed();
    f.api.submit.mockRejectedValueOnce(new Error('connection interrupted after send'));
    await f.controller.approve();
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'progress', attempt: f.attempt, uncertain: true, error: errorCopy(new JourneyError('SUBMIT_UNKNOWN')) });
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('synthetic-user-signature');
    await f.controller.approve();
    expect(f.wallet.sign).toHaveBeenCalledOnce(); expect(f.api.submit).toHaveBeenCalledOnce();
    f.api.attempt.mockResolvedValue({ ...f.attempt, status: 'signed', signature: '3'.repeat(88) });
    await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ step: 'progress', uncertain: false, attempt: { id: attemptId, status: 'signed' } });
    await f.controller.approve();
    expect(f.wallet.sign).toHaveBeenCalledOnce(); expect(f.api.submit).toHaveBeenCalledOnce();
  });

  it('keeps an accepted submission unresolved when its first status request fails', async () => {
    const f = fixture(); await f.reviewed();
    f.api.attempt.mockRejectedValueOnce(new JourneyError('SERVICE_UNAVAILABLE'));
    await f.controller.approve(); await f.controller.approve();
    expect(f.controller.getSnapshot()).toMatchObject({ uncertain: true, attempt: { id: attemptId } });
    expect(f.api.submit).toHaveBeenCalledOnce(); expect(f.wallet.sign).toHaveBeenCalledOnce();
  });

  it('does not request a wallet approval after the prepared lease expires', async () => {
    const f = fixture(); await f.reviewed(); f.advance(30_000);
    await f.controller.approve();
    expect(f.wallet.sign).not.toHaveBeenCalled(); expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().error).toBe(errorCopy(new JourneyError('QUOTE_EXPIRED')));
  });

  it('leaves terminal success tied to an authenticated attempt and finalized evidence', async () => {
    const f = fixture(); await f.reviewed();
    f.api.attempt.mockResolvedValue({ ...f.attempt, status: 'complete', signature: '3'.repeat(88), verifiedSlot: 123 });
    await f.controller.refresh();
    expect(verifiedResult(f.controller.getSnapshot().attempt)).toBe(true);
    f.controller.freshName();
    expect(f.controller.getSnapshot().attempt?.id).toBe(attemptId);
  });
});

describe('browser request boundary', () => {
  it('uses fixed same-origin requests and sends invitation capabilities only in the POST body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const api = createJourneyApi(fetcher); await api.exchange(token);
    expect(fetcher).toHaveBeenCalledWith('/api/invites/exchange', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal),
    }));
    expect(fetcher.mock.calls[0]?.[0]).not.toContain(token);
  });

  it('validates and strips unrelated response fields before exposing attempts to the controller', async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ attempt: { ...f.attempt, encryptedPayerKey: 'must-not-reach-state' } })));
    const result = await createJourneyApi(fetcher).attempt(attemptId);
    expect(result).toEqual(f.attempt);
    expect(result).not.toHaveProperty('encryptedPayerKey');
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/attempts/${attemptId}`);
  });

  it('rejects malformed or oversized successful responses', async () => {
    for (const body of [JSON.stringify({ attempt: { id: attemptId, status: 'complete' } }), 'x'.repeat(65_537)]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(createJourneyApi(fetcher).attempt(attemptId)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('keeps only bounded public error codes and never returns raw service messages', async () => {
    for (const [code, expected] of [['NAME_UNAVAILABLE', 'NAME_UNAVAILABLE'], ['https://private.example?secret=abc', 'SERVICE_UNAVAILABLE']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: 'secret response' } }), { status: 409 }));
      const pending = createJourneyApi(fetcher).quote('firstbite', walletAddress);
      await expect(pending).rejects.toMatchObject({ code: expected, message: expected });
    }
  });
});

describe('newcomer display model', () => {
  it.each([
    ['0', '0 COOK'], ['1', '0.000000001 COOK'], ['10', '0.00000001 COOK'],
    ['1000000000', '1 COOK'], ['15000003384720', '15,000.00338472 COOK'],
    ['9007199254740993', '9,007,199.254740993 COOK'],
    ['999999999999999999999999', '999,999,999,999,999.999999999 COOK'],
  ])('formats native amount %s exactly', (native, display) => {
    expect(formatCook(native)).toBe(display);
  });

  it.each(['-1', '1.5', '01', '1e9', '1000000000000000000000000'])('does not guess a malformed native amount %s', (native) => {
    expect(formatCook(native)).toBe('Unavailable');
  });

  it('normalizes supported names and rejects unicode, internal punctuation and short names', () => {
    expect(normalizeLabel(' First-Bite.COOK ')).toBe('first-bite');
    for (const value of ['abc', 'naïve', '-hello', 'hello-', 'hello..cook', 'a'.repeat(33)]) expect(normalizeLabel(value)).toBeNull();
  });
});
