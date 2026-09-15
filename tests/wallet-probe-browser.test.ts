import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Execute the shipped inline script against a minimal DOM and synthetic wallet.
// No extension, real wallet or RPC is involved in these regression checks.
const page = readFileSync('scripts/phase0/wallet-probe.html', 'utf8');
const script = page.match(/<script nonce="__NONCE__">([\s\S]+)<\/script>/)![1]!;
const candidate = {
  id: 'probe-id', wallet: 'test-wallet', name: 'probe.cook', mode: 'user-first',
  messageSha256: 'test-digest', transactionBase64: 'AQID',
};

function browser(sign = vi.fn(async (): Promise<unknown> => { throw { message: 'User rejected approval', data: 'PRIVATE_SIGNED_BYTES' }; })) {
  const elements = new Map<string, {
    textContent: string; disabled: boolean; value: string;
    classList: { toggle: () => void };
    listeners: Record<string, () => unknown>;
    addEventListener: (event: string, fn: () => unknown) => void;
  }>();
  function element(id: string) {
    if (!elements.has(id)) {
      const listeners: Record<string, () => unknown> = {};
      elements.set(id, { textContent: '', disabled: false, value: 'user-first', classList: { toggle() {} }, listeners,
        addEventListener: (event, fn) => { listeners[event] = fn; } });
    }
    return elements.get(id)!;
  }
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  const blobs: Blob[] = [];
  const provider = {
    genesisHash: 'cookie-genesis', changeNetwork: vi.fn(async () => {}),
    features: {
      'standard:connect': { connect: vi.fn(async () => ({ accounts: [{ address: 'test-wallet' }] })) },
      'solana:signTransaction': { signTransaction: sign },
    },
  };
  const fetch = vi.fn(async (path: string) => ({ ok: true, json: async () => path === '/prepare' ? candidate : {
    userSignatureValid: true, messageUnchanged: true, sponsorSignaturePresent: false,
    phase0GateComplete: false, broadcast: false, registrationCompleted: false,
  } }));
  runInNewContext(script.replace('__BOOTSTRAP__', JSON.stringify({ token: 'PRIVATE_SESSION_TOKEN', genesisHash: 'cookie-genesis', rpcUrl: 'https://rpc.example' })), {
    window: { nightly: { solana: provider } },
    document: { getElementById: element, createElement: () => link, body: { appendChild: vi.fn() } },
    navigator: { userAgent: 'Synthetic browser' }, fetch, Blob, Uint8Array, AbortSignal, atob, btoa,
    URL: { createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL: vi.fn() },
    setTimeout, clearTimeout,
  });
  return { element, link, blobs, provider, fetch,
    click: async (id: string) => { await element(id).listeners.click!(); },
    report: () => JSON.parse(element('result').textContent),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('wallet diagnostic browser failure evidence', () => {
  it('exports a rejected attempt without claiming user cancellation or leaking payloads', async () => {
    vi.useFakeTimers();
    const app = browser();
    await app.click('connect');
    await app.click('prepare');
    await app.click('sign');
    expect(app.report()).toMatchObject({ outcome: 'failed', stage: 'sign', name: 'probe.cook', messageSha256: 'test-digest',
      userSignatureValid: null, messageUnchanged: null, phase0GateComplete: false, broadcast: false });
    expect(app.report().reason).toContain('does not establish whether the user cancelled');
    expect(app.element('download').disabled).toBe(false);
    expect(app.fetch.mock.calls.map(([path]) => path)).toEqual(['/prepare']);
    await app.click('download');
    expect(app.link.download).toBe('nightly-signature-probe-failed.json');
    expect(app.link.click).toHaveBeenCalledOnce();
    const exported = await app.blobs[0]!.text();
    expect(JSON.parse(exported)).toEqual(app.report());
    for (const secret of ['PRIVATE_SIGNED_BYTES', 'PRIVATE_SESSION_TOKEN', 'transactionBase64', 'AQID']) expect(exported).not.toContain(secret);
  });

  it('times out a pending signer and ignores a late signature without verifying it', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const app = browser(vi.fn(() => new Promise((done) => { resolve = done; })));
    await app.click('connect');
    await app.click('prepare');
    const pending = app.click('sign');
    expect(app.element('prepare').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
    const failed = app.report();
    expect(failed.reason).toContain('Close its pending prompt');
    expect(app.element('download').disabled).toBe(false);
    expect(app.element('prepare').disabled).toBe(false);
    resolve([{ signedTransaction: new Uint8Array([1, 2, 3]) }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(app.report()).toEqual(failed);
    expect(app.fetch.mock.calls.map(([path]) => path)).toEqual(['/prepare']);
  });

  it('keeps verification failures unverified even after the wallet returned bytes', async () => {
    const app = browser(vi.fn(async () => [{ signedTransaction: new Uint8Array([1, 2, 3]) }]));
    await app.click('connect');
    await app.click('prepare');
    app.fetch.mockImplementationOnce(async () => { throw new Error('transport error PRIVATE_SIGNED_BYTES'); });
    await app.click('sign');
    expect(app.report()).toMatchObject({ outcome: 'failed', stage: 'verify', userSignatureValid: null, messageUnchanged: null, phase0GateComplete: false });
    expect(app.element('result').textContent).not.toContain('PRIVATE_SIGNED_BYTES');
  });

  it('replaces prior success with failure and clears reports when starting a new test', async () => {
    const sign = vi.fn(async (): Promise<unknown> => [{ signedTransaction: new Uint8Array([1, 2, 3]) }]);
    const app = browser(sign);
    await app.click('connect');
    await app.click('prepare');
    await app.click('sign');
    expect(app.report()).toMatchObject({ outcome: 'passed', userSignatureValid: true, phase0GateComplete: false });
    await app.click('prepare');
    expect(app.element('download').disabled).toBe(true);
    expect(app.element('result').textContent).not.toContain('passed');
    sign.mockRejectedValueOnce('AccountNotFound');
    await app.click('sign');
    expect(app.report()).toMatchObject({ outcome: 'failed', userSignatureValid: null });
    expect(app.report().reason).toContain('AccountNotFound');
    app.element('mode').listeners.change!();
    expect(app.element('download').disabled).toBe(true);
    expect(app.element('sign').disabled).toBe(true);
    expect(app.element('result').textContent).not.toContain('failed');
  });

  it('exports a network timeout with no invented prepared-transaction evidence', async () => {
    vi.useFakeTimers();
    const app = browser();
    app.provider.changeNetwork.mockImplementationOnce(() => new Promise(() => {}));
    const pending = app.click('network');
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
    expect(app.report()).toMatchObject({ outcome: 'failed', stage: 'network', wallet: null, name: null, messageSha256: null });
    expect(app.element('connect').disabled).toBe(false);
    expect(app.element('download').disabled).toBe(false);
  });
});
