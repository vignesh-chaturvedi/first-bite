import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { buildRecoveryTransaction, coSignRecovery, coSignRegistration } from '../src/lib/execution/crypto';
import { verifySettlement } from '../src/lib/execution/settlement';
import { ExecutionError, type ExecutionAttempt, type ExecutionObservation, type ExecutionOperation, type FinalizedReceipt } from '../src/lib/execution/types';
import { prepareSponsoredQuote } from '../src/lib/transactions/quote';

const epoch = 1_800_000_000_000;
const price = 15_000_000_000_000n;
const registrationFee = 15_000n;
const recoveryFee = 10_000n;
const limits = { maxRegistrationPrice: price, maxTransactionFee: registrationFee, recoveryAllowance: registrationFee, maxReservation: 15_000_003_384_720n, ttlMs: 30_000 };

async function registrationFixture(options: { residual?: bigint; primaryRent?: bigint; failed?: boolean } = {}) {
  const sponsor = Keypair.generate(), payer = Keypair.generate(), user = Keypair.generate();
  const residual = options.residual ?? 0n;
  const primaryRent = options.primaryRent ?? policy.primaryRent;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const quote = await prepareSponsoredQuote({ name: 'settlement', sponsor: sponsor.publicKey, attemptPayer: payer.publicKey, user: user.publicKey }, {
    observe: async (request) => ({ ...request, feeReceiver: new PublicKey(policy.feeReceiverAddress), registrationPrice: price,
      domainRent: policy.domainRent, primaryRent, sponsorBalance: 100_000_000_000_000n, blockhash, lastValidBlockHeight: 200,
      observedSlot: 100, blockhashContextSlot: 101, observedAtMs: epoch, genesisHash: policy.genesisHash, configSha256: policy.configSha256,
      programSha256: policy.programSha256, policyId: policy.id }),
    getMessageFee: async () => registrationFee,
  }, limits, () => epoch);
  const walletTx = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
  walletTx.partialSign(user);
  const signed = coSignRegistration(quote.unsignedTransactionBase64, unsignedBytes(walletTx).toString('base64'), sponsor.secretKey, payer.secretKey, quote.user);
  const tx = Transaction.from(Buffer.from(signed.signedBase64, 'base64'));
  const accountKeys = tx.compileMessage().accountKeys.map((key) => key.toBase58());
  const preBalances = accountKeys.map(() => 100n);
  const index = (key: string) => accountKeys.indexOf(key);
  preBalances[index(quote.sponsor)] = 100_000_000_000_000n;
  preBalances[index(quote.attemptPayer)] = 0n;
  preBalances[index(quote.user)] = 99_999_999_999n;
  preBalances[index(quote.expected.domain)] = 0n;
  preBalances[index(quote.expected.primary)] = primaryRent === 0n ? policy.primaryRent : 0n;
  const postBalances = preBalances.slice();
  postBalances[index(quote.sponsor)]! -= options.failed ? registrationFee : price + policy.domainRent + primaryRent + registrationFee;
  if (!options.failed) {
    postBalances[index(quote.attemptPayer)] = residual;
    postBalances[index(quote.feeReceiver)]! += price - residual;
    postBalances[index(quote.expected.domain)]! += policy.domainRent;
    postBalances[index(quote.expected.primary)]! += primaryRent;
  }
  const op: ExecutionOperation = { id: randomUUID(), attemptId: randomUUID(), campaignId: randomUUID(), kind: 'registration', status: 'submitted',
    messageHash: signed.messageHash, messageBase64: quote.messageBase64, encryptedUserPayload: null, encryptedSignedPayload: 'opaque-fixture',
    signature: signed.signature, blockhash, lastValidBlockHeight: 200, feeCapNative: registrationFee.toString(), amountNative: quote.cost.maxSponsorDebit, authorizedAt: new Date(epoch) };
  const attempt: ExecutionAttempt = { id: op.attemptId, inviteId: randomUUID(), campaignId: op.campaignId, wallet: quote.user, name: quote.name,
    payerPublicKey: quote.attemptPayer, status: 'submitted', encryptedPayerKey: null, remainingReservationNative: quote.cost.maximumReservation,
    actualCostNative: '0', residualNative: null, quote, operation: op,
    campaign: { id: op.campaignId, slug: 'settlement', name: 'Settlement tests', status: 'active', startsAt: new Date(epoch - 1_000), endsAt: new Date(epoch + 60_000),
      maxUsers: 1, capNative: limits.maxReservation.toString(), reservedNative: limits.maxReservation.toString(), spentNative: '0', reservedUsers: 1,
      consumedUsers: 0, sponsorPublicKey: quote.sponsor, policyVersion: policy.id, limits },
  };
  const receipt: FinalizedReceipt = { signedBase64: signed.signedBase64, slot: 110, fee: registrationFee, failed: options.failed ?? false,
    accountKeys, preBalances, postBalances };
  const observation: ExecutionObservation = { finalizedBlockHeight: 120, status: 'finalized', receipt, accountSlot: 111,
    payerBalance: options.failed ? 0n : residual, domainOwner: options.failed ? null : quote.user,
    primaryOwner: options.failed ? null : quote.user, primaryName: options.failed ? null : quote.name };
  return { sponsor, payer, user, op, attempt, observation, receipt, signed, index };
}

