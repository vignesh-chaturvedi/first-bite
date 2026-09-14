import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { COOKIE_REGISTRY_POLICY as policy } from '../chain/policy';
import { domainPda, normalizeName, primaryPda } from '../cookie/registry';
import { nativeAmount } from '../cookie/transaction';
import { validateSponsoredMessage } from '../transactions/policy';
import type { SponsoredQuote } from '../transactions/quote';
import { CampaignError, type CampaignContext, type CreateCampaign } from './types';

export function assertId(id: string): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new CampaignError('invalid_input');
}
export function assertWallet(value: string): void {
  try { const key = new PublicKey(value); if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw new Error(); }
  catch { throw new CampaignError('invalid_input'); }
}
export function assertCampaign(input: CreateCampaign): void {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 64
      || !input.name.trim() || input.name.length > 100 || !Number.isInteger(input.maxUsers) || input.maxUsers < 1 || input.maxUsers > 100_000
      || !Number.isFinite(input.startsAt.getTime()) || !Number.isFinite(input.endsAt.getTime()) || input.endsAt <= input.startsAt) throw new Error();
    assertWallet(input.sponsorPublicKey);
    for (const amount of [input.capNative, ...Object.values(input.limits)]) if (typeof amount !== 'bigint' || nativeAmount(amount) <= 0n) throw new Error();
    if (input.limits.maxReservation > input.capNative) throw new Error();
  } catch { throw new CampaignError('invalid_input'); }
}

/** Recheck stored data before it can hold budget; signing must independently recheck chain state. */
export function validateStoredQuote(q: SponsoredQuote, campaign: CampaignContext, wallet: string, nowMs: number): bigint {
  try {
    if (q.version !== 1 || q.name !== normalizeName(q.name) || q.user !== wallet || q.sponsor !== campaign.sponsorPublicKey
      || q.policyId !== campaign.policyVersion || q.policyId !== policy.id || q.genesisHash !== policy.genesisHash
      || q.programSha256 !== policy.programSha256 || q.configSha256 !== policy.configSha256 || q.feeReceiver !== policy.feeReceiverAddress
      || !Number.isSafeInteger(q.preparedAtMs) || !Number.isSafeInteger(q.expiresAtMs) || nowMs < q.preparedAtMs - 1_000
      || nowMs >= q.expiresAtMs || q.expiresAtMs - q.preparedAtMs < 1_000 || q.expiresAtMs - q.preparedAtMs > 60_000
      || !Number.isSafeInteger(q.lastValidBlockHeight) || q.lastValidBlockHeight < 0) throw new Error();
    const amounts = Object.fromEntries(Object.entries(q.cost).map(([key, value]) => {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error();
      return [key, nativeAmount(BigInt(value))];
    }));
    const { registrationPrice: price, domainRent, primaryRent, transactionFee: fee, recoveryAllowance: recovery, maxSponsorDebit: debit, maximumReservation: reservation } = amounts;
    if (!price || !fee || !recovery || !reservation || price > campaign.limits.maxRegistrationPrice || fee > campaign.limits.maxTransactionFee
      || recovery !== campaign.limits.recoveryAllowance || domainRent !== policy.domainRent || (primaryRent !== 0n && primaryRent !== policy.primaryRent)
      || debit !== price + domainRent + primaryRent + fee || reservation !== debit + recovery || reservation > campaign.limits.maxReservation) throw new Error();
    if (q.messageBase64.length > 1_648 || q.unsignedTransactionBase64.length > 1_648) throw new Error();
    const message = Buffer.from(q.messageBase64, 'base64');
    const tx = Buffer.from(q.unsignedTransactionBase64, 'base64');
    if (message.toString('base64') !== q.messageBase64 || tx.toString('base64') !== q.unsignedTransactionBase64
      || createHash('sha256').update(message).digest('hex') !== q.messageSha256
      || !tx.equals(Buffer.concat([Buffer.from([3]), Buffer.alloc(192), message]))) throw new Error();
    const user = new PublicKey(wallet);
    validateSponsoredMessage(message, { label: q.name, sponsor: new PublicKey(q.sponsor), attemptPayer: new PublicKey(q.attemptPayer), user,
      feeReceiver: new PublicKey(q.feeReceiver), registrationPrice: price, domainRent, primaryRent, blockhash: q.blockhash });
    if (q.expected.domain !== domainPda(q.name).toBase58() || q.expected.owner !== wallet || q.expected.primary !== primaryPda(user).toBase58()
      || q.expected.primaryName !== q.name) throw new Error();
    return reservation;
  } catch { throw new CampaignError('quote_unavailable'); }
}
