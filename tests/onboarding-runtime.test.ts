import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOnboardingRuntime } from '../src/lib/onboarding/runtime';
import { COOKIE_GENESIS, JourneyError, errorCopy, verifiedResult } from '../src/lib/onboarding/model';
import { DEMO_TOKEN } from '../src/lib/onboarding/demo';

const walletPort = vi.hoisted(() => ({
  snapshot: vi.fn(), connect: vi.fn(), switchToCookie: vi.fn(), disconnect: vi.fn(),
  sign: vi.fn(), subscribe: vi.fn(() => () => undefined),
}));
const createWallet = vi.hoisted(() => vi.fn(() => walletPort));
vi.mock('../src/lib/onboarding/wallet', () => ({ createNightlyWallet: createWallet }));

const wallet = '2'.repeat(32);
const id = '10000000-0000-4000-8000-000000000001';
const cost = { registrationPrice: '15000000000000', domainRent: '1927920', primaryRent: '1426800',
  transactionFee: '15000', recoveryAllowance: '100000', maxSponsorDebit: '15000003369720', maximumReservation: '15000003469720' };

function serveJourney() {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const session = { wallet, expiresAt, campaign: { name: 'Sponsored invitation', slug: 'invitation', status: 'active' }, attemptId: null };
  const quote = { quoteId: id, name: 'firstbite', expiresAt, cost,
    expected: { domain: '3'.repeat(32), owner: wallet, primary: '4'.repeat(32), primaryName: 'firstbite' } };
  const attempt = { id, quoteId: id, status: 'prepared', name: 'firstbite', wallet, reservationNative: cost.maximumReservation,
    messageHash: 'a'.repeat(64), unsignedTransactionBase64: 'AQ==', expiresAt, signature: null, verifiedSlot: null,
    actualCostNative: '0', residualNative: null, cost };
  const calls: { path: string; method: string; body: unknown }[] = [];
  let joined = false;
  let approved = false;
  const fetcher = vi.fn<typeof fetch>(async (path, options) => {
    calls.push({ path: String(path), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined });
    expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (path === '/api/session') return joined ? Response.json(session) : Response.json({ error: { code: 'SESSION_REQUIRED' } }, { status: 401 });
    if (path === '/api/invites/exchange') { joined = true; return Response.json({ wallet }); }
    if (path === '/api/quotes') return Response.json(quote);
    if (path === '/api/attempts') return Response.json({ attempt });
    if (path === `/api/attempts/${id}/submit`) { approved = true; return Response.json({ accepted: true }); }
    if (path === `/api/attempts/${id}`) return Response.json({ attempt: approved
      ? { ...attempt, status: 'complete', signature: '3'.repeat(88), verifiedSlot: 123, actualCostNative: cost.maxSponsorDebit, residualNative: '0' }
      : attempt });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  walletPort.snapshot.mockReturnValue({ installed: true, address: wallet, genesisHash: COOKIE_GENESIS, canSign: true });
  walletPort.sign.mockResolvedValue('test-user-signature');
  return { fetcher, calls };
}

async function review(controller: ReturnType<typeof createOnboardingRuntime>['controller']) {
  await controller.restore();
  await controller.exchange('a'.repeat(43));
  controller.continueFromWallet();
  controller.editName('firstbite');
  await controller.checkName();
  await controller.reserve();
  expect(controller.getSnapshot().step).toBe('review');
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('runtime onboarding activation', () => {
  it('defaults to paused execution even when invitation preparation is available', async () => {
    const { calls } = serveJourney();
    const { controller } = createOnboardingRuntime();
    await review(controller);
    await controller.approve();
    await controller.retry();
    expect(walletPort.sign).not.toHaveBeenCalled();
    expect(calls.some((call) => /\/(submit|retry)$/.test(call.path))).toBe(false);
    expect(controller.getSnapshot().error).toBe(errorCopy(new JourneyError('EXECUTION_DISABLED')));
  });

  it('connects an enabled invitation to the fixed submission API and verified result', async () => {
    const { calls } = serveJourney();
    const { controller } = createOnboardingRuntime({ executionEnabled: true });
    await review(controller);
    expect(walletPort.sign).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path.endsWith('/submit'))).toBe(false);
    await controller.approve();
    expect(walletPort.sign).toHaveBeenCalledOnce();
    expect(calls.find((call) => call.path.endsWith('/submit'))).toEqual({
      path: `/api/attempts/${id}/submit`, method: 'POST', body: { userSignedTransactionBase64: 'test-user-signature' },
    });
    expect(verifiedResult(controller.getSnapshot().attempt)).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('test-user-signature');
  });

  it.each([false, true])('keeps the walkthrough isolated when real execution is %s', async (executionEnabled) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { controller } = createOnboardingRuntime({ demo: true, executionEnabled });
    await controller.restore();
    const exchange = controller.exchange(DEMO_TOKEN); await vi.advanceTimersByTimeAsync(450); await exchange;
    const connect = controller.connect(); await vi.advanceTimersByTimeAsync(450); await connect;
    controller.continueFromWallet(); controller.editName('firstbite');
    const quote = controller.checkName(); await vi.advanceTimersByTimeAsync(450); await quote;
    const reserve = controller.reserve(); await vi.advanceTimersByTimeAsync(450); await reserve;
    const approve = controller.approve(); await vi.advanceTimersByTimeAsync(1350); await approve;
    expect(controller.getSnapshot().attempt?.status).toBe('submitted');
    expect(controller.getSnapshot().error).toBeNull();
    expect(createWallet).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(walletPort.sign).not.toHaveBeenCalled();
  });
});
