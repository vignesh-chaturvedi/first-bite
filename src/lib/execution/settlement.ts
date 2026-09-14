import { createHash } from 'node:crypto';
import { Transaction } from '@solana/web3.js';
import { ExecutionError, type ExecutionAttempt, type ExecutionObservation, type ExecutionOperation, type Settlement } from './types';

/** Derive costs from the exact finalized receipt; never infer payment from account ownership alone. */
export function verifySettlement(op: ExecutionOperation, attempt: ExecutionAttempt, observation: ExecutionObservation, signedBase64: string): Settlement {
  try {
    const r = observation.receipt;
    if (observation.status !== 'finalized' || !r || r.signedBase64 !== signedBase64 || observation.accountSlot < r.slot
      || !Number.isSafeInteger(r.slot) || r.slot < 0 || typeof r.fee !== 'bigint' || r.fee < 0n || r.fee > BigInt(op.feeCapNative)) throw new Error();
    const tx = Transaction.from(Buffer.from(signedBase64, 'base64'));
    const message = tx.compileMessage();
    if (!tx.verifySignatures() || createHash('sha256').update(tx.serializeMessage()).digest('hex') !== op.messageHash
      || r.accountKeys.length !== message.accountKeys.length || r.preBalances.length !== r.accountKeys.length || r.postBalances.length !== r.accountKeys.length
      || !r.accountKeys.every((key,i) => key === message.accountKeys[i]!.toBase58())
      || [...r.preBalances,...r.postBalances].some((v) => typeof v !== 'bigint' || v < 0n)) throw new Error();
    const index = (key: string) => { const i = r.accountKeys.indexOf(key); if (i < 0) throw new Error(); return i; };
    const sponsor = index(attempt.campaign.sponsorPublicKey); const payer = index(attempt.payerPublicKey);
    const delta = (i: number) => r.postBalances[i]! - r.preBalances[i]!;
    if (sponsor !== 0 || r.preBalances[payer] !== 0n && op.kind === 'registration') throw new Error();
    if (r.failed) {
      if (delta(sponsor) !== -r.fee || r.accountKeys.some((_,i) => i !== sponsor && delta(i) !== 0n)) throw new Error();
      const residual = r.postBalances[payer]!;
      if (observation.payerBalance !== residual) throw new Error();
      return { success: false, fee: r.fee, debit: r.fee, recovered: 0n, residual, slot: r.slot };
    }
    if (op.kind === 'recovery') {
      const amount = BigInt(op.amountNative);
      if (r.preBalances[payer] !== amount || r.postBalances[payer] !== 0n || delta(sponsor) !== amount-r.fee
        || observation.payerBalance !== 0n || r.accountKeys.some((_,i) => i !== payer && i !== sponsor && delta(i) !== 0n)) throw new Error();
      return { success: true, fee: r.fee, debit: r.fee, recovered: amount, residual: 0n, slot: r.slot };
    }
    const q = attempt.quote;
    const domain = index(q.expected.domain); const primary = index(q.expected.primary); const user = index(q.user); const receiver = index(q.feeReceiver);
    const price = BigInt(q.cost.registrationPrice); const domainRent = BigInt(q.cost.domainRent); const primaryRent = BigInt(q.cost.primaryRent);
    const paidPrice = delta(receiver); const residual = r.postBalances[payer]!;
    // The registry can lower its price after signing. Allocation and sponsor debit
    // stay fixed, and the unused amount belongs to A until a finalized sweep.
    if (paidPrice < 0n || paidPrice > price || residual !== price-paidPrice || delta(domain) !== domainRent || delta(primary) !== primaryRent
      || delta(user) !== 0n || delta(sponsor) !== -(price+domainRent+primaryRent+r.fee) || observation.payerBalance !== residual
      || observation.domainOwner !== q.user || observation.primaryOwner !== q.user || observation.primaryName !== q.name
      || r.accountKeys.some((_,i) => ![sponsor,payer,domain,primary,user,receiver].includes(i) && delta(i) !== 0n)) throw new Error();
    return { success: true, fee: r.fee, debit: price+domainRent+primaryRent+r.fee, recovered: 0n, residual, slot: r.slot };
  } catch { throw new ExecutionError('evidence_invalid'); }
}
