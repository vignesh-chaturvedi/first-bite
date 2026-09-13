import { ComputeBudgetProgram, Keypair, Message, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { PROGRAM_ID, configPda, domainPda, primaryPda } from '../src/lib/cookie/registry';
import { buildSponsoredTransaction, type SponsoredTransactionInput } from '../src/lib/cookie/transaction';
import { SponsoredMessagePolicyError, validateSponsoredMessage } from '../src/lib/transactions/policy';

const publicKey = (seed: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seed)).publicKey;

function fixture(overrides: Partial<SponsoredTransactionInput> = {}) {
  const input: SponsoredTransactionInput = {
    label: 'firstbite', sponsor: publicKey(1), attemptPayer: publicKey(2), user: publicKey(3),
    feeReceiver: publicKey(4), registrationPrice: 15_000_000_000_000n, domainRent: 1_927_920n,
    primaryRent: 1_426_800n, blockhash: publicKey(5).toBase58(), ...overrides,
  };
  const transaction = buildSponsoredTransaction(input);
  return { input, transaction, bytes: transaction.serializeMessage() };
}

// Literal account and wire fixture pins the reviewed legacy protocol separately
// from the builder, PDA helpers, instruction constructors and policy implementation.
const GOLDEN_KEYS = [
  'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
  '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
  '4DGujhopNsYWKquNnLFvmU2hcSS7FdfAQCbJWXGDQDj5',
  'ANtHcpkiiX1Y4w8G6NZUfEkAGLMF4vRqezFrZdDPx2Lo',
  'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
  '11111111111111111111111111111111',
  '4s4DK5eMahyNXe8UarT3q3WPC95Q2wqRfEP19JWXmMGg',
  'ComputeBudget111111111111111111111111111111',
  'H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA',
];
const GOLDEN_INSTRUCTIONS = '0608000502400d0300060200010c02000000f05ac975a40d00000905070401050615ec07d097ad9549680900000066697273746269746509020401288173c12bae05f134ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1060200020c0200000070c5150000000000090403040206081202aaacbe8cf21b';

