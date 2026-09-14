import type { SponsoredQuote } from '../transactions/quote';
import type { CampaignContext } from '../campaigns/types';

export type ExecutionCode = 'disabled' | 'unauthorized' | 'invalid_input' | 'signature_invalid' | 'policy_changed'
  | 'quote_expired' | 'unavailable' | 'conflict' | 'budget_exhausted' | 'storage_unavailable' | 'evidence_invalid';
export class ExecutionError extends Error {
  constructor(readonly code: ExecutionCode) { super(`Execution unavailable: ${code}`); this.name = 'ExecutionError'; }
}
export type OperationStatus = 'signing' | 'signed' | 'submitted' | 'broadcast_unknown' | 'confirmed' | 'finalized' | 'complete' | 'failed' | 'expired' | 'manual_review';
export interface ExecutionOperation {
  id: string; attemptId: string; campaignId: string; kind: 'registration' | 'recovery'; status: OperationStatus;
  messageHash: string; messageBase64: string; encryptedUserPayload: string | null; encryptedSignedPayload: string | null;
  signature: string | null; blockhash: string; lastValidBlockHeight: number; feeCapNative: string; amountNative: string;
  authorizedAt: Date;
}
export interface ExecutionAttempt {
  id: string; inviteId: string; campaignId: string; wallet: string; name: string; payerPublicKey: string; status: string;
  encryptedPayerKey: string | null; remainingReservationNative: string; actualCostNative: string; residualNative: string | null;
  quote: SponsoredQuote; campaign: CampaignContext; operation: ExecutionOperation | null;
}
export interface PreflightResult { checkedAtMs: number; slot: number; blockHeight: number; fee: bigint; sponsorBalance: bigint }
export interface FinalizedReceipt {
  signedBase64: string; slot: number; fee: bigint; failed: boolean; accountKeys: string[]; preBalances: bigint[]; postBalances: bigint[];
}
export interface ExecutionObservation {
  finalizedBlockHeight: number;
  status: 'missing' | 'processed' | 'confirmed' | 'finalized';
  /** Present only after a finalized transaction read, never synthesized from account state. */
  receipt: FinalizedReceipt | null;
  /** Finalized account read at or after the receipt's slot. */
  accountSlot: number;
  payerBalance: bigint;
  domainOwner: string | null;
  primaryOwner: string | null;
  primaryName: string | null;
}
export interface RecoveryPreparation { blockhash: string; lastValidBlockHeight: number; observedSlot: number; fee: bigint; preparedAtMs: number }
export interface ExecutionChain {
  preflight(quote: SponsoredQuote, userSignedBase64: string): Promise<PreflightResult>;
  /** Only receives bytes already committed by the execution store. */
  broadcast(signedBase64: string): Promise<string>;
  observe(operation: ExecutionOperation, attempt: ExecutionAttempt): Promise<ExecutionObservation>;
  prepareRecovery(input: { sponsor: string; payer: string; amount: bigint; maxFee: bigint; validity?: { blockhash: string; lastValidBlockHeight: number } }): Promise<RecoveryPreparation>;
}
export interface ExecutionSigner {
  publicKey: string;
  /** Returns a private owned copy; caller must clear it. Never supplied by HTTP input. */
  secret(): Uint8Array;
}
export interface JobLease { id: string; operationId: string; owner: string; retryCount: number }
export interface Settlement {
  success: boolean; fee: bigint; debit: bigint; recovered: bigint; residual: bigint; slot: number;
}
