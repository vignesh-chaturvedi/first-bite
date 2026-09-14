import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, type Signer } from '@solana/web3.js';
import { MAX_TRANSACTION_BYTES, U64_MAX, unsignedBytes, validateUserSignature } from '../cookie/transaction';

export type ExecutionCryptoErrorCode = 'payload_invalid' | 'user_signature_invalid' | 'signing_key_invalid'
  | 'signing_failed' | 'envelope_invalid' | 'recovery_invalid';

/** Errors contain fixed codes only; payloads, keys and upstream errors stay private. */
export class ExecutionCryptoError extends Error {
  constructor(readonly code: ExecutionCryptoErrorCode) {
    super(`Execution crypto failed: ${code}`);
    this.name = 'ExecutionCryptoError';
  }
}

export interface SignedResult {
  signedBase64: string;
  signature: string;
  messageHash: string;
}

export interface RecoveryInput {
  sponsor: string;
  payer: string;
  amount: bigint;
  blockhash: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BASE64_LENGTH = Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodePayload(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_LENGTH
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_TRANSACTION_BYTES || bytes.toString('base64') !== value) throw new Error();
  return bytes;
}

function canonicalKey(value: string, signer = false): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new Error();
  const key = new PublicKey(value);
  if (key.toBase58() !== value || (signer && !PublicKey.isOnCurve(key.toBytes()))) throw new Error();
  return key;
}

function parseCanonicalTransaction(value: string, expectedSigners: number, requireUnsigned: boolean): Transaction {
  const bytes = decodePayload(value);
  // Both templates have a one-byte canonical signature count and legacy header.
  if (bytes[0] !== expectedSigners || bytes[1 + 64 * expectedSigners] !== expectedSigners) throw new Error();
  const tx = Transaction.from(bytes);
  if (tx.signatures.length !== expectedSigners || !unsignedBytes(tx).equals(bytes)) throw new Error();
  if (requireUnsigned && tx.signatures.some(({ signature }) => signature !== null)) throw new Error();
  const signers = tx.signatures.map(({ publicKey }) => publicKey.toBase58());
  if (new Set(signers).size !== expectedSigners || tx.signatures.some(({ publicKey }) => !PublicKey.isOnCurve(publicKey.toBytes()))) throw new Error();
  return tx;
}

function checkedUserPayload(unsignedBase64: string, userSignedBase64: string, user: string): Transaction {
  const prepared = parseCanonicalTransaction(unsignedBase64, 3, true);
  const userKey = canonicalKey(user, true);
  if (prepared.feePayer?.equals(userKey) || !prepared.signatures.some(({ publicKey }) => publicKey.equals(userKey))) throw new Error();
  const returned = parseCanonicalTransaction(userSignedBase64, 3, false);
  return validateUserSignature(prepared, unsignedBytes(returned), userKey);
}

/** Validate only the wallet's signature against the persisted unsigned template. */
export function validateUserPayload(unsignedTransactionBase64: string, userSignedTransactionBase64: string, userPublicKey: string): void {
  try { checkedUserPayload(unsignedTransactionBase64, userSignedTransactionBase64, userPublicKey); }
  catch { throw new ExecutionCryptoError('user_signature_invalid'); }
}

function signerFromCopy(secret: Buffer, expected: PublicKey): Signer {
  try {
    if (secret.length !== 64) throw new Error();
    const key = Keypair.fromSecretKey(secret);
    if (!key.publicKey.equals(expected)) throw new Error();
    return { publicKey: key.publicKey, secretKey: secret };
  } catch { throw new ExecutionCryptoError('signing_key_invalid'); }
}

function copySecret(secret: Uint8Array): Buffer {
  if (!(secret instanceof Uint8Array) || secret.length !== 64) throw new ExecutionCryptoError('signing_key_invalid');
  return Buffer.from(secret);
}

