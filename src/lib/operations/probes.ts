import type { Pool } from 'pg';
import { AccountingStore } from './accounting';
import { createRegistryHealthProbe } from '../chain/client';
import type { OperationalProbes, OperationalSnapshot } from './readiness';
import { executionHeartbeatPattern } from '../execution/runtime-identity';

/** Read-only admission; a matching worker heartbeat is required in enabled runtimes. */
export function createOperationalProbes(pool: Pool, config: { cookieRpcUrl: string; expectedGenesisHash: string;
  relayEnabled?: boolean; sponsorPublicKey?: string | undefined; executionIdentity?: string }): OperationalProbes {
  const accounting = new AccountingStore(pool);
  return {
    signer: { enabled: config.relayEnabled === true && Boolean(config.executionIdentity), publicKey: config.sponsorPublicKey ?? null },
    expectedGenesisHash: config.expectedGenesisHash,
    chain: createRegistryHealthProbe(config.cookieRpcUrl, { requestTimeoutMs: 3_000 }),
    async snapshot(campaignId): Promise<OperationalSnapshot> {
      const report = await accounting.inspectCampaign(campaignId);
      const c = report.campaign;
      const workerFresh = config.executionIdentity ? (await pool.query<{ fresh: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM service_heartbeats WHERE worker_id ~ $1
          AND last_seen_at >= clock_timestamp()-interval '30 seconds'
          AND last_seen_at <= clock_timestamp()+interval '5 seconds') AS fresh`,
      [executionHeartbeatPattern(config.executionIdentity)])).rows[0]?.fresh === true : false;
      return { checkedAtMs: Date.parse(report.asOf), migrated: report.health.migrated, workerFresh,
        accountingConsistent: report.consistent, manualReviews: report.totals.manualReviewAttempts,
        sponsorHeldNative: BigInt(report.health.sponsorHeldNative),
        campaign: { ...c, name: c.slug, startsAt: new Date(c.startsAt), endsAt: new Date(c.endsAt),
          limits: { maxRegistrationPrice: BigInt(c.maxRegistrationPriceNative), maxTransactionFee: BigInt(c.maxTransactionFeeNative),
            recoveryAllowance: BigInt(c.recoveryAllowanceNative), maxReservation: BigInt(c.maxReservationNative), ttlMs: 45_000 } } };
    },
  };
}
