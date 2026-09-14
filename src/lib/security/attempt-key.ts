import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SecurityError } from './tokens';

const PREFIX = 'fbak1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function decodeWrappingKey(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    key.fill(0);
    throw new Error();
  }
  return key;
}

function authenticatedContext(preparationId: string, payerPublicKey: string): Buffer {
  if (!UUID.test(preparationId) || new PublicKey(payerPublicKey).toBase58() !== payerPublicKey) throw new Error();
  return Buffer.from(JSON.stringify(['first-bite', 'attempt-key', 1, preparationId, payerPublicKey]), 'utf8');
}

function validateSecret(secret: Uint8Array, payerPublicKey: string): void {
  if (secret.length !== 64 || Keypair.fromSecretKey(secret).publicKey.toBase58() !== payerPublicKey) throw new Error();
}

function decodePart(value: string | undefined, length: number): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error();
  return bytes;
}

/** Wrap only a fresh attempt payer, never a sponsor key. Caller retains its input. */
export function sealAttemptKey(
  secret: Uint8Array, wrappingKey: string, preparationId: string, payerPublicKey: string,
): string {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    if (!(secret instanceof Uint8Array) || secret.length !== 64) throw new Error();
    plaintext = Buffer.from(secret);
    validateSecret(plaintext, payerPublicKey);
    key = decodeWrappingKey(wrappingKey);
    const aad = authenticatedContext(preparationId, payerPublicKey);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [PREFIX, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  } catch { throw new SecurityError('attempt_key_invalid'); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

/** Caller owns the returned secret and must erase it after use. */
export function openAttemptKey(
  envelope: string, wrappingKey: string, preparationId: string, payerPublicKey: string,
): Uint8Array {
  let key: Buffer | undefined;
  let provisional: Buffer | undefined;
  let final: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    // Fixed lengths also prevent oversized ciphertext from reaching the decoder.
    if (typeof envelope !== 'string' || !/^fbak1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{86}\.[A-Za-z0-9_-]{22}$/.test(envelope)) throw new Error();
    const parts = envelope.split('.');
    const nonce = decodePart(parts[1], 12);
    const ciphertext = decodePart(parts[2], 64);
    const tag = decodePart(parts[3], 16);
    key = decodeWrappingKey(wrappingKey);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(authenticatedContext(preparationId, payerPublicKey));
    decipher.setAuthTag(tag);
    provisional = decipher.update(ciphertext);
    final = decipher.final();
    plaintext = Buffer.concat([provisional, final]);
    validateSecret(plaintext, payerPublicKey);
    return new Uint8Array(plaintext);
  } catch { throw new SecurityError('attempt_key_invalid'); }
  finally { key?.fill(0); provisional?.fill(0); final?.fill(0); plaintext?.fill(0); }
}
