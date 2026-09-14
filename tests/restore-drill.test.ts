import { describe, expect, it } from 'vitest';
import { assertDrillContainer, drillDatabaseName, drillDatabaseUrl, fingerprintRows, parseDrillOptions,
  parseLocalDockerHost, RestoreDrillError } from '../scripts/ops/restore-drill';

const options = ['--container', 'first-bite-phase6-postgres', '--port', '55432'];
const container = { running: true, label: 'local-only', image: 'postgres:17.11',
  bindings: [{ HostIp: '127.0.0.1', HostPort: '55432' }] };

describe('local restore drill boundaries', () => {
  it('accepts only the explicit disposable container and port', () => {
    expect(parseDrillOptions(options)).toEqual({ container: 'first-bite-phase6-postgres', port: 55432 });
    expect(parseDrillOptions(['--container', 'first-bite-restore-drill-ci', '--port', '55432'], 'test'))
      .toEqual({ container: 'first-bite-restore-drill-ci', port: 55432 });
  });
  it.each([
    [], ['--container', 'production-db', '--port', '55432'], ['--container', 'first-bite-phase6-postgres'],
    [...options, '--database', 'first_bite_dev'], [...options, 'extra'],
    ['--container', 'first-bite-phase6-postgres;echo secret', '--port', '55432'],
    ['--container', 'first-bite-phase6-postgres', '--port', '543'],
    ['--container', 'first-bite-phase6-postgres', '--port', '65536'],
    ['--container', 'first-bite-phase6-postgres', '--port', '05543'],
    ['--container', 'first-bite-phase6-postgres', '--port', '55432?options=other'],
  ].map((args) => ({ args })))('refuses unsafe or implicit command options: $args', ({ args }) => {
    expect(() => parseDrillOptions(args)).toThrow(RestoreDrillError);
  });
  it('refuses production mode even with local fixture options', () => {
    expect(() => parseDrillOptions(options, 'production')).toThrow(RestoreDrillError);
  });
  it('pins only a local Unix Docker socket', () => {
    expect(parseLocalDockerHost('"unix:///Users/example/.docker/run/docker.sock"'))
      .toBe('unix:///Users/example/.docker/run/docker.sock');
  });
  it.each(['"tcp://127.0.0.1:2375"', '"ssh://production"', '"https://remote.example"',
    '"unix://relative.sock"', '"unix:///tmp/with space.sock"', 'null', '{}', 'secret-invalid-json'])('rejects nonlocal or invalid Docker endpoints: %s', (value) => {
    expect(() => parseLocalDockerHost(value)).toThrow('Local restore drill failed');
  });
  it('requires the disposable label, exact PostgreSQL version, and loopback mapping', () => {
    expect(() => assertDrillContainer(JSON.stringify(container), 55432)).not.toThrow();
    expect(() => assertDrillContainer(JSON.stringify({ ...container, image: `postgres:17.11@sha256:${'a'.repeat(64)}` }), 55432)).not.toThrow();
  });
  it.each([
    { ...container, running: false }, { ...container, label: undefined }, { ...container, label: 'production' },
    { ...container, image: 'postgres:latest' }, { ...container, image: 'postgres:16' },
    { ...container, bindings: [{ HostIp: '0.0.0.0', HostPort: '55432' }] },
    { ...container, bindings: [{ HostIp: '127.0.0.1', HostPort: '5432' }] },
    { ...container, bindings: [...container.bindings, { HostIp: '0.0.0.0', HostPort: '5432' }] },
    { ...container, bindings: null }, { ...container, bindings: [] },
  ])('rejects an unrelated or publicly exposed container: %j', (value) => {
    expect(() => assertDrillContainer(JSON.stringify(value), 55432)).toThrow(RestoreDrillError);
  });
  it('creates deterministic identifiers from a fresh random run ID only', () => {
    expect(drillDatabaseName('a'.repeat(24), 'source')).toBe(`first_bite_drill_${'a'.repeat(24)}_source`);
    expect(drillDatabaseName('b'.repeat(24), 'restore')).toBe(`first_bite_drill_${'b'.repeat(24)}_restore`);
    expect(() => drillDatabaseName('first_bite_dev', 'restore')).toThrow(RestoreDrillError);
    expect(() => drillDatabaseName('a'.repeat(24) + '";DROP DATABASE postgres', 'source')).toThrow(RestoreDrillError);
  });
  it('cannot connect to an existing application database or a remote URL', () => {
    for (const database of ['first_bite_dev', 'first_bite_test', 'production', '../postgres',
      'postgres?host=remote.example', 'first_bite_drill_short_restore']) {
      expect(() => drillDatabaseUrl(55432, database)).toThrow(RestoreDrillError);
    }
    expect(drillDatabaseUrl(55432, drillDatabaseName('a'.repeat(24), 'source')))
      .toBe(`postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_drill_${'a'.repeat(24)}_source`);
    expect(() => drillDatabaseUrl(70000, 'postgres')).toThrow(RestoreDrillError);
  });
  it('compares exact JSON rows independent of physical restore order', () => {
    const before = ['{"id":"b","native":"90071992547409930"}', '{"id":"a","payload":"encrypted"}'];
    expect(fingerprintRows(before)).toEqual(fingerprintRows([...before].reverse()));
    expect(fingerprintRows(before).count).toBe(2);
    expect(fingerprintRows([before[0]!.replace('930', '931'), before[1]!])).not.toEqual(fingerprintRows(before));
    expect(fingerprintRows(before).sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('sanitizes errors without including option contents or database credentials', () => {
    try { parseDrillOptions(['--database', 'postgres://secret:password@production/private']); }
    catch (error) {
      expect(error).toBeInstanceOf(RestoreDrillError);
      expect(String(error)).toBe('Error: Local restore drill failed');
      expect((error as RestoreDrillError).code).toBe('invalid_options');
    }
  });
});
