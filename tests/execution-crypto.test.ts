import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildSponsoredTransaction, U64_MAX, unsignedBytes } from '../src/lib/cookie/transaction';
import { sealAttemptKey } from '../src/lib/security/attempt-key';
import {
  buildRecoveryTransaction, coSignRecovery, coSignRegistration, ExecutionCryptoError, openPayload,
  sealPayload, validateRecoveryMessage, validateUserPayload,
} from '../src/lib/execution/crypto';

function registration() {
  const sponsor = Keypair.generate();
  const payer = Keypair.generate();
  const user = Keypair.generate();
  const input = {
    label: 'firstbite', sponsor: sponsor.publicKey, attemptPayer: payer.publicKey, user: user.publicKey,
    feeReceiver: Keypair.generate().publicKey, registrationPrice: 15_000_000_000_000n,
    domainRent: 1_927_920n, primaryRent: 1_426_800n, blockhash: Keypair.generate().publicKey.toBase58(),
  };
  const prepared = buildSponsoredTransaction(input);
  const unsigned = unsignedBytes(prepared).toString('base64');
  prepared.partialSign(user);
  const userSigned = unsignedBytes(prepared).toString('base64');
  return { sponsor, payer, user, input, unsigned, userSigned };
}

function recovery() {
  const sponsor = Keypair.generate();
  const payer = Keypair.generate();
  const input = { sponsor: sponsor.publicKey.toBase58(), payer: payer.publicKey.toBase58(), amount: 1_234_567_890n, blockhash: Keypair.generate().publicKey.toBase58() };
  return { sponsor, payer, input, ...buildRecoveryTransaction(input) };
}

function mutatePacket(base64: string, transform: (tx: Transaction) => void): string {
  const tx = Transaction.from(Buffer.from(base64, 'base64'));
  transform(tx);
  return unsignedBytes(tx).toString('base64');
}

