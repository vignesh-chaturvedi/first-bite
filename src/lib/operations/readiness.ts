import type { CampaignContext } from '../campaigns/types';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';
import { RegistryClientError, type RegistryHealth } from '../chain/client';

export const OPERATIONAL_EVIDENCE_MS = 5_000;
export interface OperationalSnapshot {
  checkedAtMs: number; migrated: boolean; workerFresh: boolean;
  campaign: CampaignContext; accountingConsistent: boolean; manualReviews: number;
  /** Across every campaign using this sponsor, including paused campaigns. */
  sponsorHeldNative: bigint;
}
export type OperationalFailure = 'database_unavailable' | 'migration_missing' | 'worker_stale' | 'accounting_mismatch'
  | 'campaign_unavailable' | 'policy_changed' | 'rpc_unavailable' | 'sponsor_underfunded' | 'manual_review'
  | 'signer_disabled' | 'signer_mismatch' | 'stale_evidence' | 'timeout';
export interface OperationalReadiness {
  scope: 'sponsorship'; campaignId: string; checkedAtMs: number;
  newSignaturesAllowed: boolean; canPrepare: boolean; failures: OperationalFailure[];
  /** Public-key accounting only; this result is for the operator, not public HTTP. */
  funding?: { balanceNative: string; heldNative: string; nextPassFloorNative: string };
}
export interface OperationalProbes {
  snapshot(campaignId: string): Promise<OperationalSnapshot>;
  chain(sponsor: string): Promise<RegistryHealth>;
  signer: { enabled: boolean; publicKey: string | null };
  expectedGenesisHash: string;
  now?: () => number;
}

/** Fresh, bounded, uncached admission check. Reconciliation never depends on this check. */
export async function evaluateOperationalReadiness(campaignId: string, deps: OperationalProbes, timeoutMs = 4_500): Promise<OperationalReadiness> {
  const now = deps.now ?? Date.now;
  const denied = (failure: OperationalFailure): OperationalReadiness => ({ scope: 'sponsorship', campaignId,
    checkedAtMs: now(), newSignaturesAllowed: false, canPrepare: false, failures: [failure] });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OPERATIONAL_EVIDENCE_MS) return denied('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<OperationalReadiness> => {
    let snapshot: OperationalSnapshot;
    try { snapshot = structuredClone(await deps.snapshot(campaignId)); }
    catch { return denied('database_unavailable'); }
    const { campaign: c } = snapshot;
    if (c.id !== campaignId) return denied('database_unavailable');
    const failures: OperationalFailure[] = [];
    if (!snapshot.migrated) failures.push('migration_missing');
    if (!snapshot.workerFresh) failures.push('worker_stale');
    if (!snapshot.accountingConsistent) failures.push('accounting_mismatch');
    if (snapshot.manualReviews > 0) failures.push('manual_review');
    if (c.status !== 'active' || c.startsAt.getTime() > now() || c.endsAt.getTime() <= now()) failures.push('campaign_unavailable');
    if (c.policyVersion !== COOKIE_REGISTRY_POLICY.id || deps.expectedGenesisHash !== COOKIE_REGISTRY_POLICY.genesisHash) failures.push('policy_changed');
    if (!deps.signer.enabled) failures.push('signer_disabled');
    else if (deps.signer.publicKey !== c.sponsorPublicKey) failures.push('signer_mismatch');
    const cap = BigInt(c.capNative), held = BigInt(c.reservedNative), spent = BigInt(c.spentNative);
    const available = cap - held - spent;
    if (held < 0n || spent < 0n || available < 0n || snapshot.sponsorHeldNative < held
      || c.reservedUsers < 0 || c.consumedUsers < 0 || c.reservedUsers + c.consumedUsers > c.maxUsers) failures.push('accounting_mismatch');
    let health: RegistryHealth | undefined;
    // A corrupt database/policy is not a reason to send an RPC request.
    if (!failures.some((f) => ['migration_missing', 'accounting_mismatch', 'policy_changed'].includes(f))) {
      try { health = { ...await deps.chain(c.sponsorPublicKey) }; }
      catch (error) { failures.push(error instanceof RegistryClientError && ['WRONG_CHAIN', 'POLICY_CHANGED'].includes(error.code) ? 'policy_changed' : 'rpc_unavailable'); }
    }
    const checkedAtMs = now();
    const fresh = (at: number) => Number.isSafeInteger(at) && at <= checkedAtMs && checkedAtMs - at <= OPERATIONAL_EVIDENCE_MS;
    if (!fresh(snapshot.checkedAtMs) || (health && !fresh(health.checkedAtMs))) failures.push('stale_evidence');
    if (health && (health.genesisHash !== COOKIE_REGISTRY_POLICY.genesisHash || health.policyId !== c.policyVersion)) failures.push('policy_changed');
    if (health && (health.sponsorBalance < snapshot.sponsorHeldNative || health.sponsorBalance <= 0n)) failures.push('sponsor_underfunded');
    const newSignaturesAllowed = failures.length === 0;
    const floor = snapshot.sponsorHeldNative + c.limits.maxReservation;
    return { scope: 'sponsorship', campaignId, checkedAtMs, newSignaturesAllowed,
      canPrepare: newSignaturesAllowed && available >= c.limits.maxReservation
        && c.reservedUsers + c.consumedUsers < c.maxUsers && health!.sponsorBalance >= floor,
      failures: [...new Set(failures)], ...(health ? { funding: { balanceNative: health.sponsorBalance.toString(),
        heldNative: snapshot.sponsorHeldNative.toString(), nextPassFloorNative: floor.toString() } } : {}) };
  };
  try {
    return await Promise.race([run(), new Promise<OperationalReadiness>((resolve) => { timer = setTimeout(() => resolve(denied('timeout')), timeoutMs); })]);
  } catch { return denied('database_unavailable'); }
  finally { clearTimeout(timer); }
}
