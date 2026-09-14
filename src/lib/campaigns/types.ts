import type { QuoteLimits, SponsoredQuote } from '../transactions/quote';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';
export type CampaignErrorCode = 'invalid_input' | 'unauthorized' | 'campaign_unavailable' | 'invite_unavailable'
  | 'quote_unavailable' | 'attempt_unavailable' | 'budget_exhausted' | 'capacity_exhausted' | 'conflict' | 'rate_limited' | 'storage_unavailable';
export class CampaignError extends Error {
  constructor(readonly code: CampaignErrorCode) { super(`Campaign request failed: ${code}`); this.name = 'CampaignError'; }
}
export interface CreateCampaign {
  slug: string; name: string; startsAt: Date; endsAt: Date; maxUsers: number; capNative: bigint;
  sponsorPublicKey: string; limits: Omit<QuoteLimits, 'ttlMs'>;
}
export interface CampaignContext {
  id: string; slug: string; name: string; status: CampaignStatus; startsAt: Date; endsAt: Date;
  maxUsers: number; capNative: string; reservedNative: string; spentNative: string;
  reservedUsers: number; consumedUsers: number; sponsorPublicKey: string; policyVersion: string; limits: QuoteLimits;
}
export interface SessionContext { sessionId: string; inviteId: string; campaignId: string; wallet: string; campaign: CampaignContext }
export interface SavedQuote { quoteId: string; expiresAt: Date; cost: SponsoredQuote['cost'] }
export interface AttemptView {
  id: string; quoteId: string; status: string; name: string; wallet: string; reservationNative: string;
  messageHash: string; unsignedTransactionBase64: string; expiresAt: Date;
}
export interface RateBucket { scope: string; identity: string; limit: number; windowMs: number }