describe('registration signing boundary', () => {
  it('adds server signatures to exactly the persisted message and preserves the user signature', () => {
    const f = registration();
    const sponsorSecret = f.sponsor.secretKey;
    const payerSecret = f.payer.secretKey;
    const originalSponsor = sponsorSecret.slice();
    const originalPayer = payerSecret.slice();
    validateUserPayload(f.unsigned, f.userSigned, f.user.publicKey.toBase58());
    const signed = coSignRegistration(f.unsigned, f.userSigned, sponsorSecret, payerSecret, f.user.publicKey.toBase58());
    const tx = Transaction.from(Buffer.from(signed.signedBase64, 'base64'));
    const returned = Transaction.from(Buffer.from(f.userSigned, 'base64'));
    expect(tx.serializeMessage()).toEqual(returned.serializeMessage());
    expect(tx.recentBlockhash).toBe(f.input.blockhash);
    expect(tx.signatures.find(({ publicKey }) => publicKey.equals(f.user.publicKey))!.signature)
      .toEqual(returned.signatures.find(({ publicKey }) => publicKey.equals(f.user.publicKey))!.signature);
    expect(tx.verifySignatures(true)).toBe(true);
    expect(signed.signature).toBe(getBase58Decoder().decode(tx.signature!));
    expect(signed.messageHash).toBe(createHash('sha256').update(tx.serializeMessage()).digest('hex'));
    expect(sponsorSecret).toEqual(originalSponsor);
    expect(payerSecret).toEqual(originalPayer);
    expect(coSignRegistration(f.unsigned, f.userSigned, sponsorSecret, payerSecret, f.user.publicKey.toBase58())).toEqual(signed);
  });

  it('rejects unsigned, wrong-user, corrupt and additional server signatures', () => {
    const f = registration();
    const user = f.user.publicKey.toBase58();
    const corrupt = mutatePacket(f.userSigned, (tx) => { tx.signatures.find(({ publicKey }) => publicKey.equals(f.user.publicKey))!.signature = Buffer.alloc(64, 1); });
    const sponsorSigned = mutatePacket(f.userSigned, (tx) => { tx.partialSign(f.sponsor); });
    const payerSigned = mutatePacket(f.userSigned, (tx) => { tx.partialSign(f.payer); });
    for (const invalid of [f.unsigned, corrupt, sponsorSigned, payerSigned]) {
      expect(() => validateUserPayload(f.unsigned, invalid, user)).toThrow(new ExecutionCryptoError('user_signature_invalid'));
    }
    expect(() => validateUserPayload(f.unsigned, f.userSigned, Keypair.generate().publicKey.toBase58())).toThrow(ExecutionCryptoError);
    expect(() => validateUserPayload(f.unsigned, f.userSigned, f.sponsor.publicKey.toBase58())).toThrow(ExecutionCryptoError);
    expect(() => validateUserPayload(f.userSigned, f.userSigned, user)).toThrow(ExecutionCryptoError);
  });

  it('rejects wallets changing the blockhash, fee payer, transfer or instruction list', () => {
    const f = registration();
    for (const change of [
      { blockhash: Keypair.generate().publicKey.toBase58() },
      { sponsor: Keypair.generate().publicKey },
      { primaryRent: f.input.primaryRent + 1n },
    ]) {
      const altered = buildSponsoredTransaction({ ...f.input, ...change });
      altered.partialSign(f.user);
      expect(() => validateUserPayload(f.unsigned, unsignedBytes(altered).toString('base64'), f.user.publicKey.toBase58())).toThrow(ExecutionCryptoError);
    }
    const altered = buildSponsoredTransaction(f.input).add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }));
    altered.partialSign(f.user);
    expect(() => validateUserPayload(f.unsigned, unsignedBytes(altered).toString('base64'), f.user.publicKey.toBase58())).toThrow(ExecutionCryptoError);
  });

  it('rejects noncanonical, oversized, trailing and versioned packet representations', () => {
    const f = registration();
    const decoded = Buffer.from(f.userSigned, 'base64');
    const versioned = Buffer.from(decoded);
    versioned[193] = 0x80;
    const shortvec = Buffer.concat([Buffer.from([0x83, 0]), decoded.subarray(1)]);
    const invalid = [f.userSigned + '\n', f.userSigned + '=', '', 'not a packet', Buffer.alloc(1_233).toString('base64'),
      Buffer.concat([decoded, Buffer.from([0])]).toString('base64'), versioned.toString('base64'), shortvec.toString('base64')];
    for (const value of invalid) {
      expect(() => validateUserPayload(f.unsigned, value, f.user.publicKey.toBase58())).toThrow(new ExecutionCryptoError('user_signature_invalid'));
    }
  });

  it('rejects swapped, corrupt, short or unrelated signing secrets without mutating the caller', () => {
    const f = registration();
    const sponsorSecret = f.sponsor.secretKey;
    const corrupted = f.payer.secretKey;
    corrupted[0] = corrupted[0]! ^ 0xff;
    const original = corrupted.slice();
    for (const [sponsor, payer] of [
      [f.payer.secretKey, sponsorSecret], [sponsorSecret, corrupted],
      [sponsorSecret, new Uint8Array(32)], [Keypair.generate().secretKey, f.payer.secretKey],
    ]) {
      expect(() => coSignRegistration(f.unsigned, f.userSigned, sponsor!, payer!, f.user.publicKey.toBase58()))
        .toThrow(new ExecutionCryptoError('signing_key_invalid'));
    }
    expect(corrupted).toEqual(original);
    expect(sponsorSecret).toEqual(f.sponsor.secretKey);
  });

  it('returns only fixed failure codes without received payloads or keys', () => {
    try { validateUserPayload('SECRET-SENTINEL', 'SECRET-SENTINEL', 'SECRET-SENTINEL'); }
    catch (error) {
      expect(error).toBeInstanceOf(ExecutionCryptoError);
      expect(String(error)).not.toContain('SECRET-SENTINEL');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('authenticated execution envelopes', () => {
  it.each(['user', 'signed'] as const)('roundtrips %s payloads using fresh nonces', (purpose) => {
    const f = registration();
    const key = randomBytes(32).toString('base64');
    const id = randomUUID();
    const envelope = sealPayload(f.userSigned, key, id, purpose);
    expect(openPayload(envelope, key, id, purpose)).toBe(f.userSigned);
    expect(sealPayload(f.userSigned, key, id, purpose)).not.toBe(envelope);
    expect(envelope).not.toContain(f.userSigned);
    expect(envelope.startsWith('fbp1.')).toBe(true);
  });

  it('accepts bounded packet sizes including exactly 1 and 1232 bytes', () => {
    const key = randomBytes(32).toString('base64');
    const id = randomUUID();
    for (const length of [1, 2, 1_231, 1_232]) {
      const payload = randomBytes(length).toString('base64');
      expect(openPayload(sealPayload(payload, key, id, 'signed'), key, id, 'signed')).toBe(payload);
    }
  });

  it('binds operation ID, purpose, wrapping key, nonce, ciphertext, tag and version', () => {
    const f = registration();
    const key = randomBytes(32).toString('base64');
    const id = randomUUID();
    const envelope = sealPayload(f.userSigned, key, id, 'user');
    expect(() => openPayload(envelope, key, randomUUID(), 'user')).toThrow(new ExecutionCryptoError('envelope_invalid'));
    expect(() => openPayload(envelope, key, id, 'signed')).toThrow(ExecutionCryptoError);
    expect(() => openPayload(envelope, randomBytes(32).toString('base64'), id, 'user')).toThrow(ExecutionCryptoError);
    for (const index of [1, 2, 3]) {
      const parts = envelope.split('.');
      const value = Buffer.from(parts[index]!, 'base64url');
      value[0] = value[0]! ^ 1;
      parts[index] = value.toString('base64url');
      expect(() => openPayload(parts.join('.'), key, id, 'user')).toThrow(ExecutionCryptoError);
    }
    expect(() => openPayload(envelope.replace('fbp1', 'fbp2'), key, id, 'user')).toThrow(ExecutionCryptoError);
    expect(() => openPayload(sealAttemptKey(f.payer.secretKey, key, id, f.payer.publicKey.toBase58()), key, id, 'user')).toThrow(ExecutionCryptoError);
  });

  it('rejects invalid IDs, purposes, key encodings and payload sizes', () => {
    const key = randomBytes(32).toString('base64');
    const id = randomUUID();
    const valid = Buffer.from([1]).toString('base64');
    for (const payload of ['', valid + '\n', 'AR==', randomBytes(1_233).toString('base64')]) {
      expect(() => sealPayload(payload, key, id, 'user')).toThrow(ExecutionCryptoError);
    }
    for (const invalidKey of [key.slice(0, -1), key + '\n', randomBytes(31).toString('base64')]) {
      expect(() => sealPayload(valid, invalidKey, id, 'user')).toThrow(ExecutionCryptoError);
    }
    expect(() => sealPayload(valid, 'A'.repeat(42) + 'B=', id, 'user')).toThrow(ExecutionCryptoError);
    for (const invalidId of ['invalid', id.toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
      expect(() => sealPayload(valid, key, invalidId, 'user')).toThrow(ExecutionCryptoError);
    }
    expect(() => sealPayload(valid, key, id, 'other' as 'user')).toThrow(ExecutionCryptoError);
    for (const envelope of ['', 'fbp1.' + 'A'.repeat(2_000), 'fbp1.a.a.a']) {
      expect(() => openPayload(envelope, key, id, 'user')).toThrow(ExecutionCryptoError);
    }
  });
});

describe('fixed recovery transaction', () => {
  it('builds exactly a sponsor-fee-paid transfer of A to S with 20,000 compute units', () => {
    const f = recovery();
    validateRecoveryMessage(f.unsignedBase64, f.input);
    const tx = Transaction.from(Buffer.from(f.unsignedBase64, 'base64'));
    expect(tx.signatures).toHaveLength(2);
    expect(tx.feePayer?.toBase58()).toBe(f.input.sponsor);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0]!.data).toEqual(Buffer.from([2, 0x20, 0x4e, 0, 0]));
    const transfer = SystemInstruction.decodeTransfer(tx.instructions[1]!);
    expect(transfer.fromPubkey.toBase58()).toBe(f.input.payer);
    expect(transfer.toPubkey.toBase58()).toBe(f.input.sponsor);
    expect(transfer.lamports).toBe(f.input.amount);
    expect(f.messageBase64).toBe(tx.serializeMessage().toString('base64'));
    expect(f.messageHash).toBe(createHash('sha256').update(tx.serializeMessage()).digest('hex'));
  });

  it('signs exactly the original message, keeps caller secrets, and encodes the transaction ID correctly', () => {
    const f = recovery();
    const sponsorSecret = f.sponsor.secretKey;
    const payerSecret = f.payer.secretKey;
    const signed = coSignRecovery(f.unsignedBase64, f.input, sponsorSecret, payerSecret);
    const tx = Transaction.from(Buffer.from(signed.signedBase64, 'base64'));
    expect(tx.verifySignatures(true)).toBe(true);
    expect(tx.serializeMessage().toString('base64')).toBe(f.messageBase64);
    expect(tx.recentBlockhash).toBe(f.input.blockhash);
    expect(signed.messageHash).toBe(f.messageHash);
    expect(signed.signature).toBe(getBase58Decoder().decode(tx.signature!));
    expect(sponsorSecret).toEqual(f.sponsor.secretKey);
    expect(payerSecret).toEqual(f.payer.secretKey);
  });

  it('supports exact u64 amounts beyond the JavaScript number range', () => {
    const f = recovery();
    for (const amount of [1n, 9_007_199_254_740_993n, U64_MAX]) {
      const built = buildRecoveryTransaction({ ...f.input, amount });
      const tx = Transaction.from(Buffer.from(built.unsignedBase64, 'base64'));
      expect(SystemInstruction.decodeTransfer(tx.instructions[1]!).lamports).toBe(amount);
    }
  });

  it('preserves leading zeroes when encoding a transaction signature as base58', () => {
    const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(1));
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(2));
    const input = {
      sponsor: sponsor.publicKey.toBase58(), payer: payer.publicKey.toBase58(), amount: 1n,
      blockhash: Keypair.fromSeed(new Uint8Array(32).fill(101)).publicKey.toBase58(),
    };
    const built = buildRecoveryTransaction(input);
    const result = coSignRecovery(built.unsignedBase64, input, sponsor.secretKey, payer.secretKey);
    const tx = Transaction.from(Buffer.from(result.signedBase64, 'base64'));
    expect(tx.signature![0]).toBe(0);
    expect(result.signature.startsWith('1')).toBe(true);
    expect(result.signature).toBe(getBase58Decoder().decode(tx.signature!));
  });

  it('rejects arbitrary recipients, amounts, fee payers, blockhashes and extra instructions', () => {
    const f = recovery();
    for (const input of [
      { ...f.input, sponsor: Keypair.generate().publicKey.toBase58() },
      { ...f.input, payer: Keypair.generate().publicKey.toBase58() },
      { ...f.input, amount: f.input.amount + 1n },
      { ...f.input, blockhash: Keypair.generate().publicKey.toBase58() },
    ]) {
      expect(() => validateRecoveryMessage(f.unsignedBase64, input)).toThrow(new ExecutionCryptoError('recovery_invalid'));
    }
    const changedRecipient = mutatePacket(f.unsignedBase64, (tx) => {
      tx.instructions[1] = SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: f.input.amount });
    });
    const extra = mutatePacket(f.unsignedBase64, (tx) => { tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n })); });
    const changedCompute = mutatePacket(f.unsignedBase64, (tx) => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }); });
    const signed = coSignRecovery(f.unsignedBase64, f.input, f.sponsor.secretKey, f.payer.secretKey).signedBase64;
    for (const invalid of [changedRecipient, extra, changedCompute, signed, f.unsignedBase64 + '\n']) {
      expect(() => coSignRecovery(invalid, f.input, f.sponsor.secretKey, f.payer.secretKey)).toThrow(new ExecutionCryptoError('recovery_invalid'));
    }
  });

  it('rejects invalid and aliased recovery actors, invalid blockhashes and out-of-range amounts', () => {
    const f = recovery();
    const [offCurve] = PublicKey.findProgramAddressSync([Buffer.from('off-curve')], SystemProgram.programId);
    for (const input of [
      { ...f.input, sponsor: f.input.payer }, { ...f.input, sponsor: offCurve.toBase58() },
      { ...f.input, payer: SystemProgram.programId.toBase58() }, { ...f.input, blockhash: 'invalid' },
      ...[0n, -1n, U64_MAX + 1n, 1 as unknown as bigint].map((amount) => ({ ...f.input, amount })),
    ]) {
      expect(() => buildRecoveryTransaction(input)).toThrow(new ExecutionCryptoError('recovery_invalid'));
    }
    expect(() => coSignRecovery(f.unsignedBase64, f.input, f.payer.secretKey, f.sponsor.secretKey)).toThrow(new ExecutionCryptoError('signing_key_invalid'));
  });
});
