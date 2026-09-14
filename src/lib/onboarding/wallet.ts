// Browser-only boundary. Do not import server code, Node crypto, or a sending adapter here.
export const COOKIE_GENESIS_HASH = '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2';
const COOKIE_RPC_URL = 'https://rpc.cookiescan.io';
const WALLET_TIMEOUT_MS = 60_000;
const MAX_PACKET_BYTES = 1_232;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface WalletSnapshot {
  installed: boolean;
  address: string | null;
  genesisHash: string | null;
  canSign: boolean;
}

type WalletErrorCode = 'missing' | 'unsupported' | 'rejected' | 'wrong_network' | 'wrong_wallet'
  | 'changed' | 'invalid_transaction' | 'unavailable';

export class WalletError extends Error {
  constructor(readonly code: WalletErrorCode) {
    super(code);
    this.name = 'WalletError';
  }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object'
  ? value as RecordValue : null;
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);
const zero = (value: Uint8Array) => value.every((byte) => byte === 0);
const invalid = (): never => { throw new WalletError('invalid_transaction'); };

function base58(bytes: Uint8Array): string {
  let number = bytes.reduce((value, byte) => value * 256n + BigInt(byte), 0n);
  let result = '';
  while (number > 0n) { result = BASE58[Number(number % 58n)]! + result; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_644
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid();
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); } catch { return invalid(); }
  if (bytes.length > MAX_PACKET_BYTES || toBase64(bytes) !== value) invalid();
  return bytes;
}

/** Parse canonical legacy packets without a Node Buffer/polyfill in the client bundle. */
function packet(bytes: Uint8Array) {
  if (bytes.length > MAX_PACKET_BYTES || bytes.length < 197 || bytes[0] !== 3) invalid();
  const message = bytes.slice(193);
  let offset = 0;
  function byte(): number { if (offset >= message.length) invalid(); return message[offset++]!; }
  function shortvec(): number {
    let value = 0;
    for (let index = 0; index < 3; index++) {
      const part = byte();
      if (index === 2 && part > 3) invalid();
      value |= (part & 127) << (index * 7);
      if ((part & 128) === 0) { if (index > 0 && part === 0) invalid(); return value; }
    }
    return invalid();
  }
  function take(length: number): Uint8Array {
    if (offset + length > message.length) invalid();
    const value = message.slice(offset, offset + length); offset += length; return value;
  }
  if (byte() !== 3 || byte() !== 0) invalid();
  const readonlyUnsigned = byte();
  const count = shortvec();
  if (count < 3 || count > 256 || readonlyUnsigned > count - 3) invalid();
  const keys = Array.from({ length: count }, () => take(32));
  if (new Set(keys.map(base58)).size !== count) invalid();
  take(32); // Existing blockhash is part of the exact message; never replace it.
  const instructionCount = shortvec();
  if (instructionCount === 0 || instructionCount > message.length) invalid();
  for (let index = 0; index < instructionCount; index++) {
    if (byte() >= count) invalid();
    for (const account of take(shortvec())) if (account >= count) invalid();
    take(shortvec());
  }
  if (offset !== message.length) invalid();
  return { message, keys, signatures: [bytes.slice(1, 65), bytes.slice(65, 129), bytes.slice(129, 193)] };
}

function publicAccount(value: unknown): RecordValue | null {
  const account = record(value);
  if (!account || typeof account.address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account.address)) return null;
  if (account.publicKey !== undefined && (!(account.publicKey instanceof Uint8Array)
    || account.publicKey.length !== 32 || base58(account.publicKey) !== account.address)) return null;
  return account;
}

function mappedError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  const value = record(error);
  const code = value?.code;
  // Only inspect known rejection metadata; never expose a provider's payload/message.
  const message = typeof value?.message === 'string' ? value.message : '';
  return new WalletError(code === 4001 || code === '4001' || /reject|denied|declin|cancel/i.test(message)
    ? 'rejected' : 'unavailable');
}

