import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Run the delivered HTML script with synthetic wallet accounts and a minimal DOM.
// These are browser-control regressions, not evidence from a real extension or RPC.
const page = readFileSync('scripts/phase0/sponsor-probe.html', 'utf8');
const script = page.match(/<script nonce="__NONCE__">([\s\S]+)<\/script>/)![1]!;
const sponsor = '11111111111111111111111111111112';
const newcomer = '11111111111111111111111111111113';
const costs = {
  registrationPriceNative: '15000000000000', domainRentNative: '1927920', primaryRentNative: '1426800',
  transactionFeeNative: '15000', recoveryAllowanceNative: '100000',
  estimatedExecutionDebitNative: '15000003369720', estimatedReservationNative: '15000003469720',
  sponsorFundingShortfallNative: '15000003469720',
};

function browser(options: { ready?: boolean; sign?: ReturnType<typeof vi.fn> } = {}) {
  const elements = new Map<string, {
    textContent: string; disabled: boolean; value: string; classList: { toggle: () => void };
    listeners: Record<string, () => unknown>; addEventListener: (event: string, fn: () => unknown) => void;
  }>();
  const defaults: Record<string, string> = { sponsor, name: 'firstbite-test', 'max-price': '15000', 'max-fee': '0.0001', recovery: '0.0001', 'max-total': '15001' };
  function element(id: string) {
    if (!elements.has(id)) {
      const listeners: Record<string, () => unknown> = {};
      elements.set(id, { textContent: '', disabled: false, value: defaults[id] || '', classList: { toggle() {} }, listeners,
        addEventListener: (event, fn) => { listeners[event] = fn; } });
    }
    return elements.get(id)!;
  }
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  const blobs: Blob[] = [];
  const walletChanges: Array<(event: { accounts: Array<{ address: string }> }) => void> = [];
  const windowEvents: Record<string, () => void> = {};
  const sign = options.sign || vi.fn(async () => [{ signedTransaction: new Uint8Array([4, 5, 6]) }]);
  const provider = {
    genesisHash: 'cookie-genesis', accounts: [{ address: newcomer }], changeNetwork: vi.fn(async () => {}),
    features: {
      'standard:connect': { connect: vi.fn(async () => ({ accounts: provider.accounts })) },
      'standard:events': { on: vi.fn((_name: string, listener: (event: { accounts: Array<{ address: string }> }) => void) => { walletChanges.push(listener); }) },
      'solana:signTransaction': { signTransaction: sign },
    },
  };
  const report = {
    schemaVersion: 1, purpose: 'sponsor_backed_signature_diagnostic', outcome: options.ready ? 'ready' : 'blocked',
    name: 'firstbite-test.cook', sponsor, user: newcomer, costs, signatureRequestReady: !!options.ready,
    blockers: options.ready ? [] : ['sponsor_funding_shortfall'], simulation: { status: options.ready ? 'passed' : 'not_run', error: null, contextSlot: options.ready ? 102 : null },
    spendAuthorized: false, broadcastEnabled: false, phase0GateComplete: false,
  };
  const candidate = { id: 'candidate-id', wallet: newcomer, name: 'firstbite-test.cook', mode: 'user-first',
    messageSha256: 'test-digest', transactionBase64: 'AQID', expiresAtMs: Date.now() + 120_000, lastValidBlockHeight: 12345 };
  const fetch = vi.fn(async (path: string, _init: RequestInit): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({
    ok: true, json: async () => path === '/sponsor/prepare' ? { report, candidate: options.ready ? candidate : null } : {
      ...report, outcome: 'passed', userSignatureValid: true, messageUnchanged: true, sponsorSignaturePresent: false,
      attemptSignaturePresent: false, signatureRequestReady: false, signingEnabled: false,
      genesisHash: 'cookie-genesis', transactionBytes: 687, requiredSignatures: 3, lastValidBlockHeight: 12345,
    },
  }));
  runInNewContext(script.replace('__BOOTSTRAP__', JSON.stringify({ token: 'PRIVATE_SESSION_TOKEN', genesisHash: 'cookie-genesis', rpcUrl: 'https://rpc.example' })), {
    window: { nightly: { solana: provider }, addEventListener: (event: string, listener: () => void) => { windowEvents[event] = listener; } },
    document: { getElementById: element, createElement: () => link, body: { appendChild: vi.fn() } },
    navigator: { userAgent: 'Synthetic browser' }, fetch, Blob, Uint8Array, AbortSignal, atob, btoa, Date,
    URL: { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL: vi.fn() },
    setTimeout, clearTimeout,
  });
  return { element, link, blobs, provider, fetch, candidate, sign, windowEvents,
    walletChange: (address: string) => { provider.accounts = [{ address }]; walletChanges.forEach((listener) => listener({ accounts: provider.accounts })); },
    click: async (id: string) => { await element(id).listeners.click!(); },
    input: (id: string, value: string) => { element(id).value = value; element(id).listeners.input!(); },
    report: () => JSON.parse(element('result').textContent),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('sponsor-backed browser diagnostic', () => {
  it('leaves the actual sponsor and name fields empty in the shipped page', () => {
    expect(page).toMatch(/<input id="sponsor"[^>]*placeholder=/);
    expect(page.match(/<input id="sponsor"[^>]*>/)![0]).not.toContain('value=');
    expect(page.match(/<input id="name"[^>]*>/)![0]).not.toContain('value=');
  });

  it('exports the blocked exact-cost report without invoking a wallet signature', async () => {
    const app = browser();
    await app.click('connect'); await app.click('prepare');
    expect(app.report()).toMatchObject({ outcome: 'blocked', blockers: ['sponsor_funding_shortfall'], costs, spendAuthorized: false });
    expect(app.element('sign').disabled).toBe(true);
    expect(app.element('shortfall').textContent).toBe('15000.00346972 COOK');
    expect(app.element('rent').textContent).toBe('0.00335472 COOK');
    expect(app.element('download').disabled).toBe(false);
    await app.click('download');
    expect(app.link.download).toBe('nightly-sponsor-probe-blocked.json');
    expect(app.sign).not.toHaveBeenCalled();
    expect(app.fetch.mock.calls.map(([path]) => path)).toEqual(['/sponsor/prepare']);
    const exported = await app.blobs[0]!.text();
    for (const secret of ['PRIVATE_SESSION_TOKEN', 'transactionBase64', 'AQID']) expect(exported).not.toContain(secret);
  });

  it('sends exact native-unit caps and verifies a ready newcomer-only signature', async () => {
    const app = browser({ ready: true });
    await app.click('connect'); await app.click('prepare');
    expect(JSON.parse(app.fetch.mock.calls[0]![1].body as string)).toEqual({ sponsor, user: newcomer, name: 'firstbite-test', limits: {
      maxRegistrationPrice: '15000000000000', maxTransactionFee: '100000', recoveryAllowance: '100000', maxTotalSpend: '15001000000000',
    } });
    expect(app.element('sign').disabled).toBe(false);
    expect(app.element('review').textContent).not.toContain('AQID');
    await app.click('sign');
    expect(app.sign).toHaveBeenCalledWith({ account: { address: newcomer }, transaction: new Uint8Array([1, 2, 3]) });
    expect(app.fetch.mock.calls.map(([path]) => path)).toEqual(['/sponsor/prepare', '/sponsor/verify']);
    expect(JSON.parse(app.fetch.mock.calls[1]![1].body as string)).toEqual({ id: 'candidate-id', signedTransactionBase64: 'BAUG' });
    expect(app.report()).toMatchObject({ outcome: 'passed', userSignatureValid: true, messageUnchanged: true, phase0GateComplete: false,
      broadcast: false, registrationCompleted: false, requiredSignatures: 3, sponsorSignaturePresent: false, attemptSignaturePresent: false });
    await app.click('download');
    const exported = await app.blobs[0]!.text();
    for (const secret of ['PRIVATE_SESSION_TOKEN', 'signedTransactionBase64', 'transactionBase64', 'AQID', 'BAUG']) expect(exported).not.toContain(secret);
  });

  it.each(['-1', '0', '1e3', '1.0000000001', '.01', '1,000', '18446744073.709551616', ' 1'])('rejects malformed or out-of-range COOK cap %s before an HTTP request', async (value) => {
    const app = browser(); await app.click('connect'); app.input('max-fee', value); await app.click('prepare');
    expect(app.fetch).not.toHaveBeenCalled(); expect(app.sign).not.toHaveBeenCalled();
    expect(app.report().reason).toContain('positive COOK amounts');
    expect(app.element('download').disabled).toBe(false);
  });

  it('converts the smallest native unit and u64 maximum without floating point rounding', async () => {
    const app = browser(); await app.click('connect');
    app.input('max-fee', '0.000000001'); app.input('max-total', '18446744073.709551615'); await app.click('prepare');
    const input = JSON.parse(app.fetch.mock.calls[0]![1].body as string);
    expect(input.limits.maxTransactionFee).toBe('1'); expect(input.limits.maxTotalSpend).toBe('18446744073709551615');
  });

  it('rejects a sponsor equal to the newcomer before an HTTP request', async () => {
    const app = browser(); await app.click('connect'); app.input('sponsor', newcomer); await app.click('prepare');
    expect(app.fetch).not.toHaveBeenCalled(); expect(app.report().reason).toContain('different from the connected empty newcomer');
  });

  it('invalidates prepared bytes and reports when an input changes', async () => {
    const app = browser({ ready: true }); await app.click('connect'); await app.click('prepare');
    app.input('name', 'another-name');
    expect(app.element('sign').disabled).toBe(true); expect(app.element('download').disabled).toBe(true);
    await app.click('sign'); expect(app.sign).not.toHaveBeenCalled();
    expect(app.report().reason).toContain('changed');
  });

  it('rejects an expired candidate before opening Nightly', async () => {
    const app = browser({ ready: true }); await app.click('connect'); await app.click('prepare');
    await vi.advanceTimersByTimeAsync(120_001); await app.click('sign');
    expect(app.sign).not.toHaveBeenCalled(); expect(app.report().reason).toContain('expired');
    expect(app.fetch.mock.calls).toHaveLength(1);
  });

  it('discards a signature returned after the candidate expires', async () => {
    const app = browser({ ready: true, sign: vi.fn(async () => {
      vi.setSystemTime(Date.now() + 120_001); return [{ signedTransaction: new Uint8Array([4, 5, 6]) }];
    }) });
    await app.click('connect'); await app.click('prepare'); await app.click('sign');
    expect(app.report().reason).toContain('expired'); expect(app.fetch.mock.calls).toHaveLength(1);
  });

  it('keeps a Nightly rejection downloadable and preserves the planning costs without leaking errors', async () => {
    const app = browser({ ready: true, sign: vi.fn(async () => { throw { message: 'User rejected approval', raw: 'PRIVATE_SIGNED_BYTES' }; }) });
    await app.click('connect'); await app.click('prepare'); await app.click('sign');
    expect(app.report()).toMatchObject({ outcome: 'failed', stage: 'sign', userSignatureValid: null, messageUnchanged: null, costs,
      signatureRequestReady: false, signingEnabled: false, broadcast: false, phase0GateComplete: false });
    expect(app.report().reason).toContain('does not establish whether you cancelled');
    await app.click('download');
    expect(await app.blobs[0]!.text()).not.toContain('PRIVATE_SIGNED_BYTES');
    expect(app.link.download).toBe('nightly-sponsor-probe-failed.json');
  });

  it('discards candidate and evidence on wallet account events', async () => {
    const app = browser({ ready: true }); await app.click('connect'); await app.click('prepare');
    app.walletChange(sponsor);
    expect(app.element('wallet').textContent).toBe(sponsor);
    expect(app.element('sign').disabled).toBe(true); expect(app.element('download').disabled).toBe(true);
    expect(app.element('result').textContent).not.toContain('ready');
  });

  it('refuses a changed active wallet before signing even without an account event', async () => {
    const app = browser({ ready: true }); await app.click('connect'); await app.click('prepare');
    app.provider.accounts = [{ address: sponsor }]; await app.click('sign');
    expect(app.sign).not.toHaveBeenCalled(); expect(app.report().reason).toContain('changed');
  });

  it('does not verify a returned signature when Nightly switched networks during signing', async () => {
    const app = browser({ ready: true }); await app.click('connect'); await app.click('prepare');
    app.sign.mockImplementationOnce(async () => { app.provider.genesisHash = 'other-genesis'; return [{ signedTransaction: new Uint8Array([4, 5, 6]) }]; });
    await app.click('sign');
    expect(app.fetch.mock.calls).toHaveLength(1); expect(app.report().reason).toContain('changed');
  });

  it('ignores a pending wallet response after the 120 second deadline', async () => {
    let resolve!: (value: unknown) => void;
    const app = browser({ ready: true, sign: vi.fn(() => new Promise((done) => { resolve = done; })) });
    await app.click('connect'); await app.click('prepare'); const pending = app.click('sign');
    await vi.advanceTimersByTimeAsync(120_001); await pending;
    expect(app.report().reason).toContain('Late responses are ignored');
    const failed = app.report(); resolve([{ signedTransaction: new Uint8Array([4, 5, 6]) }]);
    await Promise.resolve(); await Promise.resolve();
    expect(app.report()).toEqual(failed); expect(app.fetch.mock.calls).toHaveLength(1);
  });

  it('ignores a preparation response if inputs changed while the request was pending', async () => {
    const app = browser({ ready: true }); await app.click('connect');
    let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    app.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = app.click('prepare'); app.input('name', 'different-name');
    resolve({ ok: true, json: async () => ({ report: { outcome: 'ready', signatureRequestReady: true }, candidate: app.candidate }) });
    await pending; expect(app.element('sign').disabled).toBe(true); expect(app.element('download').disabled).toBe(true);
    expect(app.element('status').textContent).toContain('discarded');
  });

  it('strips unexpected candidate, token and payload fields from report downloads', async () => {
    const app = browser(); await app.click('connect');
    app.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ report: {
      outcome: 'blocked', costs, candidate: { transactionBase64: 'PRIVATE_BYTES' }, token: 'PRIVATE_TOKEN',
      simulation: { passed: false, signedTransactionBase64: 'PRIVATE_SIGNED', rawPayload: 'PRIVATE_RAW' },
    }, candidate: null }) });
    await app.click('prepare'); await app.click('download');
    expect(await app.blobs[0]!.text()).not.toContain('PRIVATE_');
  });

  it.each(['chain_unavailable', 'expired', 'private-unknown-code'])('keeps HTTP failures classified and excludes raw error text: %s', async (code) => {
    const app = browser(); await app.click('connect');
    app.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code, error: 'PRIVATE_SIGNED_BYTES' }) });
    await app.click('prepare');
    expect(app.report()).toMatchObject({ outcome: 'failed', stage: 'prepare', userSignatureValid: null,
      errorCode: code === 'private-unknown-code' ? 'diagnostic_failed' : code });
    expect(app.element('sign').disabled).toBe(true);
    await app.click('download');
    const exported = await app.blobs[0]!.text();
    expect(exported).not.toContain('PRIVATE_SIGNED_BYTES');
    expect(exported).not.toContain('private-unknown-code');
  });
});