describe('independent fixed sponsored message policy', () => {
  it('pins the literal account order, merged privileges and wire instructions', () => {
    const { input, transaction, bytes } = fixture();
    const message = transaction.compileMessage();
    expect(message.accountKeys.map((key) => key.toBase58())).toEqual(GOLDEN_KEYS);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('0300040a');
    expect(bytes.subarray(4 + 10 * 32 + 32).toString('hex')).toBe(GOLDEN_INSTRUCTIONS);
    expect(message.instructions.map(({ programIdIndex, accounts }) => [programIdIndex, accounts])).toEqual([
      [8, []], [6, [0, 1]], [9, [7, 4, 1, 5, 6]], [9, [4, 1]], [6, [0, 2]], [9, [3, 4, 2, 6]],
    ]);
    expect(bytes.length + 193).toBe(681);
    expect(() => validateSponsoredMessage(bytes, input)).not.toThrow();
  });

  it.each([4, 32])('accepts the %i-character boundary with and without primary funding', (length) => {
    for (const primaryRent of [0n, 1_426_800n]) {
      const { input, bytes } = fixture({ label: 'a'.repeat(length), primaryRent });
      expect(() => validateSponsoredMessage(bytes, input)).not.toThrow();
      expect(bytes.length + 193).toBeLessThanOrEqual(704);
    }
  });

  it('handles either signer ordering without mistaking merged A and U permissions', () => {
    const { input, bytes } = fixture({ attemptPayer: publicKey(3), user: publicKey(2), primaryRent: 0n });
    expect(() => validateSponsoredMessage(bytes, input)).not.toThrow();
    const message = Message.from(bytes);
    expect(message.header).toEqual({ numRequiredSignatures: 3, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 4 });
    expect(message.accountKeys[0]?.equals(input.sponsor)).toBe(true);
  });

  it('rejects every single-byte mutation in both accepted message shapes', () => {
    for (const primaryRent of [0n, 1_426_800n]) {
      const { input, bytes } = fixture({ primaryRent });
      for (let position = 0; position < bytes.length; position++) {
        const mutated = Buffer.from(bytes);
        mutated[position] = mutated[position]! ^ 1;
        expect(() => validateSponsoredMessage(mutated, input), `rent=${primaryRent}, byte=${position}`).toThrow(SponsoredMessagePolicyError);
      }
    }
  });

  it('rejects every truncation, trailing bytes and oversized packets', () => {
    const { input, bytes } = fixture();
    for (let end = 0; end < bytes.length; end++) {
      expect(() => validateSponsoredMessage(bytes.subarray(0, end), input)).toThrow(SponsoredMessagePolicyError);
    }
    expect(() => validateSponsoredMessage(Buffer.concat([bytes, Buffer.from([0])]), input)).toThrow(/trailing/);
    expect(() => validateSponsoredMessage(Buffer.alloc(1_040), input)).toThrow(/packet limit/);
  });

  it('rejects versioned headers, changed signature counts and privilege escalation or removal', () => {
    const { input, bytes } = fixture();
    for (const [offset, value] of [[0, 0x80], [0, 0x83], [0, 2], [0, 4], [1, 1], [2, 3], [2, 5]]) {
      const changed = Buffer.from(bytes);
      changed[offset!] = value!;
      expect(() => validateSponsoredMessage(changed, input)).toThrow(SponsoredMessagePolicyError);
    }
  });

  it('rejects a semantically equivalent reordered account table', () => {
    const { input, bytes } = fixture();
    const message = Message.from(bytes);
    [message.accountKeys[1], message.accountKeys[2]] = [message.accountKeys[2]!, message.accountKeys[1]!];
    for (const instruction of message.instructions) {
      instruction.accounts = instruction.accounts.map((index) => index === 1 ? 2 : index === 2 ? 1 : index);
    }
    expect(() => validateSponsoredMessage(message.serialize(), input)).toThrow(/account key or order/);
  });

  it('rejects duplicate or additional unused account keys', () => {
    const { input, bytes } = fixture();
    for (const extra of [publicKey(9), input.sponsor]) {
      const message = Message.from(bytes);
      message.accountKeys.push(extra);
      message.header.numReadonlyUnsignedAccounts++;
      expect(() => validateSponsoredMessage(message.serialize(), input)).toThrow(SponsoredMessagePolicyError);
    }
  });

  it('rejects nonminimal, overflowing and unterminated short-vector encodings', () => {
    const { input, bytes } = fixture();
    for (const encoding of [[0x8a, 0], [0x8a, 0x80, 0], [0xff, 0xff, 4], [0xff, 0xff, 0x80]]) {
      const changed = Buffer.concat([bytes.subarray(0, 3), Buffer.from(encoding), bytes.subarray(4)]);
      expect(() => validateSponsoredMessage(changed, input)).toThrow(/vector length/);
    }
    const instructionCountOffset = 4 + 10 * 32 + 32;
    const changed = Buffer.concat([bytes.subarray(0, instructionCountOffset), Buffer.from([0x86, 0]), bytes.subarray(instructionCountOffset + 1)]);
    expect(() => validateSponsoredMessage(changed, input)).toThrow(/noncanonical/);
  });

  it('rejects missing, repeated, reordered or arbitrary instructions and compute-price additions', () => {
    for (const mutate of [
      (tx: ReturnType<typeof buildSponsoredTransaction>) => tx.instructions.pop(),
      (tx: ReturnType<typeof buildSponsoredTransaction>) => tx.instructions.push(tx.instructions[2]!),
      (tx: ReturnType<typeof buildSponsoredTransaction>) => { [tx.instructions[2], tx.instructions[3]] = [tx.instructions[3]!, tx.instructions[2]!]; },
      (tx: ReturnType<typeof buildSponsoredTransaction>) => tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n })),
      (tx: ReturnType<typeof buildSponsoredTransaction>) => { tx.instructions[3] = new TransactionInstruction({ programId: publicKey(9), keys: [], data: Buffer.from([1]) }); },
    ]) {
      const { input, transaction } = fixture();
      mutate(transaction);
      expect(() => validateSponsoredMessage(transaction.serializeMessage(), input)).toThrow(SponsoredMessagePolicyError);
    }
  });

  it('rejects altered literal discriminators, limits, funding amounts, labels and new owners', () => {
    const mutations = [
      { instruction: 0, byte: 0 }, { instruction: 0, byte: 1 },
      { instruction: 1, byte: 0 }, { instruction: 1, byte: 4 },
      { instruction: 2, byte: 0 }, { instruction: 2, byte: 8 }, { instruction: 2, byte: 12 },
      { instruction: 3, byte: 0 }, { instruction: 3, byte: 8 },
      { instruction: 4, byte: 4 }, { instruction: 5, byte: 0 },
    ];
    for (const mutation of mutations) {
      const { input, transaction } = fixture();
      const data = transaction.instructions[mutation.instruction]!.data;
      data[mutation.byte] = data[mutation.byte]! ^ 1;
      expect(() => validateSponsoredMessage(transaction.serializeMessage(), input)).toThrow(/instruction data/);
    }
  });

  it('rejects any extra instruction accounts or out-of-range program/account indices', () => {
    const { input, bytes } = fixture();
    for (const mutate of [
      (message: Message) => message.instructions[0]!.accounts.push(0),
      (message: Message) => { message.instructions[2]!.accounts[2] = 10; },
      (message: Message) => { message.instructions[3]!.programIdIndex = 255; },
    ]) {
      const message = Message.from(bytes);
      mutate(message);
      expect(() => validateSponsoredMessage(message.serialize(), input)).toThrow(SponsoredMessagePolicyError);
    }
  });

  it('requires exact presence or absence of primary rent funding', () => {
    const withRent = fixture();
    const noRent = fixture({ primaryRent: 0n });
    expect(() => validateSponsoredMessage(withRent.bytes, noRent.input)).toThrow(/instruction count/);
    expect(() => validateSponsoredMessage(noRent.bytes, withRent.input)).toThrow(/instruction count/);
    noRent.transaction.instructions.splice(4, 0, SystemProgram.transfer({ fromPubkey: noRent.input.sponsor, toPubkey: noRent.input.user, lamports: 0n }));
    expect(() => validateSponsoredMessage(noRent.transaction.serializeMessage(), noRent.input)).toThrow(/instruction count/);
  });

  it('rejects a different expected payer, recipient, fee receiver, blockhash or amounts', () => {
    const { input, bytes } = fixture();
    const changes: Partial<SponsoredTransactionInput>[] = [
      { sponsor: publicKey(8) }, { attemptPayer: publicKey(8) }, { user: publicKey(8) },
      { feeReceiver: publicKey(8) }, { blockhash: publicKey(8).toBase58() },
      { registrationPrice: input.registrationPrice + 1n }, { domainRent: input.domainRent + 1n },
      { primaryRent: input.primaryRent + 1n }, { label: 'othername' },
    ];
    for (const change of changes) {
      expect(() => validateSponsoredMessage(bytes, { ...input, ...change })).toThrow(SponsoredMessagePolicyError);
    }
  });

  it('validates the expected input independently, including aliases, labels and u64 overflow', () => {
    const { input, bytes } = fixture();
    const protectedKeys = [PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId, configPda(), domainPda(input.label), primaryPda(input.user), primaryPda(input.attemptPayer)];
    const changes: Partial<SponsoredTransactionInput>[] = [
      { sponsor: input.user }, { user: primaryPda(input.user) },
      ...[...protectedKeys, input.sponsor, input.attemptPayer, input.user].map((feeReceiver) => ({ feeReceiver })),
      ...['abc', 'a'.repeat(33), 'FirstBite', 'firstbite.cook', '-bite', 'bite-', 'fírst'].map((label) => ({ label })),
      ...[-1n, 0n, (1n << 64n) - 1n, 1n << 64n].map((registrationPrice) => ({ registrationPrice })),
      { domainRent: 0n }, { primaryRent: -1n }, { blockhash: 'broken' },
      { user: 'not-a-key' as unknown as PublicKey },
      { primaryRent: 1 as unknown as bigint },
    ];
    for (const change of changes) {
      expect(() => validateSponsoredMessage(bytes, { ...input, ...change })).toThrow(SponsoredMessagePolicyError);
    }
  });
});
