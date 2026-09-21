import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../../config/schema';
import { ConfigError } from '../../config/schema';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';

/** Bind worker availability to the same sponsor, encryption key and chain policy. */
export function executionIdentity(config: RuntimeConfig): string {
  if (!config.relayEnabled || !config.sponsorPublicKey || !config.attemptEncryptionKey
    || config.expectedGenesisHash !== COOKIE_REGISTRY_POLICY.genesisHash) throw new ConfigError(['RELAY_ENABLED']);
  return createHash('sha256').update(JSON.stringify(['first-bite-execution', 1,
    config.sponsorPublicKey, config.attemptEncryptionKey, config.expectedGenesisHash, COOKIE_REGISTRY_POLICY.id,
  ])).digest('hex');
}

export function executionHeartbeatPattern(identity: string): string {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new ConfigError(['RELAY_ENABLED']);
  return `^execution:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:${identity}$`;
}
