import type { Pool } from 'pg';
import type { RuntimeConfig } from '../../config/schema';
import { CampaignStore } from '../campaigns/store';
import { createRegistryClient, type RegistryClient } from '../chain/client';
import { createOperationalProbes } from '../operations/probes';
import { evaluateOperationalReadiness, type OperationalProbes } from '../operations/readiness';
import { createExecutionChain } from './chain';
import { executionIdentity } from './runtime-identity';
import { assertRuntimeBinding } from './runtime-binding';
import { ExecutionService } from './service';
import { ExecutionStore } from './store';
import { ExecutionError, type ExecutionChain, type ExecutionSigner } from './types';

/** Trusted dependency injection for local integration tests, never HTTP input. */
export interface RuntimePorts { chain?: ExecutionChain; registry?: RegistryClient; probes?: OperationalProbes }

function common(pool: Pool, config: RuntimeConfig, ports: RuntimePorts) {
  const identity = executionIdentity(config);
  const campaigns = new CampaignStore(pool);
  const store = new ExecutionStore(pool, config.sponsorPublicKey);
  const registry = ports.registry ?? createRegistryClient(config.cookieRpcUrl);
  const probes = ports.probes ?? createOperationalProbes(pool, { ...config, executionIdentity: identity });
  const assertRuntime = () => assertRuntimeBinding(pool, config);
  const admission = async (campaignId: string) => {
    await assertRuntime();
    return evaluateOperationalReadiness(campaignId, probes);
  };
  return { campaigns, store, registry, admission, assertRuntime };
}

/** The web process can authorize work, but has no sponsor key or broadcast method. */
export function createSubmissionRuntime(pool: Pool, config: RuntimeConfig, ports: RuntimePorts = {}) {
  const shared = common(pool, config, ports);
  const engine = new ExecutionService({ ...shared, wrappingKey: config.attemptEncryptionKey!,
    chain: ports.chain ?? createExecutionChain(config.cookieRpcUrl, { registry: shared.registry }),
    signer: { publicKey: config.sponsorPublicKey!, secret: () => { throw new ExecutionError('disabled'); } },
  });
  return { ...shared, service: { submit: engine.submit.bind(engine), retry: engine.retry.bind(engine) } };
}

/** Only the separately configured worker gets custody and broadcast capability. */
export function createWorkerRuntime(pool: Pool, config: RuntimeConfig, signer: ExecutionSigner, ports: RuntimePorts = {}) {
  const shared = common(pool, config, ports);
  if (signer.publicKey !== config.sponsorPublicKey) throw new ExecutionError('policy_changed');
  const service = new ExecutionService({ ...shared, wrappingKey: config.attemptEncryptionKey!, signer,
    chain: ports.chain ?? createExecutionChain(config.cookieRpcUrl, { registry: shared.registry, allowBroadcast: true }),
  });
  return { ...shared, service };
}
