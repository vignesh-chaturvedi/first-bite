import { createHash, randomUUID } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import { CampaignStore } from '../campaigns/store';
import { CampaignError } from '../campaigns/types';
import { validateStoredQuote } from '../campaigns/validation';
import { SponsoredMessagePolicyError, validateSponsoredMessage } from '../transactions/policy';
import { openAttemptKey } from '../security/attempt-key';
import { ExecutionCryptoError, buildRecoveryTransaction, coSignRecovery, coSignRegistration, openPayload, sealPayload, validateUserPayload } from './crypto';
import { ExecutionStore } from './store';
import { verifySettlement } from './settlement';
import { prepareResidualRecovery } from './recovery';
import { OPERATIONAL_EVIDENCE_MS, type OperationalReadiness } from '../operations/readiness';
import { ExecutionError, type ExecutionAttempt, type ExecutionChain, type ExecutionOperation, type ExecutionSigner, type JobLease } from './types';

export interface ExecutionOptions { store: ExecutionStore; campaigns: CampaignStore; chain: ExecutionChain; signer: ExecutionSigner; wrappingKey: string; now?: () => number;
  admission: (campaignId: string) => Promise<OperationalReadiness>;
  assertRuntime?: () => Promise<void> }
/** Shared engine: HTTP authorizes durable work; only the worker owns signer custody. */
export class ExecutionService {
  private readonly now: () => number;
  constructor(private readonly deps: ExecutionOptions) { this.now = deps.now ?? Date.now; }
  async submit(token: string, id: string, userSignedBase64: string) {
    await this.deps.assertRuntime?.();
    const attempt = await this.deps.store.load(id, token);
    try { validateUserPayload(attempt.quote.unsignedTransactionBase64,userSignedBase64,attempt.wallet); }
    catch { throw new ExecutionError('signature_invalid'); }
    // Retried submission reports/schedules the original operation, including
    // after pause, without requesting another signature or changing blockhash.
    if (attempt.operation) { await this.deps.store.requestRetry(id,token); return this.deps.store.status(id,token); }
    validateStoredQuote(attempt.quote,attempt.campaign,attempt.wallet,this.now());
    if (this.deps.signer.publicKey !== attempt.campaign.sponsorPublicKey) throw new ExecutionError('policy_changed');
    const preflight = await this.deps.chain.preflight(attempt.quote,userSignedBase64);
    // Missing/stale operational evidence blocks new authorization. An operation
    // already authorized above may still reconcile after a health failure/pause.
    let readiness: OperationalReadiness | undefined;
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    try { readiness = await Promise.race([this.deps.admission?.(attempt.campaignId),
      new Promise<undefined>((resolve) => { admissionTimer = setTimeout(() => resolve(undefined), 4_500); })]); }
    catch { /* Fail closed without exposing probe errors. */ }
    finally { clearTimeout(admissionTimer); }
    const checkedAt = this.now();
    if (readiness?.newSignaturesAllowed !== true || !Array.isArray(readiness.failures) || readiness.failures.length !== 0
      || readiness.scope !== 'sponsorship' || readiness.campaignId !== attempt.campaignId
      || !Number.isSafeInteger(readiness.checkedAtMs) || readiness.checkedAtMs > checkedAt
      || checkedAt - readiness.checkedAtMs > OPERATIONAL_EVIDENCE_MS) throw new ExecutionError('unavailable');
    const operationId = randomUUID();
    const encryptedUserPayload = sealPayload(userSignedBase64,this.deps.wrappingKey,operationId,'user');
    await this.deps.store.authorize(token,id,{ operationId,encryptedUserPayload,messageHash:attempt.quote.messageSha256,preflight });
    // Authorization + user bytes + job are committed together. The durable
    // worker, not this HTTP request, owns co-signing, broadcasting and recovery.
    return this.deps.store.status(id,token);
  }
  async retry(token: string, id: string) {
    await this.deps.assertRuntime?.();
    await this.deps.store.requestRetry(id,token); return this.deps.store.status(id,token);
  }
  private recoveryInput(op: ExecutionOperation, attempt: ExecutionAttempt) {
    return { sponsor: attempt.campaign.sponsorPublicKey, payer: attempt.payerPublicKey, amount: BigInt(op.amountNative), blockhash: op.blockhash };
  }
  private async sign(lease: JobLease, op: ExecutionOperation, attempt: ExecutionAttempt): Promise<ExecutionOperation> {
    if (!attempt.encryptedPayerKey || this.deps.signer.publicKey !== attempt.campaign.sponsorPublicKey) throw new ExecutionError('policy_changed');
    let userPayload: string | undefined;
    let unsignedRecovery: string | undefined;
    if (op.kind === 'registration') {
      if (!op.encryptedUserPayload || this.now() >= attempt.quote.expiresAtMs) throw new ExecutionError('quote_expired');
      validateStoredQuote(attempt.quote,attempt.campaign,attempt.wallet,this.now());
      userPayload = openPayload(op.encryptedUserPayload,this.deps.wrappingKey,op.id,'user');
      // Recheck before resuming an interrupted signing job. Policy/fee changes
      // retain the hold for review rather than signing a different message.
      await this.deps.chain.preflight(attempt.quote,userPayload);
    } else {
      const input = this.recoveryInput(op,attempt);
      unsignedRecovery = buildRecoveryTransaction(input).unsignedBase64;
      const prepared = await this.deps.chain.prepareRecovery({ ...input, maxFee: BigInt(op.feeCapNative),
        validity:{ blockhash:op.blockhash,lastValidBlockHeight:op.lastValidBlockHeight } });
      if (prepared.blockhash !== op.blockhash || prepared.lastValidBlockHeight !== op.lastValidBlockHeight || prepared.fee > BigInt(op.feeCapNative)) throw new ExecutionError('quote_expired');
    }
    const payerSecret = openAttemptKey(attempt.encryptedPayerKey,this.deps.wrappingKey,attempt.id,attempt.payerPublicKey);
    let sponsorSecret: Uint8Array | undefined;
    try {
      sponsorSecret = this.deps.signer.secret();
      const signed = op.kind === 'registration'
        ? coSignRegistration(attempt.quote.unsignedTransactionBase64,userPayload!,sponsorSecret,payerSecret,attempt.wallet)
        : coSignRecovery(unsignedRecovery!,this.recoveryInput(op,attempt),sponsorSecret,payerSecret);
      if (signed.messageHash !== op.messageHash) throw new ExecutionError('policy_changed');
      const encryptedSignedPayload = sealPayload(signed.signedBase64,this.deps.wrappingKey,op.id,'signed');
      return await this.deps.store.persistSigned(lease,{ encryptedSignedPayload,signature:signed.signature,messageHash:signed.messageHash });
    } finally { payerSecret.fill(0); sponsorSecret?.fill(0); }
  }
  private async broadcast(lease: JobLease) {
    const op = await this.deps.store.broadcastPayload(lease);
    const bytes = openPayload(op.encryptedSignedPayload!,this.deps.wrappingKey,op.id,'signed');
    // Only a committed payload can reach this port, and retries use its exact bytes.
    try {
      const signature = await this.deps.chain.broadcast(bytes);
      if (signature !== op.signature) throw new ExecutionError('evidence_invalid');
      await this.deps.store.note(lease,'submitted');
    } catch {
      await this.deps.store.note(lease,'broadcast_unknown');
    }
  }
  async processOne(operationId?: string): Promise<boolean> {
    // Check custody before claiming a job. A misconfigured replica must not
    // turn another worker's healthy encrypted work into manual review.
    await this.deps.assertRuntime?.();
    const lease = await this.deps.store.claimJob(randomUUID(),operationId);
    if (!lease) return false;
    try {
      let op = await this.deps.store.getOperation(lease.operationId);
      const attempt = await this.deps.store.load(op.attemptId);
      if (op.status === 'signing') op = await this.sign(lease,op,attempt);
      if (!op.signature || !op.encryptedSignedPayload) { await this.deps.store.manualReview(lease); return true; }
      const signed = openPayload(op.encryptedSignedPayload,this.deps.wrappingKey,op.id,'signed');
      const tx = Transaction.from(Buffer.from(signed,'base64'));
      if (!tx.verifySignatures() || tx.feePayer?.toBase58() !== attempt.campaign.sponsorPublicKey
        || tx.serializeMessage().toString('base64') !== op.messageBase64
        || createHash('sha256').update(tx.serializeMessage()).digest('hex') !== op.messageHash) throw new ExecutionError('evidence_invalid');
      if (op.kind === 'registration') {
        const q = attempt.quote;
        if (q.messageBase64 !== op.messageBase64 || q.messageSha256 !== op.messageHash) throw new ExecutionError('evidence_invalid');
        validateSponsoredMessage(tx.serializeMessage(),{ label:q.name,sponsor:new PublicKey(q.sponsor),attemptPayer:new PublicKey(q.attemptPayer),user:new PublicKey(q.user),
          feeReceiver:new PublicKey(q.feeReceiver),registrationPrice:BigInt(q.cost.registrationPrice),domainRent:BigInt(q.cost.domainRent),primaryRent:BigInt(q.cost.primaryRent),blockhash:q.blockhash });
      } else if (buildRecoveryTransaction(this.recoveryInput(op,attempt)).messageBase64 !== op.messageBase64) throw new ExecutionError('evidence_invalid');
      const observed = await this.deps.chain.observe(op,attempt);
      if (observed.status === 'finalized' && observed.receipt) {
        const settlement = verifySettlement(op,attempt,observed,signed);
        await this.deps.store.settle(lease,settlement);
        // A separate scan closes the crash gap between registration settlement
        // and recovery preparation, so this enqueue need not share its transaction.
        return true;
      }
      if (observed.status === 'finalized' || observed.finalizedBlockHeight > op.lastValidBlockHeight) {
        await this.deps.store.manualReview(lease); return true;
      }
      if (observed.status === 'confirmed') await this.deps.store.note(lease,'confirmed');
      else if (op.status !== 'manual_review' && op.status !== 'confirmed') await this.broadcast(lease);
      await this.deps.store.reschedule(lease,Math.min(30_000,1_000*2**Math.min(lease.retryCount,5)));
      return true;
    } catch (error) {
      // A lost persistence acknowledgement must never cause a send. A later
      // worker loads whatever actually committed and reuses those bytes.
      if ((error instanceof ExecutionError && ['quote_expired','policy_changed','evidence_invalid'].includes(error.code))
        || error instanceof ExecutionCryptoError || error instanceof SponsoredMessagePolicyError || error instanceof CampaignError) {
        await this.deps.store.manualReview(lease).catch(() => undefined);
      } else {
        await this.deps.store.reschedule(lease,Math.min(60_000,3_000*lease.retryCount)).catch(() => undefined);
      }
      return true;
    }
  }
  async recover(id: string): Promise<void> {
    await this.deps.assertRuntime?.();
    await prepareResidualRecovery(this.deps.store,this.deps.chain,id);
  }
  async tick(): Promise<void> {
    await this.deps.assertRuntime?.();
    await this.deps.campaigns.sweepUnsigned();
    await this.processOne();
    for (const id of await this.deps.store.pendingRecoveries()) {
      try { await this.recover(id); } catch { /* Retain Q and retry this durable pending state next tick. */ }
    }
  }
}
