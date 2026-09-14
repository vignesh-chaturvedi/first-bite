import { z } from 'zod';

export const COOKIE_GENESIS = '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2';
export const idSchema = z.string().uuid();
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const native = z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
export const sessionSchema = z.object({ wallet: address, expiresAt: z.iso.datetime(),
  campaign: z.object({ name: z.string().min(1).max(120), slug: z.string().max(64), status: z.enum(['draft', 'active', 'paused', 'ended']) }),
  attemptId: idSchema.nullable() });
export const costSchema = z.object({ registrationPrice: native, domainRent: native, primaryRent: native,
  transactionFee: native, recoveryAllowance: native, maxSponsorDebit: native, maximumReservation: native });
export const quoteSchema = z.object({ quoteId: idSchema, name: z.string().max(32), cost: costSchema, expiresAt: z.iso.datetime(),
  expected: z.object({ domain: address, owner: address, primary: address, primaryName: z.string().max(32) }) });
export const statusSchema = z.enum(['prepared', 'signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'complete', 'failed', 'expired', 'manual_review']);
export const attemptSchema = z.object({ id: idSchema, quoteId: idSchema, status: statusSchema, name: z.string().max(32), wallet: address,
  reservationNative: native, messageHash: z.string().regex(/^[a-f0-9]{64}$/), unsignedTransactionBase64: z.string().max(1644), expiresAt: z.iso.datetime(),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).nullable(), verifiedSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  actualCostNative: native, residualNative: native.nullable(), cost: costSchema.optional() });
export type JourneySession = z.infer<typeof sessionSchema>;
export type JourneyQuote = z.infer<typeof quoteSchema>;
export type JourneyAttempt = z.infer<typeof attemptSchema>;
export type AttemptStatus = z.infer<typeof statusSchema>;
export interface JourneyApi {
  session(): Promise<JourneySession>;
  exchange(token: string): Promise<void>;
  quote(name: string, wallet: string): Promise<JourneyQuote>;
  reserve(quoteId: string, idempotencyKey: string): Promise<JourneyAttempt>;
  attempt(id: string): Promise<JourneyAttempt>;
  submit(id: string, payload: string): Promise<void>;
  retry(id: string): Promise<void>;
}
export class JourneyError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function normalizeLabel(value: string): string | null {
  const label = value.trim().toLowerCase().replace(/\.cook$/, '');
  return /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(label) ? label : null;
}
/** Exact native conversion; never round a quoted amount through Number. */
export function formatCook(value: string): string {
  if (!/^(0|[1-9][0-9]{0,23})$/.test(value)) return 'Unavailable';
  const digits = value.padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} COOK`;
}
export function verifiedResult(attempt: JourneyAttempt | null): boolean {
  return !!attempt && ['finalized', 'complete'].includes(attempt.status) && attempt.signature !== null && attempt.verifiedSlot !== null;
}
export const STATUS_COPY: Record<AttemptStatus, { title: string; detail: string }> = {
  prepared: { title: 'Ready for your review', detail: 'Your name and sponsor coverage are prepared. Nothing has been sent.' },
  signing: { title: 'Preparing your registration', detail: 'Your approval was received. The sponsor is preparing the transaction.' },
  signed: { title: 'Ready to reach Cookie', detail: 'Your approved transaction is saved and waiting to be sent.' },
  submitted: { title: 'Sent to Cookie', detail: 'We’re waiting for the network to confirm your registration.' },
  broadcast_unknown: { title: 'Checking the network', detail: 'The send response was interrupted. We’re checking the same transaction; please don’t start again.' },
  confirmed: { title: 'Confirmed. One more check.', detail: 'Cookie has confirmed the transaction. Ownership is shown only after final verification.' },
  finalized: { title: 'Your name is ready', detail: 'Ownership and your primary name are verified. Your sponsor’s remaining accounting is finishing.' },
  complete: { title: 'Make yourself at home.', detail: 'Your registration is finalized, and your wallet owns its new primary name.' },
  failed: { title: 'The registration did not complete', detail: 'The network finalized a failed transaction. Your sponsor covers any charged fee. You can check a fresh name.' },
  expired: { title: 'This preparation has expired', detail: 'Nothing was signed for this preparation. Check the name again for a fresh quote.' },
  manual_review: { title: 'Your registration needs a check', detail: 'The organizer needs to review this attempt. Keep the reference below; do not create a replacement or pay again.' },
};
const ERRORS: Record<string, string> = {
  SESSION_REQUIRED: 'Enter your invitation again to continue. Your existing registration is kept on the server.',
  INVITE_UNAVAILABLE: 'This pass is expired, used or unavailable. Ask your organizer to check it.',
  CAMPAIGN_UNAVAILABLE: 'This campaign is paused or closed. Existing registrations can still be checked.',
  NAME_UNAVAILABLE: 'That name is already registered. Try another name.',
  WALLET_INELIGIBLE: 'This wallet already has a primary name or cannot use this pass. Ask your organizer to check eligibility.',
  BUDGET_EXHAUSTED: 'This campaign has no available sponsorship budget. Ask your organizer about the next round.',
  CAPACITY_EXHAUSTED: 'All passes in this round are allocated. Ask your organizer about the next round.',
  QUOTE_CHANGED: 'The quote changed or expired. Check the name again before continuing.',
  QUOTE_EXPIRED: 'The preparation expired. Check its status before preparing again.',
  ATTEMPT_UNRESOLVED: 'There is an existing attempt to check. Resume it before starting another.',
  RATE_LIMITED: 'Please wait one minute before trying again.',
  RPC_UNAVAILABLE: 'Cookie could not be checked right now. Wait a moment, then check again.',
  PREPARATION_DISABLED: 'The pilot is not accepting registrations yet. You can explore the walkthrough while your organizer prepares it.',
  EXECUTION_DISABLED: 'Wallet approvals are not open yet. Your organizer will enable them after the live pilot checks.',
  OFFLINE: 'You’re offline. Reconnect, then check your progress. An approved registration may still be processing.',
  SUBMIT_UNKNOWN: 'We could not confirm receipt of your approval. Check this attempt’s status before taking another action.',
  RESTORE_FAILED: 'We could not restore your attempt. Check again before starting a new registration.',
  missing: 'Nightly was not found. Install the desktop extension, unlock it, then try again.',
  unsupported: 'This Nightly version does not expose the required signing feature. Update the extension and try again.',
  rejected: 'Approval canceled. Nothing new was submitted from this screen. You can review it again.',
  wrong_network: 'Select Cookie in Nightly, then check the connection again.',
  wrong_wallet: 'This pass belongs to a different wallet. Select the assigned wallet in Nightly and reconnect.',
  changed: 'Your wallet or network changed. Reconnect the assigned wallet before continuing.',
  invalid_transaction: 'The wallet returned a different or invalid transaction. Nothing was submitted. Contact your organizer.',
};
export function errorCopy(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return ERRORS[code] ?? 'The request could not be completed. Check your connection and try again. If it persists, contact your organizer.';
}
