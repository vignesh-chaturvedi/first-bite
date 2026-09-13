import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, requireDatabaseUrl } from '../src/config/schema';

describe('runtime configuration', () => {
  it('permits an unfunded shell and ignores signing secrets', () => {
    const config = parseConfig({ SPONSOR_PRIVATE_KEY: 'never-consume-this', NEXT_PUBLIC_SPONSOR_PRIVATE_KEY: 'also-ignored' });
    expect(config).toMatchObject({ nodeEnv: 'development', relayEnabled: false, workerEnabled: false, databaseUrl: undefined });
    expect(JSON.stringify(config)).not.toContain('never-consume-this');
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => requireDatabaseUrl(config)).toThrow('Invalid configuration: DATABASE_URL');
  });

  it('parses false as false and requires a database for an enabled worker', () => {
    expect(parseConfig({ WORKER_ENABLED: 'false', RELAY_ENABLED: 'false' }).workerEnabled).toBe(false);
    expect(() => parseConfig({ WORKER_ENABLED: 'true' })).toThrow(ConfigError);
    const config = parseConfig({ WORKER_ENABLED: 'true', DATABASE_URL: 'postgresql://localhost:55432/first_bite_dev' });
    expect(config.workerEnabled).toBe(true);
    expect(requireDatabaseUrl(config)).toBe('postgresql://localhost:55432/first_bite_dev');
  });

  it.each([
    ['RELAY_ENABLED', 'true'], ['RELAY_ENABLED', '1'], ['WORKER_ENABLED', 'yes'],
    ['WORKER_ENABLED', 'FALSE'], ['WORKER_ENABLED', ''], ['NODE_ENV', 'staging'],
    ['APP_ORIGIN', ''], ['APP_ORIGIN', 'bad-origin-with-secret'],
    ['COOKIE_RPC_URL', ''], ['COOKIE_RPC_URL', 'bad-rpc-with-secret'],
    ['APP_ORIGIN', 'https://example.com/path'], ['APP_ORIGIN', 'https://example.com?token=secret'],
    ['APP_ORIGIN', 'https://user:secret@example.com'], ['COOKIE_RPC_URL', 'file:///tmp/rpc'],
    ['DATABASE_URL', 'https://user:secret@example.com/db'], ['DATABASE_URL', ''],
    ['DATABASE_URL', 'postgres://user:secret@localhost'],
    ['EXPECTED_GENESIS_HASH', 'not-cookie'],
  ])('rejects malformed or unsupported %s without exposing its value', (field, value) => {
    try {
      parseConfig({ [field]: value });
      expect.fail('Expected configuration rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).fields).toEqual([field]);
      expect((error as Error).message).toBe(`Invalid configuration: ${field}`);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects boolean values instead of coercing arbitrary input to enabled', () => {
    expect(() => parseConfig({ WORKER_ENABLED: true })).toThrow(ConfigError);
  });

  it('normalizes a plain origin and accepts a private server RPC URL', () => {
    const config = parseConfig({ APP_ORIGIN: 'https://example.com/', COOKIE_RPC_URL: 'https://rpc.example.com?token=private' });
    expect(config.appOrigin).toBe('https://example.com');
    expect(config.cookieRpcUrl).toBe('https://rpc.example.com?token=private');
  });
});
