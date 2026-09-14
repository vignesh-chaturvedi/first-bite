import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAccountingExport } from '../src/lib/operations/private-file';

describe('private operator accounting export', () => {
  let directory: string;
  const report = { schemaVersion: 1, consistent: true, ledger: { spentNative: '90071992547409930' } };

  beforeEach(async () => {
    // Canonicalize macOS /var and /tmp aliases because the implementation rejects
    // symlinked parents. Mock cwd only in this test worker; never chdir globally.
    directory = await realpath(await mkdtemp(join(tmpdir(), 'first-bite-export-')));
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('creates an exclusive 0600 JSON file under a private directory and preserves exact amounts', async () => {
    const output = await writeAccountingExport('campaign-2026_09.json', report);
    expect(output).toBe(join(directory, 'artifacts/private/campaign-2026_09.json'));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'artifacts/private'))).mode & 0o777).toBe(0o700);
    const text = await readFile(output, 'utf8');
    expect(JSON.parse(text)).toEqual(report);
    expect(text).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(await readdir(join(directory, 'artifacts/private'))).toEqual(['campaign-2026_09.json']);
  });

  it.each(['a.json', `${'x'.repeat(61)}.json`])('accepts a bounded plain filename: %s', async (filename) => {
    expect(await writeAccountingExport(filename, report)).toBe(join(directory, 'artifacts/private', filename));
  });

  it.each([
    '', '../outside.json', '/tmp/outside.json', 'nested/report.json', '.hidden.json',
    'report.JSON', 'report.txt', 'report.json.bak', 'a b.json', 'a\\b.json',
    'a\n.json', 'a\0.json', `${'x'.repeat(62)}.json`, 'é.json',
  ])('rejects traversal or invalid filenames before creating output: %j', async (filename) => {
    await expect(writeAccountingExport(filename, report)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('never overwrites a previous report on a name collision', async () => {
    const output = await writeAccountingExport('same.json', report);
    const original = await readFile(output, 'utf8');
    await expect(writeAccountingExport('same.json', { overwritten: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe(original);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlink at the output filename without changing its target', async () => {
    const privateDirectory = join(directory, 'artifacts/private');
    await mkdir(privateDirectory, { recursive: true });
    const target = join(directory, 'original.json');
    await writeFile(target, 'original');
    await symlink(target, join(privateDirectory, 'linked.json'));
    await expect(writeAccountingExport('linked.json', report)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await realpath(join(privateDirectory, 'linked.json'))).toBe(target);
  });

  it('rejects a symlinked private directory without writing in the target', async () => {
    await mkdir(join(directory, 'artifacts'));
    const target = join(directory, 'outside');
    await mkdir(target);
    await symlink(target, join(directory, 'artifacts/private'));
    await expect(writeAccountingExport('report.json', report)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects a symlinked artifacts ancestor without writing a report', async () => {
    const target = join(directory, 'outside');
    await mkdir(join(target, 'private'), { recursive: true });
    await symlink(target, join(directory, 'artifacts'));
    await expect(writeAccountingExport('report.json', report)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(join(target, 'private'))).toEqual([]);
  });

  it('removes a failed serialization artifact and releases its filename for a valid retry', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writeAccountingExport('retry.json', circular)).rejects.toThrow();
    expect(await readdir(join(directory, 'artifacts/private'))).toEqual([]);
    const output = await writeAccountingExport('retry.json', report);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report);
  });

  it('returns only the private output path and does not log report contents', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const output = await writeAccountingExport('quiet.json', { ...report, marker: 'private-report-marker' });
    expect(output).toBe(join(directory, 'artifacts/private/quiet.json'));
    expect(output).not.toContain('private-report-marker');
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
