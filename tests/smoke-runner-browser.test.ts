import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const page = readFileSync(new URL('../scripts/phase0/registration-runner.html', import.meta.url), 'utf8');
const script = page.match(/<script nonce="__NONCE__">([\s\S]+?)<\/script>/)![1]!;
const user = '11111111111111111111111111111113';
const sponsor = '11111111111111111111111111111112';
const digest = 'a'.repeat(64);

type State = {
  status: string;
  id: string | null;
  config: { name: string; sponsor: string; user: string; limits: { maxTotalSpend: string } };
  attemptPayer: string;
  quote: null | { messageSha256: string; expiresAtMs: number; cost: Record<string, string>; expected?: { owner: string; primaryName: string } };
  userSigned: boolean;
  sponsorSigned: boolean;
  allowLive: boolean;
  transactionSignature: string | null;
  settlement: null | { success: boolean; fee: string; debit: string; residual: string; slot: number };
  manualReason?: string;
};

function browser(options: { allowLive?: boolean; sign?: ReturnType<typeof vi.fn> } = {}) {
  const elements = new Map<string, {
    textContent: string; disabled: boolean; checked: boolean; classList: { toggle: () => void };
    listeners: Record<string, () => unknown>; addEventListener: (event: string, fn: () => unknown) => void;
  }>();
  function element(id: string) {
    if (!elements.has(id)) {
      const listeners: Record<string, () => unknown> = {};
      elements.set(id, { textContent: '', disabled: false, checked: false, classList: { toggle() {} }, listeners,
        addEventListener: (event, fn) => { listeners[event] = fn; } });
    }
    return elements.get(id)!;
  }
  const sign = options.sign || vi.fn(async () => [{ signedTransaction: new Uint8Array([4, 5, 6]) }]);
  const changes: Array<() => void> = [];
  const windowEvents: Record<string, () => void> = {};
  const provider = {
    accounts: [{ address: user }], genesisHash: 'cookie-genesis', changeNetwork: vi.fn(async () => {}),
    features: {
      'standard:connect': { connect: vi.fn(async () => ({ accounts: provider.accounts })) },
      'standard:events': { on: vi.fn((_event: string, fn: () => void) => { changes.push(fn); }) },
      'solana:signTransaction': { signTransaction: sign },
    },
  };
  const saved: State = {
    status: 'initialized', id: null, config: { name: 'firstbite-test.cook', sponsor, user, limits: { maxTotalSpend: '15001000000000' } },
    attemptPayer: '11111111111111111111111111111114', quote: null, userSigned: false, sponsorSigned: false,
    allowLive: options.allowLive === true, transactionSignature: null, settlement: null,
  };
  const candidate = {
    id: 'request-1', role: 'user', address: user, messageSha256: digest, transactionBase64: 'AQID', expiresAtMs: Date.now() + 60_000,
  };
  const snapshots = () => structuredClone(saved);
  const fetch = vi.fn(async (path: string, init: RequestInit): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    const body = init.body ? JSON.parse(init.body as string) : {};
    let data: unknown;
    if (path === '/prepare') {
      saved.status = 'prepared'; saved.id = 'request-1'; candidate.expiresAtMs = Date.now() + 60_000; saved.userSigned = false; saved.sponsorSigned = false;
      saved.quote = { messageSha256: digest, expiresAtMs: Date.now() + 60_000, cost: {
        registrationPrice: '15000000000000', domainRent: '1927920', primaryRent: '1426800', transactionFee: '15000',
        maxSponsorDebit: '15000003369720', maximumReservation: '15000003469720',
      }, expected: { owner: user, primaryName: 'firstbite-test' } };
    } else if (path === '/wallet-request') {
      candidate.role = body.role; candidate.address = body.role === 'user' ? user : sponsor; candidate.id = saved.id!;
      data = { ...candidate };
    } else if (path === '/signature') {
      saved[body.role === 'user' ? 'userSigned' : 'sponsorSigned'] = true;
      saved.status = body.role === 'user' ? 'user_signed' : 'wallets_signed';
    } else if (path === '/submit') {
      saved.status = 'submitted'; saved.transactionSignature = 'public-transaction-signature';
    } else if (path === '/reconcile') {
      saved.status = 'complete'; saved.settlement = { success: true, fee: '15000', debit: '15000003369720', residual: '0', slot: 3000 };
    }
    return { ok: true, json: async () => data || snapshots() };
  });
  const blobs: Blob[] = [];
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  runInNewContext(script.replace('__BOOTSTRAP__', JSON.stringify({ token: 'PRIVATE_SESSION_TOKEN', genesisHash: 'cookie-genesis', rpcUrl: 'https://rpc.example', allowLive: options.allowLive === true })), {
    window: { nightly: { solana: provider }, addEventListener: (event: string, fn: () => void) => { windowEvents[event] = fn; } },
    document: { getElementById: element, createElement: () => link, body: { appendChild: vi.fn() } },
    fetch, Uint8Array, AbortSignal, atob, btoa, Date, Blob, setTimeout, clearTimeout,
    URL: { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL: vi.fn() },
  });
  return { element, provider, sign, fetch, candidate, saved, windowEvents, blobs, link,
    ready: async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); },
    click: async (id: string) => { await element(id).listeners.click!(); },
    check: (checked: boolean) => { element('confirm-spend').checked = checked; element('confirm-spend').listeners.change!(); },
    select: (address: string) => { provider.accounts = [{ address }]; changes.forEach((fn) => fn()); },
    report: () => JSON.parse(element('report').textContent),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