function signatureBase58(signature: Buffer): string {
  if (signature.length !== 64) throw new Error();
  let value = BigInt(`0x${signature.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  let zeroes = 0;
  while (zeroes < signature.length && signature[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + encoded;
}

function finishSigned(tx: Transaction, originalMessage: Buffer): SignedResult {
  if (!tx.serializeMessage().equals(originalMessage) || !tx.verifySignatures(true) || !tx.signature) throw new Error();
  const signed = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  if (signed.length > MAX_TRANSACTION_BYTES) throw new Error();
  return {
    signedBase64: signed.toString('base64'),
    signature: signatureBase58(tx.signature),
    messageHash: createHash('sha256').update(originalMessage).digest('hex'),
  };
}

/** Caller must first validate the persisted quote's registration policy and eligibility. */
export function coSignRegistration(
  unsignedBase64: string, userSignedBase64: string, sponsorSecret: Uint8Array, payerSecret: Uint8Array, user: string,
): SignedResult {
  let sponsorCopy: Buffer | undefined;
  let payerCopy: Buffer | undefined;
  try {
    let tx: Transaction;
    try { tx = checkedUserPayload(unsignedBase64, userSignedBase64, user); }
    catch { throw new ExecutionCryptoError('user_signature_invalid'); }
    const message = tx.serializeMessage();
    const userKey = canonicalKey(user, true);
    const sponsorKey = tx.feePayer!;
    const payerKey = tx.signatures.find(({ publicKey }) => !publicKey.equals(sponsorKey) && !publicKey.equals(userKey))?.publicKey;
    if (!payerKey) throw new Error();
    sponsorCopy = copySecret(sponsorSecret);
    payerCopy = copySecret(payerSecret);
    const sponsor = signerFromCopy(sponsorCopy, sponsorKey);
    const payer = signerFromCopy(payerCopy, payerKey);
    tx.partialSign(sponsor, payer);
    return finishSigned(tx, message);
  } catch (error) {
    if (error instanceof ExecutionCryptoError) throw error;
    throw new ExecutionCryptoError('signing_failed');
  } finally { sponsorCopy?.fill(0); payerCopy?.fill(0); }
}

function wrappingKey(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    key.fill(0);
    throw new Error();
  }
  return key;
}

function payloadContext(operationId: string, purpose: 'user' | 'signed'): Buffer {
  if (typeof operationId !== 'string' || !UUID.test(operationId) || (purpose !== 'user' && purpose !== 'signed')) throw new Error();
  return Buffer.from(JSON.stringify(['first-bite', 'execution-payload', 1, operationId, purpose]), 'utf8');
}

/** Encrypt packet bytes; the distinct AAD prevents use as an attempt-key envelope. */
export function sealPayload(payloadBase64: string, keyBase64: string, operationId: string, purpose: 'user' | 'signed'): string {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    plaintext = decodePayload(payloadBase64);
    key = wrappingKey(keyBase64);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(payloadContext(operationId, purpose));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['fbp1', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  } catch { throw new ExecutionCryptoError('envelope_invalid'); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

function decodePart(value: string, min: number, max: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) throw new Error();
  return bytes;
}

/** Never return plaintext until the GCM tag and operation/purpose binding verify. */
export function openPayload(envelope: string, keyBase64: string, operationId: string, purpose: 'user' | 'signed'): string {
  let key: Buffer | undefined;
  let provisional: Buffer | undefined;
  let final: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    if (typeof envelope !== 'string' || envelope.length > MAX_BASE64_LENGTH + 45) throw new Error();
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'fbp1') throw new Error();
    const nonce = decodePart(parts[1]!, 12, 12);
    const ciphertext = decodePart(parts[2]!, 1, MAX_TRANSACTION_BYTES);
    const tag = decodePart(parts[3]!, 16, 16);
    key = wrappingKey(keyBase64);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(payloadContext(operationId, purpose));
    decipher.setAuthTag(tag);
    provisional = decipher.update(ciphertext);
    final = decipher.final();
    plaintext = Buffer.concat([provisional, final]);
    return plaintext.toString('base64');
  } catch { throw new ExecutionCryptoError('envelope_invalid'); }
  finally { key?.fill(0); provisional?.fill(0); final?.fill(0); plaintext?.fill(0); }
}

function recoveryActors(input: RecoveryInput): { sponsor: PublicKey; payer: PublicKey; blockhash: PublicKey } {
  const sponsor = canonicalKey(input.sponsor, true);
  const payer = canonicalKey(input.payer, true);
  const blockhash = canonicalKey(input.blockhash);
  if (sponsor.equals(payer) || [sponsor, payer].some((key) => key.equals(SystemProgram.programId) || key.equals(ComputeBudgetProgram.programId))
    || typeof input.amount !== 'bigint' || input.amount <= 0n || input.amount > U64_MAX) throw new Error();
  return { sponsor, payer, blockhash };
}

/** Check raw bytes independently of the SDK's builder and instruction decoders. */
export function validateRecoveryMessage(unsignedBase64: string, input: RecoveryInput): void {
  try {
    const { sponsor, payer, blockhash } = recoveryActors(input);
    const bytes = decodePayload(unsignedBase64);
    const transfer = Buffer.alloc(12);
    transfer.writeUInt32LE(2);
    transfer.writeBigUInt64LE(input.amount, 4);
    const expectedMessage = Buffer.concat([
      Buffer.from([2, 0, 2, 4]), // Two writable signers and two readonly program accounts.
      sponsor.toBuffer(), payer.toBuffer(), SystemProgram.programId.toBuffer(), ComputeBudgetProgram.programId.toBuffer(),
      blockhash.toBuffer(),
      Buffer.from([2, 3, 0, 5, 2, 0x20, 0x4e, 0, 0]), // Two instructions; SetComputeUnitLimit(20,000).
      Buffer.from([2, 2, 1, 0, 12]), transfer, // System transfer: payer -> sponsor, exact amount.
    ]);
    const expected = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), expectedMessage]);
    if (!bytes.equals(expected)) throw new Error();
  } catch { throw new ExecutionCryptoError('recovery_invalid'); }
}

export function buildRecoveryTransaction(input: RecoveryInput): { unsignedBase64: string; messageHash: string; messageBase64: string } {
  try {
    const { sponsor, payer } = recoveryActors(input);
    const tx = new Transaction({ feePayer: sponsor, recentBlockhash: input.blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: sponsor, lamports: input.amount }),
    );
    const unsignedBase64 = unsignedBytes(tx).toString('base64');
    validateRecoveryMessage(unsignedBase64, input);
    const message = tx.serializeMessage();
    return { unsignedBase64, messageHash: createHash('sha256').update(message).digest('hex'), messageBase64: message.toString('base64') };
  } catch { throw new ExecutionCryptoError('recovery_invalid'); }
}

export function coSignRecovery(unsignedBase64: string, input: RecoveryInput, sponsorSecret: Uint8Array, payerSecret: Uint8Array): SignedResult {
  let sponsorCopy: Buffer | undefined;
  let payerCopy: Buffer | undefined;
  try {
    validateRecoveryMessage(unsignedBase64, input);
    const tx = parseCanonicalTransaction(unsignedBase64, 2, true);
    const message = tx.serializeMessage();
    sponsorCopy = copySecret(sponsorSecret);
    payerCopy = copySecret(payerSecret);
    tx.partialSign(signerFromCopy(sponsorCopy, canonicalKey(input.sponsor, true)), signerFromCopy(payerCopy, canonicalKey(input.payer, true)));
    return finishSigned(tx, message);
  } catch (error) {
    if (error instanceof ExecutionCryptoError) throw error;
    throw new ExecutionCryptoError('signing_failed');
  } finally { sponsorCopy?.fill(0); payerCopy?.fill(0); }
}
