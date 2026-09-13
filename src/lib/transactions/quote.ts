import { createHash } from 'node:crypto';
import { Message, PublicKey } from '@solana/web3.js';
import type { RegistryClient, RegistryObservation } from '../chain/client';
import { domainPda, normalizeName, primaryPda } from '../cookie/registry';
import { buildSponsoredTransaction, nativeAmount, unsignedBytes, type SponsoredTransactionInput } from '../cookie/transaction';
import { validateSponsoredMessage } from './policy';

export interface QuoteLimits {
  maxRegistrationPrice: bigint;
  maxTransactionFee: bigint;
  recoveryAllowance: bigint;
  maxReservation: bigint;
  /** Unsigned lease only. Never use this timer to release a signed reservation. */
  ttlMs: number;
}

export interface QuoteRequest {
  name: string;
  sponsor: PublicKey;
  user: PublicKey;
  /** Fresh server-generated identity; its secret stays with the future durable attempt store. */
  attemptPayer: PublicKey;
}

export interface SponsoredQuote {
  readonly version: 1;
  readonly name: string;
  readonly sponsor: string;
  readonly attemptPayer: string;
  readonly user: string;
  readonly feeReceiver: string;
  readonly policyId: string;
  readonly genesisHash: string;
  readonly programSha256: string;
  readonly configSha256: string;
  readonly observedSlot: number;
  readonly blockhashContextSlot: number;
  readonly preparedAtMs: number;
  readonly expiresAtMs: number;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly messageSha256: string;
  readonly messageBase64: string;
  readonly unsignedTransactionBase64: string;
  readonly expected: Readonly<{ domain: string; owner: string; primary: string; primaryName: string }>;
  readonly cost: Readonly<{
    registrationPrice: string;
    domainRent: string;
    primaryRent: string;
    transactionFee: string;
    recoveryAllowance: string;
    maxSponsorDebit: string;
    maximumReservation: string;
  }>;
}

type QuoteErrorCode = 'invalid_name' | 'invalid_limits' | 'invalid_observation' | 'cost_limit'
  | 'insufficient_sponsor_balance' | 'quote_expired' | 'chain_unavailable' | 'invalid_message';
export class QuoteError extends Error {
  constructor(readonly code: QuoteErrorCode) {
    super(`Quote unavailable: ${code}`);
    this.name = 'QuoteError';
  }
}

function safeCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function positiveAmount(value: bigint): boolean { return nativeAmount(value) > 0n; }

function validateLimits(limits: QuoteLimits): void {
  try {
    for (const value of [limits.maxRegistrationPrice, limits.maxTransactionFee, limits.recoveryAllowance, limits.maxReservation]) {
      if (!positiveAmount(value)) throw new Error();
    }
    if (!Number.isSafeInteger(limits.ttlMs) || limits.ttlMs < 1_000 || limits.ttlMs > 60_000) throw new Error();
  } catch { throw new QuoteError('invalid_limits'); }
}

function validateObservation(value: RegistryObservation, request: QuoteRequest, label: string, startedAt: number, now: number): void {
  try {
    if (!(value.feeReceiver instanceof PublicKey) || value.label !== label || !value.sponsor.equals(request.sponsor)
      || !value.user.equals(request.user) || !value.attemptPayer.equals(request.attemptPayer)
      || !safeCounter(value.observedSlot) || !safeCounter(value.lastValidBlockHeight)
      || !safeCounter(value.blockhashContextSlot) || value.blockhashContextSlot < value.observedSlot
      || !safeCounter(value.observedAtMs) || value.observedAtMs < startedAt || value.observedAtMs > now
      || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.policyId)
      || !/^[a-f0-9]{64}$/.test(value.configSha256) || !/^[a-f0-9]{64}$/.test(value.programSha256)) throw new Error();
    for (const key of [value.genesisHash, value.blockhash]) {
      if (new PublicKey(key).toBase58() !== key) throw new Error();
    }
    if (!positiveAmount(value.registrationPrice) || !positiveAmount(value.domainRent)) throw new Error();
    nativeAmount(value.primaryRent);
    nativeAmount(value.sponsorBalance);
  } catch { throw new QuoteError('invalid_observation'); }
}

/**
 * Read-only preparation. No name/budget reservation, key generation, signature or
 * broadcast occurs here. Callers supply the public identity of one fresh attempt;
 * the registry client checks its current accounts, while durable uniqueness and
 * encrypted secret storage belong to the invitation/signing phases.
 */