async function prepared(options: Parameters<typeof browser>[0] = {}) {
  const app = browser(options); await app.ready(); await app.click('prepare'); await app.click('connect'); return app;
}
async function bothApproved(options: Parameters<typeof browser>[0] = {}) {
  const app = await prepared(options); await app.click('sign-user'); app.select(sponsor); await app.click('connect'); await app.click('sign-sponsor'); return app;
}

describe('one-registration runner browser', () => {
  it('loads only public state on arrival and makes no automatic wallet, preparation or broadcast request', async () => {
    const app = browser(); await app.ready();
    expect(app.fetch.mock.calls.map(([path]) => path)).toEqual(['/state']);
    expect(app.provider.features['standard:connect'].connect).not.toHaveBeenCalled();
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.element('mode').textContent).toContain('Read-only preparation');
    expect(app.element('submit').disabled).toBe(true);
    expect(page).toContain('This runner can send a real transaction and spend the sponsor’s COOK.');
  });

  it('prepares without a wallet call and renders exact costs in compact review before the technical report', async () => {
    const app = await prepared();
    expect(app.element('price').textContent).toBe('15000 COOK');
    expect(app.element('rent').textContent).toBe('0.00335472 COOK');
    expect(app.element('total').textContent).toBe('15000.00346972 COOK');
    expect(app.element('cap').textContent).toBe('15001 COOK');
    expect(app.element('freshness').textContent).toContain('60s');
    expect(app.sign).not.toHaveBeenCalled();
    expect(page.indexOf('id="submit"')).toBeLessThan(page.indexOf('id="report"'));
    expect(page).toContain('<details><summary>Technical evidence report</summary>');
  });

  it('requires the newcomer first, saves that approval across account switches and signs the same message independently', async () => {
    const app = await prepared({ allowLive: true });
    expect(app.element('sign-user').disabled).toBe(false);
    expect(app.element('sign-sponsor').disabled).toBe(true);
    await app.click('sign-user');
    expect(app.report().userSigned).toBe(true);
    app.select(sponsor);
    expect(app.element('user-signed').textContent).toBe('Verified and saved');
    expect(app.element('sign-sponsor').disabled).toBe(true);
    await app.click('connect'); await app.click('sign-sponsor');
    expect(app.report()).toMatchObject({ userSigned: true, sponsorSigned: true });
    expect(app.sign.mock.calls).toEqual([
      [{ account: { address: user }, transaction: new Uint8Array([1, 2, 3]) }],
      [{ account: { address: sponsor }, transaction: new Uint8Array([1, 2, 3]) }],
    ]);
    const signaturePosts = app.fetch.mock.calls.filter(([path]) => path === '/signature');
    expect(signaturePosts.map(([, init]) => JSON.parse(init.body as string))).toEqual([
      { role: 'user', id: 'request-1', signedTransactionBase64: 'BAUG' },
      { role: 'sponsor', id: 'request-1', signedTransactionBase64: 'BAUG' },
    ]);
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('requires an explicit real-spend checkbox and click after both approvals and never auto-reconciles or retries', async () => {
    const app = await bothApproved({ allowLive: true });
    expect(app.element('confirm-spend').disabled).toBe(false);
    expect(app.element('submit').disabled).toBe(true);
    app.check(true); expect(app.element('submit').disabled).toBe(false);
    await app.click('submit');
    expect(app.fetch.mock.calls.filter(([path]) => path === '/submit')).toHaveLength(1);
    const submit = app.fetch.mock.calls.find(([path]) => path === '/submit')!;
    expect(JSON.parse(submit[1].body as string)).toEqual({ messageSha256: digest, maxTotalSpend: '15001000000000', confirmSpend: true });
    expect(app.report().transactionSignature).toBe('public-transaction-signature');
    expect(app.element('prepare').disabled).toBe(true);
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('confirm-spend').checked).toBe(false);
    expect(app.fetch.mock.calls.some(([path]) => path === '/reconcile')).toBe(false);
    await app.click('reconcile');
    expect(app.report().settlement).toMatchObject({ success: true, fee: '15000', debit: '15000003369720', residual: '0', slot: 3000 });
    expect(app.fetch.mock.calls.filter(([path]) => path === '/submit')).toHaveLength(1);
    expect(app.element('settlement').textContent).toContain('Finalized registration verified');
    expect(app.element('settlement').textContent).toContain('15000.00336972 COOK');
    expect(app.element('verified-owner').textContent).toBe(user);
    expect(app.element('verified-primary').textContent).toBe('firstbite-test.cook');
  });

  it('refuses a programmatically triggered submit with the confirmation unchecked', async () => {
    const app = await bothApproved({ allowLive: true }); await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
    expect(app.element('status').textContent).toContain('Check the spending confirmation');
  });

  it('refuses real submission in read-only mode even when both signatures exist and the checkbox is forced', async () => {
    const app = await bothApproved(); app.check(true); await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
    expect(app.element('status').textContent).toContain('cannot send');
  });

  it('requires both live opt-ins, ignoring a server-only change to live mode', async () => {
    const app = await bothApproved(); app.saved.allowLive = true; await app.click('refresh');
    app.check(true); await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('blocks sponsor approval before newcomer approval even through a direct event invocation', async () => {
    const app = await prepared(); app.select(sponsor); await app.click('connect'); await app.click('sign-sponsor');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.fetch.mock.calls.some(([path]) => path === '/wallet-request')).toBe(false);
  });

  it('checks the active account before requesting bytes even without a wallet event', async () => {
    const app = await prepared(); app.provider.accounts = [{ address: sponsor }]; await app.click('sign-user');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.fetch.mock.calls.some(([path]) => path === '/wallet-request')).toBe(false);
    expect(app.element('status').textContent).toContain('changed');
  });

  it.each(['account', 'network'])('discards a signing response after a %s change, without forwarding signed bytes', async (kind) => {
    const app = await prepared();
    app.sign.mockImplementationOnce(async () => {
      if (kind === 'account') app.select(sponsor); else app.provider.genesisHash = 'other-chain';
      return [{ signedTransaction: new Uint8Array([4, 5, 6]) }];
    });
    await app.click('sign-user');
    expect(app.fetch.mock.calls.some(([path]) => path === '/signature')).toBe(false);
    expect(app.element('status').textContent).toContain('discarded');
    expect(app.report().userSigned).toBe(false);
  });

  it('detects an account switch away and back while the wallet prompt was open', async () => {
    const app = await prepared();
    app.sign.mockImplementationOnce(async () => {
      app.select(sponsor); app.select(user); return [{ signedTransaction: new Uint8Array([4, 5, 6]) }];
    });
    await app.click('sign-user');
    expect(app.fetch.mock.calls.some(([path]) => path === '/signature')).toBe(false);
  });

  it('checks the account again after the signing-request HTTP response and before opening Nightly', async () => {
    const app = await prepared();
    app.fetch.mockImplementationOnce(async () => { app.select(sponsor); return { ok: true, json: async () => app.candidate }; });
    await app.click('sign-user');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.element('status').textContent).toContain('discarded');
  });

  it('preserves saved approvals and requires refresh if account changes while verification persists', async () => {
    const app = await prepared();
    const normalFetch = app.fetch.getMockImplementation()!;
    app.fetch.mockImplementation(async (path, init) => {
      const response = await normalFetch(path, init);
      if (path === '/signature') app.select(sponsor);
      return response;
    });
    await app.click('sign-user');
    expect(app.saved.userSigned).toBe(true);
    expect(app.report().userSigned).toBe(false);
    expect(app.element('status').textContent).toContain('discarded');
    await app.click('refresh'); expect(app.report().userSigned).toBe(true);
  });

  it.each(['role', 'address', 'id', 'messageSha256', 'expiresAtMs'])('rejects mismatched wallet-request field %s before opening Nightly', async (field) => {
    const app = await prepared();
    app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...app.candidate, [field]: field === 'expiresAtMs' ? Date.now() : 'wrong' }) });
    await app.click('sign-user');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.element('status').textContent).toContain('did not match');
  });

  it('stops signing and submission after message expiry', async () => {
    const app = await bothApproved({ allowLive: true }); app.check(true);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('freshness').textContent).toContain('expired');
    await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('ignores late wallet output after timeout and requires an explicit refresh without automatic retry', async () => {
    let resolve!: (value: unknown) => void;
    const app = await prepared({ sign: vi.fn(() => new Promise((done) => { resolve = done; })) });
    const pending = app.click('sign-user'); await app.ready(); await vi.advanceTimersByTimeAsync(60_001); await pending;
    expect(app.element('status').textContent).toContain('Late wallet responses are ignored');
    expect(app.element('prepare').disabled).toBe(true);
    resolve([{ signedTransaction: new Uint8Array([4, 5, 6]) }]); await app.ready();
    expect(app.fetch.mock.calls.some(([path]) => path === '/signature')).toBe(false);
    expect(app.sign).toHaveBeenCalledTimes(1);
    await app.click('refresh'); expect(app.element('prepare').disabled).toBe(false);
  });

  it('treats an interrupted send response as uncertain and never sends a second request automatically', async () => {
    const app = await bothApproved({ allowLive: true }); app.check(true);
    let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    app.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = app.click('submit'); await app.ready(); await vi.advanceTimersByTimeAsync(30_001); await pending;
    expect(app.element('status').textContent).toContain('timed out');
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('prepare').disabled).toBe(true);
    resolve({ ok: true, json: async () => ({ ...app.saved, transactionSignature: 'late-signature', status: 'submitted' }) });
    await app.ready();
    expect(app.report().transactionSignature).toBe(null);
    expect(app.fetch.mock.calls.filter(([path]) => path === '/submit')).toHaveLength(1);
    expect(app.fetch.mock.calls.some(([path]) => path === '/reconcile')).toBe(false);
  });

  it('does not expose raw wallet or HTTP errors in its DOM report or metadata download', async () => {
    const app = await prepared({ sign: vi.fn(async () => { throw new Error('PRIVATE_WALLET_BYTES'); }) });
    await app.click('sign-user'); await app.click('download');
    expect(app.element('status').textContent).not.toContain('PRIVATE_');
    expect(await app.blobs[0]!.text()).not.toContain('PRIVATE_');
    app.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'private-code', error: 'PRIVATE_SERVER_BYTES' }) });
    await app.click('refresh');
    expect(app.element('status').textContent).not.toContain('PRIVATE_');
    expect(app.element('status').textContent).not.toContain('private-code');
  });

  it('uses a strict field allowlist for public reports, keeping all transaction bytes and credentials out', async () => {
    const app = await prepared();
    app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...app.saved,
      raw: 'PRIVATE_RAW', token: 'PRIVATE_TOKEN', transactionBase64: 'AQID', signatures: ['BAUG'],
      config: { ...app.saved.config, secretKey: 'PRIVATE_KEY' },
      quote: { ...app.saved.quote, transactionBase64: 'AQID', cost: { ...app.saved.quote!.cost, payload: 'PRIVATE_PAYLOAD' } },
      settlement: { status: 'pending', logs: ['PRIVATE_LOG'], signedTransactionBase64: 'BAUG' },
    }) });
    await app.click('refresh'); await app.click('download');
    const report = await app.blobs[0]!.text();
    for (const omitted of ['PRIVATE_', 'AQID', 'BAUG', 'transactionBase64', 'signatures', 'payload', 'logs']) expect(report).not.toContain(omitted);
    expect(app.link.download).toBe('first-bite-registration-metadata.json');
  });

  it('authenticates each local request and never sends credentials in its JSON body or report', async () => {
    const app = await bothApproved({ allowLive: true });
    for (const [, init] of app.fetch.mock.calls) {
      expect(init.headers).toMatchObject({ 'X-Smoke-Token': 'PRIVATE_SESSION_TOKEN' });
      expect(init.credentials).toBe('omit');
      expect(init.body || '').not.toContain('PRIVATE_SESSION_TOKEN');
    }
    expect(app.element('report').textContent).not.toContain('PRIVATE_SESSION_TOKEN');
  });
  it.each(['authorized', 'signed'])('requires fresh explicit acknowledgement to resume %s after a restart, never a new preparation', async (stage) => {
    const app = await bothApproved({ allowLive: true });
    app.saved.status = stage;
    if (stage === 'signed') app.saved.transactionSignature = 'saved-public-signature';
    await app.click('refresh');
    expect(app.element('prepare').disabled).toBe(true);
    expect(app.element('sign-user').disabled).toBe(true);
    expect(app.element('sign-sponsor').disabled).toBe(true);
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('submit').textContent).toContain('Resume');
    const before = app.fetch.mock.calls.length;
    await app.click('prepare');
    expect(app.fetch.mock.calls).toHaveLength(before);
    await app.click('refresh'); app.check(true); await app.click('submit');
    expect(app.fetch.mock.calls.filter(([path]) => path === '/submit')).toHaveLength(1);
  });

  it.each(['broadcasting', 'broadcast_unknown', 'confirmed', 'complete', 'failed', 'manual_review'])('keeps %s locked to result inspection even when transaction signature is absent', async (stage) => {
    const app = await bothApproved({ allowLive: true });
    app.saved.status = stage; app.saved.transactionSignature = null;
    await app.click('refresh'); app.check(true);
    expect(app.element('prepare').disabled).toBe(true);
    expect(app.element('sign-user').disabled).toBe(true);
    expect(app.element('sign-sponsor').disabled).toBe(true);
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('reconcile').disabled).toBe(false);
    await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('keeps an expired interrupted send locked for manual inspection', async () => {
    const app = await bothApproved({ allowLive: true }); app.saved.status = 'signed';
    app.saved.transactionSignature = 'saved-public-signature'; await app.click('refresh');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(app.element('prepare').disabled).toBe(true);
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('freshness').textContent).toContain('manual inspection');
    app.check(true); await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('blocks a wrong network before requesting bytes or opening Nightly', async () => {
    const app = await prepared(); app.provider.genesisHash = 'other-chain';
    await app.click('sign-user');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.fetch.mock.calls.some(([path]) => path === '/wallet-request')).toBe(false);
  });

  it.each(['id', 'messageSha256'])('rejects a stale %s in the saved signature response and requires refresh', async (field) => {
    const app = await prepared(), normal = app.fetch.getMockImplementation()!;
    app.fetch.mockImplementation(async (path, init) => {
      const response = await normal(path, init);
      if (path !== '/signature') return response;
      const data = structuredClone(app.saved);
      if (field === 'id') data.id = 'stale-id'; else data.quote!.messageSha256 = 'b'.repeat(64);
      return { ok: true, json: async () => data };
    });
    await app.click('sign-user');
    expect(app.report().userSigned).toBe(false);
    expect(app.element('status').textContent).toContain('did not match');
    expect(app.element('prepare').disabled).toBe(true);
  });

  it('requires refresh after a failed state refresh instead of keeping the old spending confirmation usable', async () => {
    const app = await bothApproved({ allowLive: true }); app.check(true);
    app.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'busy' }) });
    await app.click('refresh');
    expect(app.element('submit').disabled).toBe(true);
    expect(app.element('confirm-spend').checked).toBe(false);
    app.check(true); await app.click('submit');
    expect(app.fetch.mock.calls.some(([path]) => path === '/submit')).toBe(false);
  });

  it('rejects any drift in the fixed spending ceiling on refresh', async () => {
    const app = await bothApproved({ allowLive: true });
    app.saved.config.limits.maxTotalSpend = '16001000000000';
    await app.click('refresh');
    expect(app.element('status').textContent).toContain('did not match');
    expect(app.report().config.limits.maxTotalSpend).toBe('15001000000000');
    expect(app.element('submit').disabled).toBe(true);
  });

  it('shows a manual-review reason without claiming verified ownership', async () => {
    const app = await prepared(); app.saved.status = 'manual_review'; app.saved.manualReason = 'evidence_invalid';
    await app.click('refresh');
    expect(app.element('settlement').textContent).toContain('evidence_invalid');
    expect(app.element('verified-owner').textContent).toBe('Not verified yet');
    expect(app.report().phase0GateComplete).toBe(false);
  });

  it.each(['quote_expired', 'storage_unavailable', 'live_disabled'])('renders actionable public runner error %s without exposing raw error details', async (code) => {
    const app = await prepared();
    app.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code, message: 'PRIVATE_ERROR' }) });
    await app.click('sign-user');
    expect(app.element('status').textContent).not.toContain('could not complete');
    expect(app.element('status').textContent).not.toContain('PRIVATE_ERROR');
  });

});