async function recoveryFixture(failed = false) {
  const f = await registrationFixture();
  const amount = 1_000_000n;
  const input = { sponsor: f.sponsor.publicKey.toBase58(), payer: f.payer.publicKey.toBase58(), amount, blockhash: f.op.blockhash };
  const built = buildRecoveryTransaction(input);
  const signed = coSignRecovery(built.unsignedBase64, input, f.sponsor.secretKey, f.payer.secretKey);
  const tx = Transaction.from(Buffer.from(signed.signedBase64, 'base64'));
  const accountKeys = tx.compileMessage().accountKeys.map((key) => key.toBase58());
  const preBalances = accountKeys.map(() => 100n);
  preBalances[0] = 100_000_000n;
  preBalances[1] = amount;
  const postBalances = preBalances.slice();
  postBalances[0]! += failed ? -recoveryFee : amount - recoveryFee;
  postBalances[1] = failed ? amount : 0n;
  const op: ExecutionOperation = { ...f.op, id: randomUUID(), kind: 'recovery', messageHash: built.messageHash, messageBase64: built.messageBase64,
    signature: signed.signature, amountNative: amount.toString(), feeCapNative: recoveryFee.toString() };
  const receipt: FinalizedReceipt = { signedBase64: signed.signedBase64, slot: 115, fee: recoveryFee, failed, accountKeys, preBalances, postBalances };
  const observation: ExecutionObservation = { ...f.observation, receipt, accountSlot: 116, payerBalance: failed ? amount : 0n };
  return { ...f, op, receipt, observation, signed, amount };
}

