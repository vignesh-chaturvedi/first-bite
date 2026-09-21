import { Keypair, PublicKey } from '@solana/web3.js';
import type { ExecutionSigner } from '../lib/execution/types';

/** Never include environment values or upstream parser errors in this error. */
export class WorkerSignerError extends Error {
  constructor() {
    super('Worker signing key is unavailable or does not match the configured sponsor');
    this.name = 'WorkerSignerError';
  }
}

export type WorkerSigner = ExecutionSigner & { close(): void };

/**
 * Loaded only by an explicitly enabled execution worker, never the web service.
 * Each operation receives a separate copy and owns clearing it after signing.
 * Buffer erasure is best effort: JS strings and crypto internals are not locked
 * memory and may retain copies until their runtime releases them.
 */
export function loadWorkerSigner(expectedPublicKey: string, environment: Record<string, unknown> = process.env): WorkerSigner {
  let ownedSecret: Buffer | undefined;
  try {
    if (typeof expectedPublicKey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedPublicKey)) throw new WorkerSignerError();
    const expected = new PublicKey(expectedPublicKey);
    if (expected.toBase58() !== expectedPublicKey || !PublicKey.isOnCurve(expected.toBytes())) throw new WorkerSignerError();
    const encoded = environment.SPONSOR_SECRET_KEY_BASE64;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new WorkerSignerError();
    ownedSecret = Buffer.from(encoded, 'base64');
    if (ownedSecret.length !== 64 || ownedSecret.toString('base64') !== encoded
      || !Keypair.fromSecretKey(ownedSecret).publicKey.equals(expected)) throw new WorkerSignerError();
    const secret = ownedSecret;
    let closed = false;
    return Object.freeze({
      publicKey: expectedPublicKey,
      secret(): Uint8Array {
        if (closed) throw new WorkerSignerError();
        return new Uint8Array(secret);
      },
      close(): void {
        closed = true;
        secret.fill(0);
      },
    });
  } catch {
    ownedSecret?.fill(0);
    throw new WorkerSignerError();
  }
}
