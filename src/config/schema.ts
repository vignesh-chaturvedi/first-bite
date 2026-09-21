import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { COOKIE_REGISTRY_POLICY } from '../lib/chain/policy';

export const CONFIG_FIELDS = [
  'NODE_ENV', 'APP_ORIGIN', 'COOKIE_RPC_URL', 'EXPECTED_GENESIS_HASH',
  'DATABASE_URL', 'WORKER_ENABLED', 'RELAY_ENABLED', 'PREPARATION_ENABLED',
  'ATTEMPT_ENCRYPTION_KEY', 'TRUSTED_IP_HEADER', 'SPONSOR_PUBLIC_KEY',
] as const;
export type ConfigField = typeof CONFIG_FIELDS[number];

const booleanSetting = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
// Zod refinements also run after a URL-format issue. Never let URL parsing throw
// its own error, which could include the rejected value or credentials.
function checkUrl(value: string, predicate: (url: URL) => boolean): boolean {
  try { return predicate(new URL(value)); } catch { return false; }
}
const webUrl = z.string().url().refine((value) => {
  return checkUrl(value, (url) => url.protocol === 'https:' || url.protocol === 'http:');
});
const origin = webUrl.refine((value) => {
  return checkUrl(value, (url) => !url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
}).transform((value) => new URL(value).origin);
const postgresUrl = z.string().url().refine((value) => {
  return checkUrl(value, (url) => (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
    && Boolean(url.hostname) && Boolean(url.pathname.slice(1)) && !url.hash);
});
const encryptionKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/).refine((value) => {
  const bytes = Buffer.from(value, 'base64');
  try { return bytes.length === 32 && bytes.toString('base64') === value; }
  finally { bytes.fill(0); }
});
const signerPublicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine((value) => {
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes());
  } catch { return false; }
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: origin.default('http://localhost:3000'),
  COOKIE_RPC_URL: webUrl.default('https://rpc.cookiescan.io'),
  EXPECTED_GENESIS_HASH: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .default(COOKIE_REGISTRY_POLICY.genesisHash),
  DATABASE_URL: postgresUrl.optional(),
  WORKER_ENABLED: booleanSetting,
  RELAY_ENABLED: booleanSetting,
  PREPARATION_ENABLED: booleanSetting,
  ATTEMPT_ENCRYPTION_KEY: encryptionKey.optional(),
  TRUSTED_IP_HEADER: z.enum(['none', 'x-real-ip', 'cf-connecting-ip']).default('none'),
  SPONSOR_PUBLIC_KEY: signerPublicKey.optional(),
});

export class ConfigError extends Error {
  readonly fields: readonly ConfigField[];

  constructor(fields: readonly ConfigField[]) {
    const uniqueFields = [...new Set(fields)];
    super(`Invalid configuration: ${uniqueFields.join(', ')}`);
    this.name = 'ConfigError';
    this.fields = uniqueFields;
  }
}

export function parseConfig(environment: Record<string, unknown> = process.env) {
  // Web and worker share only the public sponsor identity. The worker loads its
  // signing secret separately; neither it nor any NEXT_PUBLIC value is read here.
  const picked = Object.fromEntries(CONFIG_FIELDS.map((field) => [field, environment[field]]));
  const result = environmentSchema.safeParse(picked);
  if (!result.success) {
    const fields = result.error.issues.flatMap((issue) => {
      const key = issue.path[0];
      return CONFIG_FIELDS.filter((field) => field === key);
    });
    // Do not attach the Zod error: issues may contain rejected values.
    throw new ConfigError(fields);
  }
  const value = result.data;
  const fields: ConfigField[] = [];
  if (value.WORKER_ENABLED && !value.DATABASE_URL) fields.push('DATABASE_URL');
  if (value.PREPARATION_ENABLED || value.RELAY_ENABLED) {
    if (!value.DATABASE_URL) fields.push('DATABASE_URL');
    if (!value.ATTEMPT_ENCRYPTION_KEY) fields.push('ATTEMPT_ENCRYPTION_KEY');
    const appUrl = new URL(value.APP_ORIGIN);
    const localDevelopmentHttp = value.NODE_ENV !== 'production'
      && ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname) && appUrl.protocol === 'http:';
    if (appUrl.protocol !== 'https:' && !localDevelopmentHttp) fields.push('APP_ORIGIN');
    if (value.EXPECTED_GENESIS_HASH !== COOKIE_REGISTRY_POLICY.genesisHash) fields.push('EXPECTED_GENESIS_HASH');
  }
  if (value.RELAY_ENABLED) {
    if (!value.PREPARATION_ENABLED) fields.push('PREPARATION_ENABLED');
    if (!value.WORKER_ENABLED) fields.push('WORKER_ENABLED');
    if (!value.SPONSOR_PUBLIC_KEY) fields.push('SPONSOR_PUBLIC_KEY');
  }
  if (fields.length) throw new ConfigError(fields);
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    appOrigin: value.APP_ORIGIN,
    cookieRpcUrl: value.COOKIE_RPC_URL,
    expectedGenesisHash: value.EXPECTED_GENESIS_HASH,
    databaseUrl: value.DATABASE_URL,
    workerEnabled: value.WORKER_ENABLED,
    relayEnabled: value.RELAY_ENABLED,
    preparationEnabled: value.PREPARATION_ENABLED,
    attemptEncryptionKey: value.ATTEMPT_ENCRYPTION_KEY,
    trustedIpHeader: value.TRUSTED_IP_HEADER,
    sponsorPublicKey: value.SPONSOR_PUBLIC_KEY,
  });
}

export type RuntimeConfig = ReturnType<typeof parseConfig>;

export function requireDatabaseUrl(config: RuntimeConfig): string {
  if (!config.databaseUrl) throw new ConfigError(['DATABASE_URL']);
  return config.databaseUrl;
}
