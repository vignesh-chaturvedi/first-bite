import { Keypair, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { PROGRAM_ID, configPda, domainPda, primaryPda } from '../src/lib/cookie/registry.js';
import { buildSponsoredTransaction, maximumReservation, U64_MAX, unsignedBytes, validateUserSignature } from '../src/lib/cookie/transaction.js';

function fixture() {
  const sponsor = Keypair.generate();
  const attempt = Keypair.generate();
  const user = Keypair.generate();
  const input = { label: 'firstbite', sponsor: sponsor.publicKey, attemptPayer: attempt.publicKey, user: user.publicKey, feeReceiver: Keypair.generate().publicKey, registrationPrice: 15_000_000_000_000n, domainRent: 1_927_920n, primaryRent: 1_426_800n, blockhash: Keypair.generate().publicKey.toBase58() };
  return { sponsor, attempt, user, input, tx: buildSponsoredTransaction(input) };
}

describe('bounded sponsored message', () => {
  it('uses S only for explicit transfers and transaction fees; A alone pays registration', () => {
    const { input, tx } = fixture();
    expect(tx.feePayer?.equals(input.sponsor)).toBe(true);
    expect(tx.instructions).toHaveLength(6);
    const funding = SystemInstruction.decodeTransfer(tx.instructions[1]!);
    expect(funding.fromPubkey.equals(input.sponsor)).toBe(true);
    expect(funding.toPubkey.equals(input.attemptPayer)).toBe(true);
    expect(funding.lamports).toBe(input.registrationPrice + input.domainRent);
    const registry = tx.instructions[2]!;
    expect(registry.programId.equals(PROGRAM_ID)).toBe(true);
    expect(registry.keys[2]!.pubkey.equals(input.attemptPayer)).toBe(true);
    expect(registry.keys.some(({ pubkey }) => pubkey.equals(input.user) || pubkey.equals(input.sponsor))).toBe(false);
    expect(tx.instructions[3]!.data.subarray(8).equals(input.user.toBuffer())).toBe(true);
    expect(SystemInstruction.decodeTransfer(tx.instructions[4]!).lamports).toBe(input.primaryRent);
    expect(tx.instructions[5]!.data).toHaveLength(8);
    expect(tx.instructions[5]!.keys[0]!.pubkey.equals(primaryPda(input.user))).toBe(true);
  });

  it.each([4, 32])('fits a three-signature legacy packet at label length %i', (length) => {
    const { input } = fixture();
    const tx = buildSponsoredTransaction({ ...input, label: 'a'.repeat(length) });
    const message = tx.compileMessage();
    expect(message.header.numRequiredSignatures).toBe(3);
    expect(new Set(message.accountKeys.slice(0, 3).map((key) => key.toBase58()))).toEqual(new Set([input.sponsor, input.attemptPayer, input.user].map((key) => key.toBase58())));
    expect(unsignedBytes(tx).length).toBe(672 + length);
    expect(unsignedBytes(tx).length).toBeLessThanOrEqual(1_232);
  });

  it('omits primary funding only when caller supplies a zero requirement', () => {
    const { input } = fixture();
    const tx = buildSponsoredTransaction({ ...input, primaryRent: 0n });
    expect(tx.instructions).toHaveLength(5);
    expect(tx.instructions.at(-1)!.programId.equals(PROGRAM_ID)).toBe(true);
  });

  it.each(['sponsor', 'attemptPayer', 'user'] as const)('rejects fee receiver alias with %s', (actor) => {
    const { input } = fixture();
    expect(() => buildSponsoredTransaction({ ...input, feeReceiver: input[actor] })).toThrow(/alias/);
  });

  it('rejects overlapping signers, program/PDA aliases and non-normalized names', () => {
    const { input } = fixture();
    expect(() => buildSponsoredTransaction({ ...input, sponsor: input.user })).toThrow(/distinct/);
    for (const feeReceiver of [PROGRAM_ID, SystemProgram.programId, configPda(), domainPda(input.label), primaryPda(input.user)]) {
      expect(() => buildSponsoredTransaction({ ...input, feeReceiver })).toThrow(/protected/);
    }
    expect(() => buildSponsoredTransaction({ ...input, user: primaryPda(input.user) })).toThrow(/on-curve/);
    expect(() => buildSponsoredTransaction({ ...input, label: 'FirstBite.cook' })).toThrow(/normalized/);
  });

  it('rejects negative, zero or overflowing instruction amounts', () => {
    const { input } = fixture();
    for (const registrationPrice of [-1n, 0n, U64_MAX, U64_MAX + 1n]) {
      expect(() => buildSponsoredTransaction({ ...input, registrationPrice })).toThrow();
    }
    expect(() => buildSponsoredTransaction({ ...input, primaryRent: -1n })).toThrow();
  });

  it('keeps reservation totals exact beyond Number safe-integer range', () => {
    const cost = { price: 9_007_199_254_740_993n, domainRent: 10n, primaryRent: 20n, transactionFee: 30n, recoveryAllowance: 40n };
    expect(maximumReservation(cost)).toBe(9_007_199_254_741_093n);
    expect(() => maximumReservation({ ...cost, recoveryAllowance: -1n })).toThrow();
  });
});

describe('wallet signature contract', () => {
  it('accepts the expected user signature without requiring server signatures', () => {
    const { tx, user } = fixture();
    const returned = Transaction.from(unsignedBytes(tx));
    returned.partialSign(user);
    const checked = validateUserSignature(tx, unsignedBytes(returned), user.publicKey);
    expect(checked.verifySignatures(false)).toBe(true);
    expect(checked.signatures.filter(({ signature }) => signature)).toHaveLength(1);
  });

  it('rejects missing, corrupt and unexpected server signatures', () => {
    const { tx, user, sponsor } = fixture();
    expect(() => validateUserSignature(tx, unsignedBytes(tx), user.publicKey)).toThrow(/missing/);
    const bad = Transaction.from(unsignedBytes(tx));
    bad.partialSign(user);
    bad.signatures.find(({ publicKey }) => publicKey.equals(user.publicKey))!.signature = Buffer.alloc(64, 1);
    expect(() => validateUserSignature(tx, unsignedBytes(bad), user.publicKey)).toThrow(/invalid/);
    const extra = Transaction.from(unsignedBytes(tx));
    extra.partialSign(user, sponsor);
    expect(() => validateUserSignature(tx, unsignedBytes(extra), user.publicKey)).toThrow(/Unexpected/);
  });

  it('rejects a valid signature on a changed transfer, fee payer or blockhash', () => {
    const { tx, input, user } = fixture();
    for (const changed of [
      buildSponsoredTransaction({ ...input, primaryRent: input.primaryRent + 1n }),
      buildSponsoredTransaction({ ...input, sponsor: Keypair.generate().publicKey }),
      buildSponsoredTransaction({ ...input, blockhash: Keypair.generate().publicKey.toBase58() }),
    ]) {
      changed.partialSign(user);
      expect(() => validateUserSignature(tx, unsignedBytes(changed), user.publicKey)).toThrow(/changed/);
    }
  });
});
