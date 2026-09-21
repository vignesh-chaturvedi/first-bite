import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerSigner, WorkerSignerError } from '../src/worker/signer';

const sponsor = Keypair.fromSeed(Buffer.alloc(32, 19));
const publicKey = sponsor.publicKey.toBase58();
const encoded = Buffer.from(sponsor.secretKey).toString('base64');
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const noncanonicalPadding = encoded.slice(0, -3) + base64Alphabet[base64Alphabet.indexOf(encoded.at(-3)!) | 1] + '==';

afterEach(() => vi.restoreAllMocks());

describe('worker-only sponsor custody', () => {
  it('loads the expected signer and gives each operation an independent owned copy', () => {
    const signer = loadWorkerSigner(publicKey, { SPONSOR_SECRET_KEY_BASE64: encoded });
    try {
      expect(signer.publicKey).toBe(publicKey);
      expect(Object.isFrozen(signer)).toBe(true);
      const first = signer.secret();
      const second = signer.secret();
      expect(first).not.toBe(second);
      expect(first).toEqual(sponsor.secretKey);
      first.fill(0);
      expect(second).toEqual(sponsor.secretKey);
      second.fill(0);
      const third = signer.secret();
      expect(third).toEqual(sponsor.secretKey);
      third.fill(0);
      expect(JSON.stringify(signer)).toBe(JSON.stringify({ publicKey }));
    } finally { signer.close(); }
  });

  it('clears its retained buffer on close and refuses later signing copies', () => {
    const original = Keypair.fromSecretKey.bind(Keypair);
    let retained: Uint8Array | undefined;
    vi.spyOn(Keypair, 'fromSecretKey').mockImplementation((bytes, options) => {
      retained = bytes;
      return original(bytes, options);
    });
    const signer = loadWorkerSigner(publicKey, { SPONSOR_SECRET_KEY_BASE64: encoded });
    expect(retained).toEqual(Buffer.from(sponsor.secretKey));
    signer.close();
    expect(retained).toEqual(Buffer.alloc(64));
    expect(() => signer.secret()).toThrow(WorkerSignerError);
    expect(() => signer.close()).not.toThrow();
  });

  it.each([
    undefined, null, 123, '', 'secret', encoded.trimEnd() + '\n', encoded.slice(0, -2),
    Buffer.alloc(32, 19).toString('base64'), Buffer.alloc(65, 19).toString('base64'),
    // These padding bits decode to the same bytes but are not canonical base64.
    noncanonicalPadding,
  ])('rejects missing, malformed or noncanonical private-key material without echoing it', (value) => {
    let failure: unknown;
    try { loadWorkerSigner(publicKey, { SPONSOR_SECRET_KEY_BASE64: value }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkerSignerError);
    expect((failure as Error).message).toBe('Worker signing key is unavailable or does not match the configured sponsor');
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(encoded);
  });

  it.each([
    'invalid-expected-key', `1${publicKey}`,
    PublicKey.findProgramAddressSync([Buffer.from('not-a-signer')], SystemProgram.programId)[0].toBase58(),
    Keypair.fromSeed(Buffer.alloc(32, 20)).publicKey.toBase58(),
  ])('rejects an invalid or mismatched expected sponsor', (expected) => {
    expect(() => loadWorkerSigner(expected, { SPONSOR_SECRET_KEY_BASE64: encoded })).toThrow(WorkerSignerError);
  });

  it.each(['mismatched', 'corrupt'] as const)('clears decoded secret material when validation fails (%s)', (mode) => {
    const original = Keypair.fromSecretKey.bind(Keypair);
    let decoded: Uint8Array | undefined;
    vi.spyOn(Keypair, 'fromSecretKey').mockImplementation((bytes, options) => {
      decoded = bytes;
      return original(bytes, options);
    });
    const material = Buffer.from(sponsor.secretKey);
    if (mode === 'corrupt') material[63] = material[63]! ^ 1;
    const expected = mode === 'mismatched' ? Keypair.fromSeed(Buffer.alloc(32, 20)).publicKey.toBase58() : publicKey;
    expect(() => loadWorkerSigner(expected, { SPONSOR_SECRET_KEY_BASE64: material.toString('base64') })).toThrow(WorkerSignerError);
    expect(decoded).toEqual(Buffer.alloc(64));
    material.fill(0);
  });

  it('does not accept NEXT_PUBLIC or legacy sponsor key variables', () => {
    expect(() => loadWorkerSigner(publicKey, {
      NEXT_PUBLIC_SPONSOR_SECRET_KEY_BASE64: encoded, SPONSOR_PRIVATE_KEY: encoded,
    })).toThrow(WorkerSignerError);
  });

  it('redacts an environment accessor failure', () => {
    expect(() => loadWorkerSigner(publicKey, {
      get SPONSOR_SECRET_KEY_BASE64() { throw new Error(`Private backend failure ${encoded}`); },
    })).toThrow(new WorkerSignerError());
  });
});