export async function prepareSponsoredQuote(
  request: QuoteRequest,
  client: RegistryClient,
  limits: QuoteLimits,
  now: () => number = Date.now,
): Promise<SponsoredQuote> {
  let label: string;
  try { label = normalizeName(request.name); } catch { throw new QuoteError('invalid_name'); }
  validateLimits(limits);
  // Copy caller-owned data before the first await; a mutated request/limit cannot
  // change which identity or cap this preparation was authorized to use.
  const input = { name: label, sponsor: new PublicKey(request.sponsor.toBytes()), user: new PublicKey(request.user.toBytes()), attemptPayer: new PublicKey(request.attemptPayer.toBytes()) };
  const bounds = { ...limits };
  const startedAt = now();
  if (!safeCounter(startedAt) || !safeCounter(startedAt + bounds.ttlMs)) throw new QuoteError('invalid_limits');
  let observed: RegistryObservation;
  try {
    observed = await client.observe({ label,
      sponsor: new PublicKey(input.sponsor.toBytes()), user: new PublicKey(input.user.toBytes()),
      attemptPayer: new PublicKey(input.attemptPayer.toBytes()),
    });
  }
  catch { throw new QuoteError('chain_unavailable'); }
  validateObservation(observed, input, label, startedAt, now());
  // RegistryClient is injectable. Capture its validated response before another
  // await, even when an implementation returns an object it can later mutate.
  observed = Object.freeze({
    ...observed, sponsor: new PublicKey(observed.sponsor.toBytes()), user: new PublicKey(observed.user.toBytes()),
    attemptPayer: new PublicKey(observed.attemptPayer.toBytes()), feeReceiver: new PublicKey(observed.feeReceiver.toBytes()),
  });
  if (observed.registrationPrice > bounds.maxRegistrationPrice) throw new QuoteError('cost_limit');

  const transactionInput: SponsoredTransactionInput = {
    label, sponsor: input.sponsor, user: input.user, attemptPayer: input.attemptPayer,
    feeReceiver: new PublicKey(observed.feeReceiver.toBytes()), registrationPrice: observed.registrationPrice,
    domainRent: observed.domainRent, primaryRent: observed.primaryRent, blockhash: observed.blockhash,
  };
  let transaction;
  let message: Buffer;
  let unsignedTransactionBase64: string;
  try {
    transaction = buildSponsoredTransaction(transactionInput);
    message = transaction.serializeMessage();
    validateSponsoredMessage(message, transactionInput);
    unsignedTransactionBase64 = unsignedBytes(transaction).toString('base64');
  } catch { throw new QuoteError('invalid_message'); }

  let fee: bigint;
  // The fee adapter gets its own decoded copy, not keys owned by this quote.
  try { fee = await client.getMessageFee(Message.from(message), observed.blockhashContextSlot); }
  catch { throw new QuoteError('chain_unavailable'); }
  try { if (!positiveAmount(fee)) throw new Error(); } catch { throw new QuoteError('invalid_observation'); }
  if (fee > bounds.maxTransactionFee) throw new QuoteError('cost_limit');
  const maxSponsorDebit = transactionInput.registrationPrice + transactionInput.domainRent + transactionInput.primaryRent + fee;
  const maximumReservation = maxSponsorDebit + bounds.recoveryAllowance;
  if (maximumReservation > bounds.maxReservation) throw new QuoteError('cost_limit');
  // The separate recovery allowance stays reserved until reconciled in Phase 4.
  if (observed.sponsorBalance < maximumReservation) throw new QuoteError('insufficient_sponsor_balance');
  const completedAt = now();
  if (!safeCounter(completedAt) || completedAt < startedAt || completedAt >= startedAt + bounds.ttlMs) throw new QuoteError('quote_expired');

  return Object.freeze({
    version: 1, name: label, sponsor: input.sponsor.toBase58(), attemptPayer: input.attemptPayer.toBase58(),
    user: input.user.toBase58(), feeReceiver: transactionInput.feeReceiver.toBase58(),
    policyId: observed.policyId, genesisHash: observed.genesisHash, programSha256: observed.programSha256,
    configSha256: observed.configSha256, observedSlot: observed.observedSlot,
    blockhashContextSlot: observed.blockhashContextSlot, preparedAtMs: startedAt,
    expiresAtMs: startedAt + bounds.ttlMs, blockhash: transactionInput.blockhash,
    lastValidBlockHeight: observed.lastValidBlockHeight,
    messageSha256: createHash('sha256').update(message).digest('hex'), messageBase64: message.toString('base64'),
    unsignedTransactionBase64,
    expected: Object.freeze({ domain: domainPda(label).toBase58(), owner: input.user.toBase58(), primary: primaryPda(input.user).toBase58(), primaryName: label }),
    cost: Object.freeze({
      registrationPrice: transactionInput.registrationPrice.toString(), domainRent: transactionInput.domainRent.toString(),
      primaryRent: transactionInput.primaryRent.toString(), transactionFee: fee.toString(), recoveryAllowance: bounds.recoveryAllowance.toString(),
      maxSponsorDebit: maxSponsorDebit.toString(), maximumReservation: maximumReservation.toString(),
    }),
  });
}

/** Only checks the unsigned lease; signing must re-read chain and durable policy. */
export function assertUnsignedQuoteFresh(quote: SponsoredQuote, nowMs: number, blockHeight: number): void {
  if (!safeCounter(nowMs) || !safeCounter(blockHeight) || !safeCounter(quote.preparedAtMs)
    || !safeCounter(quote.expiresAtMs) || !safeCounter(quote.lastValidBlockHeight)
    || quote.expiresAtMs <= quote.preparedAtMs || nowMs < quote.preparedAtMs
    || nowMs >= quote.expiresAtMs || blockHeight > quote.lastValidBlockHeight) {
    throw new QuoteError('quote_expired');
  }
}