describe('finalized registration settlement', () => {
  it.each([0n, 1_000_000n, price])('accounts for a %s residual without crediting an unconfirmed recovery', async (residual) => {
    const f = await registrationFixture({ residual });
    expect(verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toEqual({ success: true, fee: registrationFee,
      debit: price + policy.domainRent + policy.primaryRent + registrationFee, recovered: 0n, residual, slot: 110 });
  });

  it('accepts an already rent-funded primary and preserves unrelated user funds', async () => {
    const f = await registrationFixture({ primaryRent: 0n });
    expect(verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toMatchObject({ success: true,
      debit: price + policy.domainRent + registrationFee, residual: 0n });
    expect(f.receipt.preBalances[f.index(f.attempt.wallet)]).toBe(f.receipt.postBalances[f.index(f.attempt.wallet)]);
  });

  it.each(['missing', 'processed', 'confirmed'] as const)('rejects %s evidence regardless of correct ownership', async (status) => {
    const f = await registrationFixture(); f.observation.status = status;
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(new ExecutionError('evidence_invalid'));
  });

  it('rejects missing receipts, an older account read and invalid receipt slots', async () => {
    for (const change of ['receipt', 'account-slot', 'negative-slot', 'fractional-slot', 'unsafe-slot']) {
      const f = await registrationFixture();
      if (change === 'receipt') f.observation.receipt = null;
      if (change === 'account-slot') f.observation.accountSlot = f.receipt.slot - 1;
      if (change === 'negative-slot') f.receipt.slot = -1;
      if (change === 'fractional-slot') f.receipt.slot = 110.5;
      if (change === 'unsafe-slot') f.receipt.slot = Number.MAX_SAFE_INTEGER + 1;
      expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
    }
  });

  it('rejects inconsistent signature packets, message hashes and account vectors', async () => {
    for (const change of ['packet', 'hash', 'keys', 'pre-count', 'post-count', 'negative-balance', 'number-balance']) {
      const f = await registrationFixture();
      if (change === 'packet') f.receipt.signedBase64 = f.attempt.quote.unsignedTransactionBase64;
      if (change === 'hash') f.op.messageHash = 'a'.repeat(64);
      if (change === 'keys') f.receipt.accountKeys[2] = Keypair.generate().publicKey.toBase58();
      if (change === 'pre-count') f.receipt.preBalances.pop();
      if (change === 'post-count') f.receipt.postBalances.push(0n);
      if (change === 'negative-balance') f.receipt.preBalances[0] = -1n;
      if (change === 'number-balance') f.receipt.postBalances[0] = 1 as unknown as bigint;
      expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
    }
  });

  it.each(['sponsor', 'payer', 'user', 'receiver', 'domain', 'primary', 'readonly'] as const)('rejects unexpected %s balance movement', async (role) => {
    const f = await registrationFixture({ residual: 100n });
    const q = f.attempt.quote;
    const address = { sponsor: q.sponsor, payer: q.attemptPayer, user: q.user, receiver: q.feeReceiver,
      domain: q.expected.domain, primary: q.expected.primary, readonly: f.receipt.accountKeys.at(-1)! }[role];
    f.receipt.postBalances[f.index(address)]! += 1n;
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
  });

  it.each(['domainOwner', 'primaryOwner', 'primaryName', 'payerBalance'] as const)('rejects inconsistent finalized %s', async (field) => {
    const f = await registrationFixture();
    if (field === 'payerBalance') f.observation.payerBalance = 1n;
    else f.observation[field] = 'wrong';
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
  });

  it.each([-1n, registrationFee + 1n, 1 as unknown as bigint])('rejects invalid or excessive receipt fee %s', async (fee) => {
    const f = await registrationFixture(); f.receipt.fee = fee;
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
  });

  it('charges only the finalized failure fee after atomic rollback', async () => {
    const f = await registrationFixture({ failed: true });
    expect(verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toEqual({ success: false,
      fee: registrationFee, debit: registrationFee, recovered: 0n, residual: 0n, slot: 110 });
    f.receipt.postBalances[f.index(f.attempt.wallet)]! -= 1n;
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
  });
});

describe('finalized recovery settlement', () => {
  it('credits the exact sweep only after finalized balances prove A is empty', async () => {
    const f = await recoveryFixture();
    expect(verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toEqual({ success: true,
      fee: recoveryFee, debit: recoveryFee, recovered: f.amount, residual: 0n, slot: 115 });
  });

  it('charges a failed recovery fee while retaining the full residual', async () => {
    const f = await recoveryFixture(true);
    expect(verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toEqual({ success: false,
      fee: recoveryFee, debit: recoveryFee, recovered: 0n, residual: f.amount, slot: 115 });
  });

  it.each(['pre-amount', 'residual', 'refund', 'fee', 'readonly', 'current-balance'] as const)('rejects inconsistent recovery %s', async (change) => {
    const f = await recoveryFixture();
    if (change === 'pre-amount') f.receipt.preBalances[1]! += 1n;
    if (change === 'residual') f.receipt.postBalances[1] = 1n;
    if (change === 'refund') f.receipt.postBalances[0]! += 1n;
    if (change === 'fee') f.receipt.fee += 1n;
    if (change === 'readonly') f.receipt.postBalances[2]! += 1n;
    if (change === 'current-balance') f.observation.payerBalance = 1n;
    expect(() => verifySettlement(f.op, f.attempt, f.observation, f.signed.signedBase64)).toThrow(ExecutionError);
  });
});
