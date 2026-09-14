import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { buildRecoveryTransaction } from './crypto';
import type { ExecutionStore } from './store';
import { ExecutionError, type ExecutionChain } from './types';

/** Operator/worker preparation only: reserve a sweep fee and job without reading a signer or broadcasting. */
export async function prepareResidualRecovery(store: ExecutionStore, chain: ExecutionChain, id: string): Promise<void> {
  const a = await store.load(id);
  if (a.residualNative === null || BigInt(a.residualNative) <= 0n) return;
  const input = { sponsor:a.campaign.sponsorPublicKey,payer:a.payerPublicKey,amount:BigInt(a.residualNative),maxFee:a.campaign.limits.recoveryAllowance };
  if (new PublicKey(input.sponsor).equals(new PublicKey(input.payer))) throw new ExecutionError('policy_changed');
  const pre = await chain.prepareRecovery(input);
  const message = buildRecoveryTransaction({ ...input,blockhash:pre.blockhash });
  await store.reserveRecovery(id,{ operationId:randomUUID(),amount:input.amount,fee:pre.fee,blockhash:pre.blockhash,
    lastValidBlockHeight:pre.lastValidBlockHeight,messageHash:message.messageHash,messageBase64:message.messageBase64,checkedAtMs:pre.preparedAtMs });
}
