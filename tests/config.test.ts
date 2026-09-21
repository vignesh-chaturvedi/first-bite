import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { ConfigError, parseConfig, requireDatabaseUrl } from '../src/config/schema';
import { COOKIE_REGISTRY_POLICY } from '../src/lib/chain/policy';

const sponsorPublicKey = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey.toBase58();
const activeEnvironment = {
  NODE_ENV: 'production', APP_ORIGIN: 'https://first-bite.example',
  DATABASE_URL: 'postgresql://localhost/first_bite_test', ATTEMPT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PREPARATION_ENABLED: 'true', WORKER_ENABLED: 'true', RELAY_ENABLED: 'true', SPONSOR_PUBLIC_KEY: sponsorPublicKey,
};

describe('runtime configuration', () => {
  it('permits an unfunded shell and ignores signing secrets', () => {
    const config = parseConfig({ SPONSOR_PRIVATE_KEY: 'never-consume-this', NEXT_PUBLIC_SPONSOR_PRIVATE_KEY: 'also-ignored',
      get SPONSOR_SECRET_KEY_BASE64() { throw new Error('Common config must not read the worker secret'); },
      get NEXT_PUBLIC_SPONSOR_SECRET_KEY_BASE64() { throw new Error('Common config must not read public secrets'); } });
    expect(config).toMatchObject({ nodeEnv: 'development', relayEnabled: false, workerEnabled: false, databaseUrl: undefined,
      preparationEnabled: false, attemptEncryptionKey: undefined, trustedIpHeader: 'none' });
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
    ['RELAY_ENABLED', '1'], ['WORKER_ENABLED', 'yes'],
    ['WORKER_ENABLED', 'FALSE'], ['WORKER_ENABLED', ''], ['NODE_ENV', 'staging'],
    ['APP_ORIGIN', ''], ['APP_ORIGIN', 'bad-origin-with-secret'],
    ['COOKIE_RPC_URL', ''], ['COOKIE_RPC_URL', 'bad-rpc-with-secret'],
    ['APP_ORIGIN', 'https://example.com/path'], ['APP_ORIGIN', 'https://example.com?token=secret'],
    ['APP_ORIGIN', 'https://user:secret@example.com'], ['COOKIE_RPC_URL', 'file:///tmp/rpc'],
    ['DATABASE_URL', 'https://user:secret@example.com/db'], ['DATABASE_URL', ''],
    ['DATABASE_URL', 'postgres://user:secret@localhost'],
    ['EXPECTED_GENESIS_HASH', 'not-cookie'],
    ['PREPARATION_ENABLED', 'yes'], ['PREPARATION_ENABLED', 'TRUE'],
    ['ATTEMPT_ENCRYPTION_KEY', 'secret'], ['ATTEMPT_ENCRYPTION_KEY', 'A'.repeat(42) + 'B='],
    ['TRUSTED_IP_HEADER', 'x-forwarded-for'],
    ['SPONSOR_PUBLIC_KEY', 'secret'], ['SPONSOR_PUBLIC_KEY', `1${sponsorPublicKey}`],
    ['SPONSOR_PUBLIC_KEY', PublicKey.findProgramAddressSync([Buffer.from('invalid-signer')], SystemProgram.programId)[0].toBase58()],
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

  it('requires database and key before preparation can be enabled', () => {
    expect(() => parseConfig({ PREPARATION_ENABLED: 'true' })).toThrow('Invalid configuration: DATABASE_URL, ATTEMPT_ENCRYPTION_KEY');
    const config = parseConfig({ PREPARATION_ENABLED: 'true', DATABASE_URL: 'postgresql://localhost/first_bite_dev',
      ATTEMPT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), APP_ORIGIN: 'http://127.0.0.1:3000', TRUSTED_IP_HEADER: 'x-real-ip' });
    expect(config.preparationEnabled).toBe(true);
    expect(config.relayEnabled).toBe(false);
    expect(config.trustedIpHeader).toBe('x-real-ip');
  });

  it('accepts an explicitly enabled production service without reading or requiring the worker secret', () => {
    const config = parseConfig({ ...activeEnvironment,
      get SPONSOR_SECRET_KEY_BASE64() { throw new Error('Web service must not load the sponsor secret'); } });
    expect(config).toMatchObject({ relayEnabled: true, preparationEnabled: true, workerEnabled: true, sponsorPublicKey,
      expectedGenesisHash: COOKIE_REGISTRY_POLICY.genesisHash });
    expect(Object.keys(config)).not.toContain('sponsorSecretKeyBase64');
  });

  it.each(['PREPARATION_ENABLED', 'WORKER_ENABLED', 'DATABASE_URL', 'ATTEMPT_ENCRYPTION_KEY', 'SPONSOR_PUBLIC_KEY'])(
    'rejects relay activation without %s', (field) => {
      try {
        parseConfig({ ...activeEnvironment, [field]: undefined });
        expect.fail('Expected configuration rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).fields).toContain(field);
      }
    },
  );

  it.each([
    { NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3000' },
    { NODE_ENV: 'production', APP_ORIGIN: 'http://first-bite.example' },
    { NODE_ENV: 'development', APP_ORIGIN: 'http://first-bite.example' },
    { NODE_ENV: 'test', APP_ORIGIN: 'http://first-bite.example' },
  ])('rejects preparation over insecure nonlocal or production HTTP', (environment) => {
    expect(() => parseConfig({ ...activeEnvironment, ...environment })).toThrow('Invalid configuration: APP_ORIGIN');
  });

  it.each([
    { NODE_ENV: 'production', APP_ORIGIN: 'https://first-bite.example' },
    { NODE_ENV: 'development', APP_ORIGIN: 'https://first-bite.example' },
    { NODE_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:3000' },
    { NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:3000' },
    { NODE_ENV: 'test', APP_ORIGIN: 'http://[::1]:3000' },
  ])('permits HTTPS or local development HTTP', (environment) => {
    expect(parseConfig({ ...activeEnvironment, ...environment }).relayEnabled).toBe(true);
  });

  it.each(['true', 'false'])('rejects another genesis while preparation is enabled (relay=%s)', (relayEnabled) => {
    expect(() => parseConfig({ ...activeEnvironment, RELAY_ENABLED: relayEnabled, EXPECTED_GENESIS_HASH: sponsorPublicKey }))
      .toThrow('Invalid configuration: EXPECTED_GENESIS_HASH');
  });

  it('does not activate execution from a public environment flag', () => {
    expect(parseConfig({ NEXT_PUBLIC_RELAY_ENABLED: 'true', NEXT_PUBLIC_SPONSOR_PUBLIC_KEY: sponsorPublicKey }))
      .toMatchObject({ relayEnabled: false, sponsorPublicKey: undefined });
  });
});
