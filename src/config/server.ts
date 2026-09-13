import 'server-only';
import { parseConfig, type RuntimeConfig } from './schema';

let config: RuntimeConfig | undefined;

/** Read lazily so building an unfunded static shell needs no database or keys. */
export function getServerConfig(): RuntimeConfig {
  config ??= parseConfig();
  return config;
}
