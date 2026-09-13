import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js';
import { PROGRAM_ID, configPda, domainPda, primaryPda } from '../cookie/registry';
import type { SponsoredTransactionInput } from '../cookie/transaction';

/** Stable, non-sensitive failures: never include received message bytes or keys. */
export class SponsoredMessagePolicyError extends Error {
  constructor(reason: string) {
    super(`Sponsored message policy: ${reason}`);
    this.name = 'SponsoredMessagePolicyError';
  }
}

function requirePolicy(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new SponsoredMessagePolicyError(reason);
}

/** A bounded legacy-message parser, including canonical Solana short-u16 lengths. */
class Reader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  take(length: number): Buffer {
    requirePolicy(length >= 0 && this.offset + length <= this.bytes.length, 'truncated message');
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  byte(): number { return this.take(1)[0]!; }

  length(): number {
    let value = 0;
    for (let byteIndex = 0; byteIndex < 3; byteIndex++) {
      const byte = this.byte();
      requirePolicy(byteIndex !== 2 || byte <= 3, 'invalid vector length');
      value |= (byte & 0x7f) << (byteIndex * 7);
      if ((byte & 0x80) === 0) {
        requirePolicy(byteIndex === 0 || byte !== 0, 'noncanonical vector length');
        return value;
      }
    }
    throw new SponsoredMessagePolicyError('invalid vector length');
  }

  finish(): void { requirePolicy(this.offset === this.bytes.length, 'trailing message bytes'); }
}

function compareKeys(left: PublicKey, right: PublicKey): number {
  // The pinned legacy compiler sorts each merged privilege group by base58 text.
  return left.toBase58().localeCompare(right.toBase58(), 'en', {
    localeMatcher: 'best fit', usage: 'sort', sensitivity: 'variant',
    ignorePunctuation: false, numeric: false, caseFirst: 'lower',
  });
}

function transferData(amount: bigint): Buffer {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(amount, 4);
  return data;
}

/**
 * Validate the fixed sponsored message independently of construction helpers.
 * This proves structure and quoted amounts, not eligibility or chain freshness.
 * The expected input must come from the server's validated quote, never the client.
 */
export function validateSponsoredMessage(
  messageBytes: Uint8Array,
  expected: SponsoredTransactionInput,
): void {
  requirePolicy(typeof expected.label === 'string'
    && /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(expected.label), 'invalid normalized label');
  const actors = [expected.sponsor, expected.attemptPayer, expected.user];
  requirePolicy([...actors, expected.feeReceiver].every((key) => key instanceof PublicKey), 'invalid public key');
  requirePolicy(new Set(actors.map((key) => key.toBase58())).size === 3, 'overlapping signers');
  requirePolicy(actors.every((key) => PublicKey.isOnCurve(key.toBytes())), 'off-curve signer');

  const config = configPda();
  const domain = domainPda(expected.label);
  const primary = primaryPda(expected.user);
  const system = SystemProgram.programId;
  const compute = ComputeBudgetProgram.programId;
  const protectedKeys = [PROGRAM_ID, system, compute, config, domain, primary, primaryPda(expected.attemptPayer)];
  requirePolicy([...actors, expected.feeReceiver].every((key) => protectedKeys.every((protectedKey) => !key.equals(protectedKey))), 'protected account alias');
  requirePolicy(actors.every((key) => !key.equals(expected.feeReceiver)), 'fee receiver aliases signer');

  const maxU64 = (1n << 64n) - 1n;
  for (const value of [expected.registrationPrice, expected.domainRent, expected.primaryRent]) {
    requirePolicy(typeof value === 'bigint' && value >= 0n && value <= maxU64, 'invalid quoted amount');
  }
  requirePolicy(expected.registrationPrice > 0n && expected.domainRent > 0n, 'zero registration allocation');
  const allocation = expected.registrationPrice + expected.domainRent;
  requirePolicy(allocation <= maxU64, 'allocation overflow');
  let blockhash: PublicKey;
  try {
    blockhash = new PublicKey(expected.blockhash);
  } catch {
    throw new SponsoredMessagePolicyError('invalid expected blockhash');
  }
  requirePolicy(blockhash.toBase58() === expected.blockhash, 'noncanonical expected blockhash');

  // Three signature slots, plus their single-byte shortvec prefix, accompany this message.
  requirePolicy(messageBytes instanceof Uint8Array && messageBytes.byteLength + 193 <= 1_232, 'packet limit');
  const reader = new Reader(Buffer.from(messageBytes));
  requirePolicy(reader.byte() === 3, 'expected three-signature legacy header');
  requirePolicy(reader.byte() === 0 && reader.byte() === 4, 'unexpected account privileges');

  // All three actors are writable signers after compilation, including A in the
  // ownership instruction and U when primaryRent is zero. Domain is also globally
  // writable in set-primary. Per-instruction flags cannot weaken merged privileges.
  const accountKeys = [
    expected.sponsor,
    ...[expected.attemptPayer, expected.user].sort(compareKeys),
    ...[domain, primary, expected.feeReceiver].sort(compareKeys),
    ...[config, system, compute, PROGRAM_ID].sort(compareKeys),
  ];
  requirePolicy(reader.length() === 10, 'unexpected account count');
  for (const key of accountKeys) {
    requirePolicy(reader.take(32).equals(key.toBuffer()), 'unexpected account key or order');
  }
  requirePolicy(reader.take(32).equals(blockhash.toBuffer()), 'unexpected blockhash');

  const index = (key: PublicKey) => accountKeys.findIndex((candidate) => candidate.equals(key));
  const registerLength = Buffer.alloc(4);
  registerLength.writeUInt32LE(expected.label.length);
  const instructions = [
    { program: compute, accounts: [], data: Buffer.from([2, 64, 13, 3, 0]) }, // 200,000 CUs, no price instruction
    { program: system, accounts: [expected.sponsor, expected.attemptPayer], data: transferData(allocation) },
    {
      program: PROGRAM_ID, accounts: [config, domain, expected.attemptPayer, expected.feeReceiver, system],
      data: Buffer.concat([Buffer.from([236, 7, 208, 151, 173, 149, 73, 104]), registerLength, Buffer.from(expected.label, 'ascii')]),
    },
    {
      program: PROGRAM_ID, accounts: [domain, expected.attemptPayer],
      data: Buffer.concat([Buffer.from([129, 115, 193, 43, 174, 5, 241, 52]), expected.user.toBuffer()]),
    },
    ...(expected.primaryRent > 0n ? [{ program: system, accounts: [expected.sponsor, expected.user], data: transferData(expected.primaryRent) }] : []),
    {
      program: PROGRAM_ID, accounts: [primary, domain, expected.user, system],
      data: Buffer.from([18, 2, 170, 172, 190, 140, 242, 27]),
    },
  ];
  requirePolicy(reader.length() === instructions.length, 'unexpected instruction count');
  for (const instruction of instructions) {
    requirePolicy(reader.byte() === index(instruction.program), 'unexpected instruction program');
    requirePolicy(reader.length() === instruction.accounts.length, 'unexpected instruction account count');
    for (const account of instruction.accounts) {
      requirePolicy(reader.byte() === index(account), 'unexpected instruction account index');
    }
    requirePolicy(reader.length() === instruction.data.length, 'unexpected instruction data length');
    requirePolicy(reader.take(instruction.data.length).equals(instruction.data), 'unexpected instruction data');
  }
  reader.finish();
}
