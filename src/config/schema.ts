import { z } from 'zod';

export const CONFIG_FIELDS = [
  'NODE_ENV', 'APP_ORIGIN', 'COOKIE_RPC_URL', 'EXPECTED_GENESIS_HASH',
  'DATABASE_URL', 'WORKER_ENABLED', 'RELAY_ENABLED',
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

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: origin.default('http://localhost:3000'),
  COOKIE_RPC_URL: webUrl.default('https://rpc.cookiescan.io'),
  // Recorded in the Phase 0 read-only evidence; runtime chain checks come later.
  EXPECTED_GENESIS_HASH: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .default('9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2'),
  DATABASE_URL: postgresUrl.optional(),
  WORKER_ENABLED: booleanSetting,
  RELAY_ENABLED: booleanSetting.refine((enabled) => !enabled),
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
  // Pick only supported settings: no sponsor/signing secret is read or returned.
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
  if (value.WORKER_ENABLED && !value.DATABASE_URL) throw new ConfigError(['DATABASE_URL']);
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    appOrigin: value.APP_ORIGIN,
    cookieRpcUrl: value.COOKIE_RPC_URL,
    expectedGenesisHash: value.EXPECTED_GENESIS_HASH,
    databaseUrl: value.DATABASE_URL,
    workerEnabled: value.WORKER_ENABLED,
    relayEnabled: false as const,
  });
}

export type RuntimeConfig = ReturnType<typeof parseConfig>;

export function requireDatabaseUrl(config: RuntimeConfig): string {
  if (!config.databaseUrl) throw new ConfigError(['DATABASE_URL']);
  return config.databaseUrl;
}
