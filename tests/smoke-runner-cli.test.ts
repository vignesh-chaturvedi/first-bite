import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRunnerKey, parseRunnerArgs } from '../scripts/phase0/registration-runner';
import { openSmokeJournal } from '../src/lib/smoke/journal';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(await realpath(tmpdir()), 'smoke-cli-')); await chmod(directory, 0o700); });
afterEach(async () => { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
const base = ['--state-dir', '/private/tmp/check/journal', '--key-file', '/private/tmp/check/master.key'];

describe('one-registration CLI', () => {
  it('defaults to sending disabled and only enables an explicit serve flag', () => {
    expect(parseRunnerArgs(['serve', ...base])).toMatchObject({ command: 'serve', allowLive: false, port: 8788 });
    expect(parseRunnerArgs(['serve', ...base, '--allow-live'])).toMatchObject({ allowLive: true });
    expect(parseRunnerArgs(['init', ...base, '--config', '/private/tmp/check/config.json'])).toMatchObject({ command: 'init', allowLive: false });
  });
  it.each([
    [], ['serve'], ['init', ...base], ['init', ...base, '--config', '/x', '--allow-live'],
    ['serve', ...base, '--config', '/x'], ['serve', ...base, '--allow-live', '--allow-live'],
    ['serve', ...base, '--port', '3'], ['serve', ...base, '--port', '65536'], ['serve', ...base, '--port', 'NaN'],
    ['serve', ...base, '--unknown'], ['serve', ...base, 'extra'],
    ['serve', '--state-dir', '/private/tmp/j', '--key-file', '/private/tmp/j/key'],
    ['init', ...base, '--config', '/private/tmp/check/journal/config.json'],
    ['init', ...base, '--config', '/private/tmp/check/master.key'],
  ].map((args) => [args]))('rejects ambiguous, unsafe or incomplete arguments: %j', (args) => { expect(() => parseRunnerArgs(args)).toThrow(); });
  it('creates a private independent master key once and reads it without replacement', async () => {
    const path = join(directory, 'master.key');
    const first = await loadRunnerKey(path, true);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadRunnerKey(path, false)).toBe(first);
    await expect(loadRunnerKey(path, true)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(first + '\n');
  });
  it('rejects missing, malformed, exposed and aliased master keys', async () => {
    const path = join(directory, 'master.key');
    await expect(loadRunnerKey(path, false)).rejects.toThrow();
    await writeFile(path, 'bad-key\n', { mode: 0o600 });
    await expect(loadRunnerKey(path, false)).rejects.toThrow('invalid_key_file');
    await writeFile(path, '71'.repeat(32) + '\n');
    await chmod(path, 0o640);
    await expect(loadRunnerKey(path, false)).rejects.toThrow('invalid_key_file');
    await chmod(path, 0o600);
    const alias = join(directory, 'alias');
    await symlink(path, alias);
    await expect(loadRunnerKey(alias, false)).rejects.toThrow();
    await link(path, join(directory, 'hardlink'));
    await expect(loadRunnerKey(path, false)).rejects.toThrow('invalid_key_file');
  });
  it('refuses nonprivate or symlinked parent directories', async () => {
    await chmod(directory, 0o750);
    await expect(loadRunnerKey(join(directory, 'master.key'), true)).rejects.toThrow('private_directory_required');
    await chmod(directory, 0o700);
    await symlink(directory, join(directory, 'alias'));
    await expect(loadRunnerKey(join(directory, 'alias', 'master.key'), true)).rejects.toThrow('private_directory_required');
  });
  it.each(['package-group', 'ready-SIGINT', 'ready-SIGTERM'] as const)('releases and reopens the journal after %s shutdown', async (mode) => {
    const config = join(directory, 'config.json'), stateDir = join(directory, 'journal'), keyFile = join(directory, 'master.key');
    await writeFile(config, JSON.stringify({ name: 'smoke-stop', sponsor: Keypair.generate().publicKey.toBase58(),
      user: Keypair.generate().publicKey.toBase58(), limits: { maxRegistrationPrice: '15000000000000', maxTransactionFee: '100000',
        recoveryAllowance: '100000', maxTotalSpend: '15001000000000' } }), { mode: 0o600 });
    const args = ['--state-dir', stateDir, '--key-file', keyFile];
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/phase0/registration-runner.ts', 'init', ...args, '--config', config]);
    const socket = createServer();
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const bound = socket.address();
    if (!bound || typeof bound === 'string') throw new Error('No test port');
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const serveArgs = ['serve', ...args, '--port', String(bound.port)];
    const child = mode === 'package-group'
      ? spawn('pnpm', ['phase0:registration', ...serveArgs], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['--import', './tests/helpers/interrupt-runner-on-ready.mjs', '--import', 'tsx',
        'scripts/phase0/registration-runner.ts', ...serveArgs], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FIRST_BITE_TEST_READY_SIGNAL: mode.slice('ready-'.length) } });
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        timer = setTimeout(() => reject(new Error('Runner startup timed out')), 8_000);
        child.once('error', reject);
        child.stdout.on('data', (value) => { output += value.toString(); if (output.includes('Live sending: disabled')) resolve(); });
        child.once('exit', () => reject(new Error('Runner exited before startup')));
      });
      clearTimeout(timer);
      if (mode === 'package-group') process.kill(-child.pid!, 'SIGINT');
      await exit;
      // The package manager may exit before the child's asynchronous cleanup finishes.
      for (let i = 0; i < 50; i++) {
        try { await stat(join(stateDir, '.lock')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const reopened = await openSmokeJournal<{ status: string }>(stateDir, await loadRunnerKey(keyFile, false));
          try { expect(await reopened.read()).toMatchObject({ status: 'initialized' }); }
          finally { await reopened.close(); }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Journal lock remained after clean shutdown');
    } finally {
      clearTimeout(timer);
      // The package manager can exit before a descendant. Clean up only this
      // test's detached group even when the group leader has already exited.
      try { process.kill(-child.pid!, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await exit;
    }
  }, 15_000);
});
