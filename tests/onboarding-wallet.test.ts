import { createHash } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSponsoredTransaction, unsignedBytes } from '../src/lib/cookie/transaction';
import { COOKIE_GENESIS_HASH, createNightlyWallet, WalletError } from '../src/lib/onboarding/wallet';

function fixture(options: { standardWrapper?: boolean; legacyFeature?: boolean } = {}) {
  const sponsor = Keypair.generate();
  const payer = Keypair.generate();
  const user = Keypair.generate();
  const transaction = buildSponsoredTransaction({
    label: 'firstbite', sponsor: sponsor.publicKey, attemptPayer: payer.publicKey, user: user.publicKey,
    feeReceiver: Keypair.generate().publicKey, registrationPrice: 15_000_000_000_000n,
    domainRent: 1_927_920n, primaryRent: 1_426_800n, blockhash: Keypair.generate().publicKey.toBase58(),
  });
  const input = {
    wallet: user.publicKey.toBase58(), unsignedTransactionBase64: unsignedBytes(transaction).toString('base64'),
    messageHash: createHash('sha256').update(transaction.serializeMessage()).digest('hex'),
  };
  const account = { address: input.wallet, publicKey: user.publicKey.toBytes() };
  let event: (value: unknown) => void = () => {};
  const signTransaction = vi.fn(async ({ transaction: bytes }: { transaction: Uint8Array }) => {
    const signed = Transaction.from(bytes); signed.partialSign(user);
    return [{ signedTransaction: new Uint8Array(unsignedBytes(signed)) }];
  });
  const connect = vi.fn(async () => ({ accounts: [account] }));
  const disconnect = vi.fn(async () => {});
  const send = vi.fn();
  const removeEvents = vi.fn();
  const features: Record<string, unknown> = {
    'standard:connect': { connect },
    'standard:disconnect': { disconnect },
    'standard:events': { on: vi.fn((_name: string, callback: (value: unknown) => void) => { event = callback; return removeEvents; }) },
    [options.legacyFeature ? 'standard:signTransaction' : 'solana:signTransaction']: { signTransaction },
    'solana:signAndSendTransaction': { signAndSendTransaction: send },
  };
  const standard = { accounts: [account], features };
  const provider = {
    genesisHash: COOKIE_GENESIS_HASH,
    ...(options.standardWrapper ? { standardWallet: standard } : standard),
    changeNetwork: vi.fn(async (_input: unknown) => { provider.genesisHash = COOKIE_GENESIS_HASH; }),
  };
  let injected: unknown = provider;
  const wallet = createNightlyWallet(() => injected);
  return { wallet, provider, standard, features, account, input, signTransaction, connect, disconnect, send, removeEvents, user, sponsor, payer,
    emit: (value: unknown) => event(value), replace: (value: unknown) => { injected = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit Nightly connection and network selection', () => {
  it('detects installation without connecting or prompting automatically', () => {
    const f = fixture();
    expect(f.wallet.snapshot()).toEqual({ installed: true, address: null, genesisHash: COOKIE_GENESIS_HASH, canSign: true });
    expect(f.connect).not.toHaveBeenCalled(); expect(f.signTransaction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(createNightlyWallet(() => null).snapshot().installed).toBe(false);
  });

  it.each([false, true])('connects to the explicit account with standardWallet wrapper=%s', async (standardWrapper) => {
    const f = fixture({ standardWrapper });
    expect((await f.wallet.connect()).address).toBe(f.input.wallet);
    await f.wallet.disconnect();
    expect(f.wallet.snapshot().address).toBeNull(); expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it('requests the exact Cookie genesis and public RPC, then verifies the reported network', async () => {
    const f = fixture(); f.provider.genesisHash = 'different-network';
    expect((await f.wallet.switchToCookie()).genesisHash).toBe(COOKIE_GENESIS_HASH);
    expect(f.provider.changeNetwork).toHaveBeenCalledWith({ genesisHash: COOKIE_GENESIS_HASH, url: 'https://rpc.cookiescan.io' });
    f.provider.genesisHash = 'different-network'; f.provider.changeNetwork.mockImplementation(async () => {});
    await expect(f.wallet.switchToCookie()).rejects.toMatchObject({ code: 'wrong_network' });
  });

  it('handles missing, unsupported and rejected connections with fixed safe errors', async () => {
    await expect(createNightlyWallet(() => null).connect()).rejects.toMatchObject({ code: 'missing' });
    await expect(createNightlyWallet(() => ({})).connect()).rejects.toMatchObject({ code: 'unsupported' });
    const f = fixture(); f.connect.mockRejectedValue({ code: 4001, message: 'sensitive rejected payload' });
    await expect(f.wallet.connect()).rejects.toEqual(new WalletError('rejected'));
    expect(f.wallet.snapshot().address).toBeNull();
  });

  it('rejects inconsistent account bytes and address', async () => {
    const f = fixture(); f.account.publicKey = Keypair.generate().publicKey.toBytes();
    await expect(f.wallet.connect()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('disconnects locally even when the extension disconnect fails', async () => {
    const f = fixture(); await f.wallet.connect(); f.disconnect.mockRejectedValue(new Error('private payload'));
    await expect(f.wallet.disconnect()).rejects.toEqual(new WalletError('unavailable'));
    expect(f.wallet.snapshot().address).toBeNull();
  });

  it('does not restore a pending connection after a local disconnect', async () => {
    const f = fixture(); let resolve!: (result: { accounts: typeof f.account[] }) => void;
    f.connect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = f.wallet.connect(); await Promise.resolve(); await f.wallet.disconnect(); resolve({ accounts: [f.account] });
    await expect(pending).rejects.toMatchObject({ code: 'changed' });
    expect(f.wallet.snapshot().address).toBeNull();
  });

  it('bounds wallet prompts and drops late connection results', async () => {
    vi.useFakeTimers(); const f = fixture(); let resolve!: (result: { accounts: typeof f.account[] }) => void;
    f.connect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = expect(f.wallet.connect()).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    resolve({ accounts: [f.account] }); await Promise.resolve();
    expect(f.wallet.snapshot().address).toBeNull();
  });

  it('reports account/network changes and tears down polling after unsubscribe', async () => {
    vi.useFakeTimers(); const f = fixture({ standardWrapper: true }); await f.wallet.connect();
    const changed = vi.fn(); const unsubscribe = f.wallet.subscribe(changed);
    const other = Keypair.generate();
    f.standard.accounts = [{ address: other.publicKey.toBase58(), publicKey: other.publicKey.toBytes() }];
    f.emit({ accounts: f.standard.accounts });
    expect(f.wallet.snapshot().address).toBe(other.publicKey.toBase58()); expect(changed).toHaveBeenCalled();
    f.provider.genesisHash = 'other'; await vi.advanceTimersByTimeAsync(500);
    expect(f.wallet.snapshot().genesisHash).toBe('other');
    unsubscribe(); expect(vi.getTimerCount()).toBe(0); expect(f.removeEvents).toHaveBeenCalledOnce();
  });
});

describe('browser transaction signature boundary', () => {
  it.each([false, true])('verifies a user-only signature using legacy feature=%s without sending', async (legacyFeature) => {
    const f = fixture({ legacyFeature }); await f.wallet.connect();
    const result = await f.wallet.sign(f.input);
    const tx = Transaction.from(Buffer.from(result, 'base64'));
    expect(tx.serializeMessage().equals(Buffer.from(f.input.unsignedTransactionBase64, 'base64').subarray(193))).toBe(true);
    expect(tx.verifySignatures(false)).toBe(true);
    expect(tx.signatures.filter((signature) => signature.signature)).toHaveLength(1);
    expect(f.signTransaction).toHaveBeenCalledWith({ account: f.account, transaction: expect.any(Uint8Array) });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('requires explicit connection, matching wallet, exact network and signing support', async () => {
    const f = fixture();
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'wrong_wallet' });
    await f.wallet.connect();
    await expect(f.wallet.sign({ ...f.input, wallet: f.sponsor.publicKey.toBase58() })).rejects.toMatchObject({ code: 'wrong_wallet' });
    f.provider.genesisHash = 'Solana';
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'wrong_network' });
    f.provider.genesisHash = COOKIE_GENESIS_HASH; delete f.features['solana:signTransaction'];
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.signTransaction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it('refuses signing if WebCrypto Ed25519 is unavailable', async () => {
    const f = fixture(); await f.wallet.connect(); vi.stubGlobal('crypto', {});
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses a feature advertising only versioned transactions', async () => {
    const f = fixture(); await f.wallet.connect();
    f.features['solana:signTransaction'] = { signTransaction: f.signTransaction, supportedTransactionVersions: [0] };
    expect(f.wallet.snapshot().canSign).toBe(false);
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects a mismatched message hash before requesting a signature', async () => {
    const f = fixture(); await f.wallet.connect();
    await expect(f.wallet.sign({ ...f.input, messageHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects noncanonical base64, oversize, trailing, versioned and noncanonical shortvec packets', async () => {
    const f = fixture(); await f.wallet.connect(); const bytes = Buffer.from(f.input.unsignedTransactionBase64, 'base64');
    const versioned = Buffer.from(bytes); versioned[193] = 0x80;
    for (const value of [f.input.unsignedTransactionBase64 + '\n', '', 'AR==', Buffer.alloc(1233).toString('base64'),
      Buffer.concat([bytes, Buffer.from([0])]).toString('base64'), versioned.toString('base64'),
      Buffer.concat([Buffer.from([0x83, 0]), bytes.subarray(1)]).toString('base64')]) {
      await expect(f.wallet.sign({ ...f.input, unsignedTransactionBase64: value })).rejects.toMatchObject({ code: 'invalid_transaction' });
    }
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects a prepared packet that already contains any signature', async () => {
    const f = fixture(); await f.wallet.connect();
    const tx = Transaction.from(Buffer.from(f.input.unsignedTransactionBase64, 'base64')); tx.partialSign(f.sponsor);
    await expect(f.wallet.sign({ ...f.input, unsignedTransactionBase64: unsignedBytes(tx).toString('base64') }))
      .rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects the user as sponsor/fee payer even if the prepared hash matches', async () => {
    const f = fixture(); await f.wallet.connect();
    const tx = Transaction.from(Buffer.from(f.input.unsignedTransactionBase64, 'base64')); tx.feePayer = f.user.publicKey;
    await expect(f.wallet.sign({ ...f.input, unsignedTransactionBase64: unsignedBytes(tx).toString('base64'),
      messageHash: createHash('sha256').update(tx.serializeMessage()).digest('hex') })).rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.signTransaction).not.toHaveBeenCalled();
  });

  it.each(['message', 'signature', 'sponsor', 'payer', 'missing'] as const)('rejects a wallet returning %s mutation', async (mutation) => {
    const f = fixture(); await f.wallet.connect();
    f.signTransaction.mockImplementation(async ({ transaction }) => {
      const tx = Transaction.from(transaction);
      if (mutation === 'message') tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
      if (mutation !== 'missing') tx.partialSign(f.user);
      if (mutation === 'signature') tx.signatures.find(({ publicKey }) => publicKey.equals(f.user.publicKey))!.signature = Buffer.alloc(64, 1);
      if (mutation === 'sponsor') tx.partialSign(f.sponsor);
      if (mutation === 'payer') tx.partialSign(f.payer);
      return [{ signedTransaction: new Uint8Array(unsignedBytes(tx)) }];
    });
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'invalid_transaction' }); expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['network', 'account', 'roundtrip', 'provider'] as const)('invalidates an in-flight signature after %s changes', async (mutation) => {
    const f = fixture({ standardWrapper: true }); await f.wallet.connect();
    const original = f.signTransaction.getMockImplementation()!;
    f.signTransaction.mockImplementation(async (input) => {
      if (mutation === 'network') f.provider.genesisHash = 'wrong';
      if (mutation === 'account') f.standard.accounts = [];
      if (mutation === 'roundtrip') { f.emit({ accounts: [] }); f.emit({ accounts: [f.account] }); }
      if (mutation === 'provider') f.replace({ ...f.provider });
      return original(input);
    });
    await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'changed' }); expect(f.send).not.toHaveBeenCalled();
  });

  it('returns a safe rejection without the provider message or signed data', async () => {
    const f = fixture(); await f.wallet.connect(); f.signTransaction.mockRejectedValue(new Error('User rejected SECRET_PAYLOAD'));
    await expect(f.wallet.sign(f.input)).rejects.toEqual(new WalletError('rejected'));
  });

  it('requires a single well-formed signed packet response', async () => {
    const f = fixture(); await f.wallet.connect();
    for (const output of [[], [{ signedTransaction: new Uint8Array(1_233) }]]) {
      f.signTransaction.mockResolvedValue(output);
      await expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'invalid_transaction' });
    }
  });

  it('owns the wallet response before awaiting signature verification', async () => {
    const f = fixture(); await f.wallet.connect();
    let external = new Uint8Array();
    const originalSign = f.signTransaction.getMockImplementation()!;
    f.signTransaction.mockImplementation(async (input) => {
      const result = await originalSign(input); external = result[0]!.signedTransaction; return result;
    });
    const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'verify').mockImplementation(async (...args) => {
      external.fill(0); return verify(...args);
    });
    const result = await f.wallet.sign(f.input);
    expect(Transaction.from(Buffer.from(result, 'base64')).verifySignatures(false)).toBe(true);
    expect(external.every((byte) => byte === 0)).toBe(true);
  });

  it('bounds an unanswered signing prompt without sending or retaining a late signature', async () => {
    const f = fixture(); await f.wallet.connect(); vi.useFakeTimers();
    let resolve!: (result: { signedTransaction: Uint8Array<ArrayBuffer> }[]) => void;
    f.signTransaction.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = expect(f.wallet.sign(f.input)).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitUntil(() => f.signTransaction.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    resolve([{ signedTransaction: new Uint8Array() }]); await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(f.removeEvents).toHaveBeenCalledOnce();
  });
});
