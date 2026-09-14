import type { Pool } from 'pg';
import { AccountingStore } from './accounting';
import { createRegistryHealthProbe } from '../chain/client';
import type { OperationalProbes, OperationalSnapshot } from './readiness';

/** Used by local operator diagnostics. Runtime custody/activation remains disabled. */
export function createOperationalProbes(pool: Pool, config: { cookieRpcUrl: string; expectedGenesisHash: string }): OperationalProbes {
  const accounting = new AccountingStore(pool);
  return {
    signer: { enabled: false, publicKey: null },
    expectedGenesisHash: config.expectedGenesisHash,
    chain: createRegistryHealthProbe(config.cookieRpcUrl, { requestTimeoutMs: 3_000 }),
    async snapshot(campaignId): Promise<OperationalSnapshot> {
      const report = await accounting.inspectCampaign(campaignId);
      const c = report.campaign;
      return { checkedAtMs: Date.parse(report.asOf), migrated: report.health.migrated, workerFresh: report.health.executionWorkerFresh,
        accountingConsistent: report.consistent, manualReviews: report.totals.manualReviewAttempts,
        sponsorHeldNative: BigInt(report.health.sponsorHeldNative),
        campaign: { ...c, name: c.slug, startsAt: new Date(c.startsAt), endsAt: new Date(c.endsAt),
          limits: { maxRegistrationPrice: BigInt(c.maxRegistrationPriceNative), maxTransactionFee: BigInt(c.maxTransactionFeeNative),
            recoveryAllowance: BigInt(c.recoveryAllowanceNative), maxReservation: BigInt(c.maxReservationNative), ttlMs: 45_000 } } };
    },
  };
}