async function bounded<T>(action: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WalletError('unavailable')), WALLET_TIMEOUT_MS); }),
    ]);
  } catch (error) { throw mappedError(error); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Nightly prompts happen only through explicit connect, switch, and sign calls. */
export function createNightlyWallet(getProvider: () => unknown = () => {
  if (typeof window === 'undefined') return null;
  return record(record(window as unknown)?.nightly)?.solana;
}) {
  let connected = false;
  let cachedAccount: RecordValue | null = null;
  let currentProvider: RecordValue | null = null;
  let eventOff: (() => void) | null = null;
  let generation = 0;
  let connectionIntent = 0;
  let lastState = '';
  let interval: ReturnType<typeof setInterval> | undefined;
  let pending = 0;
  const listeners = new Set<() => void>();

  function detect() {
    const injected = record(getProvider());
    const standard = record(injected?.standardWallet) ?? injected;
    const features = record(standard?.features) ?? record(injected?.features) ?? {};
    const sign = record(features['solana:signTransaction']) ?? record(features['standard:signTransaction']);
    return { injected, standard, features, sign };
  }

  function publish() { for (const listener of listeners) listener(); }

  function observe(): WalletSnapshot {
    try {
      const { injected, standard, features, sign } = detect();
      if (injected !== currentProvider) {
        eventOff?.(); eventOff = null;
        currentProvider = injected; connected = false; cachedAccount = null; generation++;
      }
      if (!eventOff && (listeners.size > 0 || pending > 0)) {
        const events = record(features['standard:events']);
        if (typeof events?.on === 'function') {
          const off = events.on.call(events, 'change', (change: unknown) => {
            const data = record(change);
            if (Array.isArray(data?.accounts) && connected) cachedAccount = publicAccount(data.accounts[0]);
            generation++;
            observe(); publish();
          });
          eventOff = typeof off === 'function' ? off as () => void : () => {};
        }
      }
      if (connected && Array.isArray(standard?.accounts)) cachedAccount = publicAccount(standard.accounts[0]);
      const state: WalletSnapshot = {
        installed: !!injected,
        address: connected && typeof cachedAccount?.address === 'string' ? cachedAccount.address : null,
        genesisHash: typeof injected?.genesisHash === 'string' ? injected.genesisHash : null,
        canSign: typeof sign?.signTransaction === 'function' && (sign.supportedTransactionVersions === undefined
          || Array.isArray(sign.supportedTransactionVersions) && sign.supportedTransactionVersions.includes('legacy')),
      };
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) { lastState = serialized; generation++; }
      return state;
    } catch { return { installed: false, address: null, genesisHash: null, canSign: false }; }
  }

  function monitoring() {
    if ((listeners.size > 0 || pending > 0) && interval === undefined) {
      observe();
      interval = setInterval(() => { const before = generation; observe(); if (generation !== before) publish(); }, 500);
    } else if (listeners.size === 0 && pending === 0) {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined; eventOff?.(); eventOff = null;
    }
  }

  function requireProvider() {
    const state = observe();
    if (!state.installed) throw new WalletError('missing');
    return detect();
  }

  function assertReady(wallet: string, expectedGeneration?: number) {
    const state = observe();
    if (expectedGeneration !== undefined && expectedGeneration !== generation) throw new WalletError('changed');
    if (!state.installed) throw new WalletError('missing');
    if (state.address !== wallet) throw new WalletError('wrong_wallet');
    if (state.genesisHash !== COOKIE_GENESIS_HASH) throw new WalletError('wrong_network');
    if (!state.canSign) throw new WalletError('unsupported');
  }

  return {
    snapshot: observe,
    async connect(): Promise<WalletSnapshot> {
      const intent = ++connectionIntent;
      const { injected, features } = requireProvider();
      const connection = record(features['standard:connect']);
      if (typeof connection?.connect !== 'function') throw new WalletError('unsupported');
      const result = record(await bounded(() => (connection.connect as () => unknown).call(connection)));
      if (intent !== connectionIntent || detect().injected !== injected) throw new WalletError('changed');
      cachedAccount = publicAccount(Array.isArray(result?.accounts) ? result.accounts[0] : null);
      if (!cachedAccount) throw new WalletError('unsupported');
      connected = true;
      const state = observe(); publish(); return state;
    },
    async switchToCookie(): Promise<WalletSnapshot> {
      const { injected } = requireProvider();
      if (typeof injected?.changeNetwork !== 'function') throw new WalletError('unsupported');
      await bounded(() => (injected.changeNetwork as (input: unknown) => unknown).call(injected,
        { genesisHash: COOKIE_GENESIS_HASH, url: COOKIE_RPC_URL }));
      const state = observe(); publish();
      if (detect().injected !== injected) throw new WalletError('changed');
      if (state.genesisHash !== COOKIE_GENESIS_HASH) throw new WalletError('wrong_network');
      return state;
    },
    async disconnect(): Promise<void> {
      connectionIntent++;
      const { features } = detect();
      const disconnection = record(features['standard:disconnect']);
      connected = false; cachedAccount = null; generation++; observe(); publish();
      if (typeof disconnection?.disconnect === 'function') {
        await bounded(() => (disconnection.disconnect as () => unknown).call(disconnection));
      }
    },
    async sign(input: { wallet: string; unsignedTransactionBase64: string; messageHash: string }): Promise<string> {
      assertReady(input.wallet);
      const started = generation;
      const bytes = fromBase64(input.unsignedTransactionBase64);
      const prepared = packet(bytes);
      const userIndex = prepared.keys.slice(0, 3).findIndex((key) => base58(key) === input.wallet);
      if (userIndex < 1 || !prepared.signatures.every(zero) || !/^[a-f0-9]{64}$/.test(input.messageHash)) invalid();
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) throw new WalletError('unsupported');
      let key: CryptoKey;
      try { key = await subtle.importKey('raw', new Uint8Array(prepared.keys[userIndex]!), { name: 'Ed25519' }, false, ['verify']); }
      catch { throw new WalletError('unsupported'); }
      const hash = Array.from(new Uint8Array(await subtle.digest('SHA-256', prepared.message)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== input.messageHash) invalid();
      assertReady(input.wallet, started);
      const { sign } = detect();
      const account = cachedAccount;
      pending++; monitoring();
      try {
        // Cookie is selected via genesis. Never invent a standard Solana chain enum or use sign-and-send.
        const output = await bounded(() => (sign!.signTransaction as (value: unknown) => unknown).call(sign,
          { account, transaction: bytes.slice() }));
        assertReady(input.wallet, started);
        const signed = Array.isArray(output) && output.length === 1 ? record(output[0])?.signedTransaction : null;
        const signedBytes = signed instanceof Uint8Array ? signed.slice() : invalid();
        const returned = packet(signedBytes);
        if (!equal(prepared.message, returned.message) || returned.signatures.some((value, index) => index !== userIndex && !zero(value))
          || zero(returned.signatures[userIndex]!)) invalid();
        let valid: boolean;
        try { valid = await subtle.verify('Ed25519', key, returned.signatures[userIndex]!, returned.message); }
        catch { throw new WalletError('unsupported'); }
        if (!valid) invalid();
        assertReady(input.wallet, started);
        return toBase64(signedBytes);
      } catch (error) { throw mappedError(error); }
      finally { pending--; monitoring(); }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener); observe(); monitoring();
      return () => { listeners.delete(listener); monitoring(); };
    },
  };
}
