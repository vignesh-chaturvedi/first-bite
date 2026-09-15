import { createHash } from 'node:crypto';
import { Message, PublicKey, Transaction } from '@solana/web3.js';
import { z } from 'zod';
import type { RegistryClient, RegistryObservation } from '../chain/client';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';
import { domainPda, normalizeName, primaryPda } from '../cookie/registry';
import { buildSponsoredTransaction, nativeAmount, unsignedBytes, U64_MAX } from '../cookie/transaction';
import { validateSponsoredMessage } from '../transactions/policy';

const address = z.string().max(44).refine((value) => {
  try { const key = new PublicKey(value); return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()) && !key.equals(PublicKey.default); }
  catch { return false; }
});
const amount = z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => {
  try { return BigInt(value) <= U64_MAX; } catch { return false; }
});
export const smokeWorksheetInputSchema = z.object({
  name: z.string().min(1).max(64), sponsor: address, user: address,
  limits: z.object({ maxRegistrationPrice: amount, maxTransactionFee: amount,
    recoveryAllowance: amount, maxTotalSpend: amount }).strict(),
}).strict();
export type SmokeWorksheetInput = z.infer<typeof smokeWorksheetInputSchema>;
export class SmokeWorksheetError extends Error {
  constructor(readonly code: 'invalid_input' | 'chain_unavailable' | 'invalid_observation' | 'observation_expired' | 'output_failed') {
    super(`Smoke worksheet unavailable: ${code}`); this.name = 'SmokeWorksheetError';
  }
}
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const validCounter = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Internal plan for read-only diagnostics. The caller must not persist its unsigned transaction. */
export async function prepareSmokePlan(
  value: unknown, client: RegistryClient, diagnosticAttemptPayer: PublicKey, now = Date.now,
) {
  const parsed = smokeWorksheetInputSchema.safeParse(value);
  if (!parsed.success) throw new SmokeWorksheetError('invalid_input');
  const input = parsed.data;
  let label: string, sponsor: PublicKey, user: PublicKey, attemptPayer: PublicKey;
  try {
    label = normalizeName(input.name); sponsor = new PublicKey(input.sponsor); user = new PublicKey(input.user);
    attemptPayer = new PublicKey(diagnosticAttemptPayer.toBytes());
    if (!PublicKey.isOnCurve(attemptPayer.toBytes()) || attemptPayer.equals(PublicKey.default)
      || new Set([sponsor, user, attemptPayer].map((key) => key.toBase58())).size !== 3) throw new Error();
  } catch { throw new SmokeWorksheetError('invalid_input'); }
  const startedAt = now();
  if (!validTime(startedAt)) throw new SmokeWorksheetError('invalid_input');
  let observed: RegistryObservation;
  try {
    observed = await client.observe({ label, sponsor: new PublicKey(sponsor.toBytes()),
      user: new PublicKey(user.toBytes()), attemptPayer: new PublicKey(attemptPayer.toBytes()) });
  } catch { throw new SmokeWorksheetError('chain_unavailable'); }
  // Validate/copy every value before awaiting the fee adapter; injected clients may mutate their own objects.
  let captured: RegistryObservation;
  let message: Buffer;
  let transactionBytes: number;
  let requiredSigners: string[];
  try {
    const p = COOKIE_REGISTRY_POLICY;
    const observedAtCheck = now();
    if (observed.label !== label || !observed.sponsor.equals(sponsor) || !observed.user.equals(user)
      || !observed.attemptPayer.equals(attemptPayer) || observed.feeReceiver.toBase58() !== p.feeReceiverAddress
      || observed.policyId !== p.id || observed.genesisHash !== p.genesisHash
      || observed.configSha256 !== p.configSha256 || observed.programSha256 !== p.programSha256
      || observed.domainRent !== p.domainRent || (observed.primaryRent !== 0n && observed.primaryRent !== p.primaryRent)
      || !validCounter(observed.observedSlot) || !validCounter(observed.blockhashContextSlot)
      || observed.blockhashContextSlot < observed.observedSlot || !validCounter(observed.lastValidBlockHeight)
      || !validTime(observed.observedAtMs) || !validTime(observedAtCheck) || observedAtCheck < startedAt
      || observed.observedAtMs < startedAt || observed.observedAtMs > observedAtCheck
      || new PublicKey(observed.blockhash).toBase58() !== observed.blockhash) throw new Error();
    for (const value of [observed.registrationPrice, observed.sponsorBalance, observed.userBalance]) nativeAmount(value);
    captured = Object.freeze({ ...observed, sponsor, user, attemptPayer, feeReceiver: new PublicKey(observed.feeReceiver.toBytes()) });
    const tx = buildSponsoredTransaction(captured);
    message = tx.serializeMessage();
    validateSponsoredMessage(message, captured);
    transactionBytes = unsignedBytes(tx).length;
    requiredSigners = tx.signatures.map(({ publicKey }) => publicKey.toBase58());
  } catch { throw new SmokeWorksheetError('invalid_observation'); }
  let fee: bigint;
  try { fee = await client.getMessageFee(Message.from(message), captured.blockhashContextSlot); }
  catch { throw new SmokeWorksheetError('chain_unavailable'); }
  try { if (nativeAmount(fee) === 0n) throw new Error(); }
  catch { throw new SmokeWorksheetError('invalid_observation'); }
  const generatedAt = now();
  if (!validTime(generatedAt) || generatedAt < captured.observedAtMs || generatedAt < startedAt
    || generatedAt - startedAt >= 30_000) throw new SmokeWorksheetError('observation_expired');
  const executionDebit = captured.registrationPrice + captured.domainRent + captured.primaryRent + fee;
  const reservation = executionDebit + BigInt(input.limits.recoveryAllowance);
  const shortfall = reservation > captured.sponsorBalance ? reservation - captured.sponsorBalance : 0n;
  const blockers: string[] = [];
  if (captured.registrationPrice > BigInt(input.limits.maxRegistrationPrice)) blockers.push('registration_price_exceeds_limit');
  if (fee > BigInt(input.limits.maxTransactionFee)) blockers.push('transaction_fee_exceeds_limit');
  if (reservation > BigInt(input.limits.maxTotalSpend)) blockers.push('total_exceeds_limit');
  if (shortfall > 0n) blockers.push('sponsor_funding_shortfall');
  if (captured.userBalance !== 0n) blockers.push('recipient_not_zero_cook');
  const report = {
    schemaVersion: 1, purpose: 'read_only_smoke_planning', generatedAt: new Date(generatedAt).toISOString(),
    planningChecksSatisfied: blockers.length === 0, blockers, spendAuthorized: false,
    signingEnabled: false, broadcastEnabled: false, phase0GateComplete: false, refreshRequired: true,
    name: `${label}.cook`, sponsor: input.sponsor, user: input.user,
    diagnosticAttemptPayer: attemptPayer.toBase58(), attemptKeyRetained: false,
    observation: { observedAt: new Date(captured.observedAtMs).toISOString(), slot: captured.observedSlot,
      blockhashContextSlot: captured.blockhashContextSlot, lastValidBlockHeight: captured.lastValidBlockHeight,
      genesisHash: captured.genesisHash, policyId: captured.policyId, configSha256: captured.configSha256,
      programSha256: captured.programSha256, feeReceiver: captured.feeReceiver.toBase58(),
      sponsorBalanceNative: captured.sponsorBalance.toString(), recipientBalanceNative: captured.userBalance.toString() },
    expected: { domain: domainPda(label).toBase58(), owner: input.user, primary: primaryPda(user).toBase58() },
    transaction: { messageSha256: createHash('sha256').update(message).digest('hex'), bytes: transactionBytes,
      requiredSigners },
    limits: input.limits,
    costs: { registrationPriceNative: captured.registrationPrice.toString(), domainRentNative: captured.domainRent.toString(),
      primaryRentNative: captured.primaryRent.toString(), transactionFeeNative: fee.toString(),
      recoveryAllowanceNative: input.limits.recoveryAllowance, estimatedExecutionDebitNative: executionDebit.toString(),
      estimatedReservationNative: reservation.toString(), sponsorFundingShortfallNative: shortfall.toString() },
    limitations: ['Diagnostic A is discarded. This worksheet contains no executable payload and cannot be used for signing.',
      'Refresh with the actual durably stored attempt payer and current accounts, fees and lifetime before a separately approved funded test.',
      'The recovery allowance is entered by the operator; recovery fees, other campaign holds and sponsor activity are not assessed here.',
      'Wallet compatibility, concrete funding approval, finality, independent resolution and pilot allocation remain separate gates.'],
  };
  // Reconstruct from captured bytes, never from adapter-owned objects changed during later awaits.
  return { report, transaction: Transaction.populate(Message.from(message)) };
}

/** Read-only planning with a disposable A identity. Never a quote, reservation or authorization. */
export async function prepareSmokeWorksheet(
  value: unknown, client: RegistryClient, diagnosticAttemptPayer: PublicKey, now = Date.now,
) {
  return (await prepareSmokePlan(value, client, diagnosticAttemptPayer, now)).report;
}
