import 'server-only';
import { ConfigError } from '../config/schema';
import { getServerConfig } from '../config/server';
import { createRegistryClient, type RegistryClient } from '../lib/chain/client';
import { COOKIE_REGISTRY_POLICY } from '../lib/chain/policy';

let client: RegistryClient | undefined;

/** Reviewed chain reader shared by invitation preparation. */
export function getServerRegistry(): RegistryClient {
  const config = getServerConfig();
  if (config.expectedGenesisHash !== COOKIE_REGISTRY_POLICY.genesisHash) {
    throw new ConfigError(['EXPECTED_GENESIS_HASH']);
  }
  client ??= createRegistryClient(config.cookieRpcUrl);
  return client;
}
