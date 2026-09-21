import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSmokeJournal, SmokeJournalError, type SmokeJournal } from '../src/lib/smoke/journal';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink), open: vi.fn(actual.open) };
});

const KEY = '71'.repeat(32);
const OTHER_KEY = 'a3'.repeat(32);
const first = 'snapshot-000000000001.json';
const second = 'snapshot-000000000002.json';
type Snapshot = { status: string; secret?: string; bytes?: string; nested?: { revision: number } };
let parent: string;
let directory: string;
let journals: SmokeJournal<Snapshot>[];

async function open(key = KEY, path = directory): Promise<SmokeJournal<Snapshot>> {
  const journal = await openSmokeJournal<Snapshot>(path, key);
  journals.push(journal);
  return journal;
}
async function seed(): Promise<void> {
  const journal = await open();
  await journal.write({ status: 'prepared', secret: 'synthetic-attempt-key', bytes: 'synthetic-unsigned-payload' });
  await journal.write({ status: 'signed', bytes: 'synthetic-signed-payload' });
  await journal.close();
}
async function errorCode(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ code, message: 'Private smoke journal failed' });
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'first-bite-smoke-journal-'));
  await fs.chmod(parent, 0o700);
  directory = join(parent, 'session');
  journals = [];
});

afterEach(async () => {
  for (const journal of journals) await journal.close().catch(() => undefined);
  await fs.chmod(parent, 0o700);
  await fs.rm(parent, { recursive: true, force: true });
});

describe('private one-registration journal', () => {
  it('creates a private empty journal, durably appends snapshots, and reopens the latest state', async () => {
    const journal = await open();
    expect(await journal.read()).toBeNull();
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, '.lock'))).mode & 0o777).toBe(0o600);
    await journal.write({ status: 'prepared', nested: { revision: 1 } });
    await journal.write({ status: 'signed', nested: { revision: 2 } });
    const snapshots = (await fs.readdir(directory)).filter((name) => name !== '.lock').sort();
    expect(snapshots).toEqual([first, second]);
    for (const name of snapshots) expect((await fs.stat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(join(directory, second), 'utf8')).previous)
      .toBe(createHash('sha256').update(await fs.readFile(join(directory, first))).digest('hex'));
    await journal.close();
    expect(await fs.readdir(directory)).not.toContain('.lock');
    expect(await (await open()).read()).toEqual({ status: 'signed', nested: { revision: 2 } });
  });

  it('isolates returned and provided objects from its committed snapshot', async () => {
    const journal = await open();
    const input = { status: 'prepared', nested: { revision: 1 } };
    await journal.write(input);
    input.nested.revision = 10;
    const output = (await journal.read())!;
    output.nested!.revision = 20;
    expect(await journal.read()).toEqual({ status: 'prepared', nested: { revision: 1 } });
  });

  it('encrypts all snapshot content and never stores its wrapping key', async () => {
    await seed();
    const all = (await Promise.all((await fs.readdir(directory)).map((name) => fs.readFile(join(directory, name), 'utf8')))).join('');
    for (const text of [KEY, 'synthetic-attempt-key', 'synthetic-unsigned-payload', 'synthetic-signed-payload', 'prepared', 'signed']) {
      expect(all).not.toContain(text);
    }
  });

  it('serializes simultaneous writes in caller order', async () => {
    const journal = await open();
    await Promise.all(Array.from({ length: 10 }, (_, n) => journal.write({ status: String(n) })));
    expect(await journal.read()).toEqual({ status: '9' });
    expect((await fs.readdir(directory)).filter((name) => name.startsWith('snapshot-'))).toHaveLength(10);
    await journal.close();
    expect(await (await open()).read()).toEqual({ status: '9' });
  });

  it('retains the exclusive lock until close and never treats an existing lock as stale', async () => {
    const journal = await open();
    await errorCode(open(), 'locked');
    await journal.close();
    await fs.writeFile(join(directory, '.lock'), '{"pid":999999999,"id":"dead-process"}\n', { mode: 0o600 });
    await errorCode(open(), 'locked');
    expect(await fs.readFile(join(directory, '.lock'), 'utf8')).toContain('dead-process');
  });

  it('has exactly one winner when two open calls race', async () => {
    const results = await Promise.allSettled([open(), open()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'locked' });
  });

  it('rejects a wrong wrapping key without exposing ciphertext or plaintext in errors', async () => {
    await seed();
    await errorCode(open(OTHER_KEY), 'corrupt_journal');
    expect(await (await open()).read()).toEqual({ status: 'signed', bytes: 'synthetic-signed-payload' });
  });

  it.each(['', 'secret', 'a'.repeat(63), 'g'.repeat(64), 'ab'.repeat(33)])('rejects an invalid key before creating files', async (key) => {
    await errorCode(open(key), 'invalid_key');
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it.each(['ciphertext', 'nonce', 'tag', 'sequence', 'previous', 'version', 'extra'])('authenticates record %s', async (field) => {
    await seed();
    const filename = join(directory, second);
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (field === 'ciphertext' || field === 'nonce' || field === 'tag') value[field] = (value[field][0] === 'A' ? 'B' : 'A') + value[field].slice(1);
    else value[field] = 'tampered';
    await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    await errorCode(open(), 'corrupt_journal');
  });

  it('rejects an interrupted temporary file instead of guessing whether a write committed', async () => {
    await seed();
    await fs.writeFile(join(directory, '.pending-3-interrupted'), 'encrypted-or-partial', { mode: 0o600 });
    await errorCode(open(), 'corrupt_journal');
  });

  it('rejects gaps, reordered snapshots, malformed JSON, and oversized records', async () => {
    await seed();
    const original = await fs.readFile(join(directory, first));
    await fs.unlink(join(directory, first));
    await errorCode(open(), 'corrupt_journal');
    await fs.writeFile(join(directory, first), original, { mode: 0o600 });
    const last = await fs.readFile(join(directory, second));
    await fs.writeFile(join(directory, first), last);
    await fs.writeFile(join(directory, second), original);
    await errorCode(open(), 'corrupt_journal');
    await fs.writeFile(join(directory, first), 'broken');
    await errorCode(open(), 'corrupt_journal');
    await fs.writeFile(join(directory, first), Buffer.alloc(193 * 1024));
    await errorCode(open(), 'corrupt_journal');
  });

  it('binds encrypted records to this directory', async () => {
    await seed();
    const other = join(parent, 'other-session');
    await fs.mkdir(other, { mode: 0o700 });
    for (const name of await fs.readdir(directory)) {
      await fs.copyFile(join(directory, name), join(other, name));
      await fs.chmod(join(other, name), 0o600);
    }
    await errorCode(open(KEY, other), 'corrupt_journal');
  });

  it('rejects symlink parents, directories, records, and locks', async () => {
    const parentAlias = join(parent, 'parent-alias');
    await fs.symlink(parent, parentAlias);
    await errorCode(open(KEY, join(parentAlias, 'child')), 'unsafe_path');
    const target = join(parent, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, directory);
    await errorCode(open(), 'unsafe_path');
    await fs.unlink(directory);
    await seed();
    const saved = join(parent, 'saved-record');
    await fs.rename(join(directory, first), saved);
    await fs.symlink(saved, join(directory, first));
    await errorCode(open(), 'unsafe_path');
    await fs.unlink(join(directory, first));
    await fs.rename(saved, join(directory, first));
    await fs.symlink(saved, join(directory, '.lock'));
    await errorCode(open(), 'locked');
  });

  it('rejects group/world writable parents and accessible journal directories or records', async () => {
    await fs.chmod(parent, 0o770);
    await errorCode(open(), 'unsafe_path');
    await fs.chmod(parent, 0o700);
    await seed();
    await fs.chmod(directory, 0o750);
    await errorCode(open(), 'unsafe_path');
    await fs.chmod(directory, 0o700);
    await fs.chmod(join(directory, first), 0o640);
    await errorCode(open(), 'unsafe_path');
  });

  it('rejects hardlinked records', async () => {
    await seed();
    await fs.link(join(directory, first), join(parent, 'record-alias'));
    await errorCode(open(), 'unsafe_path');
  });

  it('does not remove a lock replaced by another actor', async () => {
    const journal = await open();
    await fs.rename(join(directory, '.lock'), join(parent, 'original-lock'));
    await fs.writeFile(join(directory, '.lock'), 'replacement', { mode: 0o600 });
    await errorCode(journal.read(), 'journal_uncertain');
    await journal.close();
    expect(await fs.readFile(join(directory, '.lock'), 'utf8')).toBe('replacement');
  });

  it('allows retry after invalid values without advancing the snapshot sequence', async () => {
    const journal = await open();
    await journal.write({ status: 'prepared' });
    await errorCode(journal.write({ status: 'x'.repeat(128 * 1024) }), 'invalid_value');
    await errorCode(journal.write({ status: 'bad', secret: 1n } as unknown as Snapshot), 'invalid_value');
    expect(await journal.read()).toEqual({ status: 'prepared' });
    await journal.write({ status: 'signed' });
    expect((await fs.readdir(directory)).filter((name) => name.startsWith('snapshot-')).sort()).toEqual([first, second]);
  });

  it('fails closed after a failed commit without overwriting the last snapshot', async () => {
    const journal = await open();
    await journal.write({ status: 'prepared' });
    const old = await fs.readFile(join(directory, first));
    vi.mocked(fs.link).mockRejectedValueOnce(new Error('synthetic-secret filesystem detail'));
    await errorCode(journal.write({ status: 'signed' }), 'storage_failed');
    expect(await fs.readFile(join(directory, first))).toEqual(old);
    await expect(fs.stat(join(directory, second))).rejects.toMatchObject({ code: 'ENOENT' });
    await errorCode(journal.read(), 'journal_uncertain');
    await errorCode(journal.write({ status: 'sent' }), 'journal_uncertain');
    await journal.close();
    await errorCode(open(), 'locked');
    expect((await fs.readdir(directory)).some((name) => name.startsWith('.pending-2-'))).toBe(true);
  });

  it('never overwrites an existing snapshot during a write', async () => {
    const journal = await open();
    await fs.writeFile(join(directory, first), 'unexpected-existing-record', { mode: 0o600 });
    await errorCode(journal.write({ status: 'prepared' }), 'storage_failed');
    expect(await fs.readFile(join(directory, first), 'utf8')).toBe('unexpected-existing-record');
    await journal.close();
    await errorCode(open(), 'locked');
  });

  it('retains the lock and both links if pending-file cleanup fails after publishing a snapshot', async () => {
    const journal = await open();
    await journal.write({ status: 'prepared' });
    const old = await fs.readFile(join(directory, first));
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('synthetic-secret unlink detail'));
    await errorCode(journal.write({ status: 'signed' }), 'storage_failed');
    expect(await fs.readFile(join(directory, first))).toEqual(old);
    expect((await fs.stat(join(directory, second))).nlink).toBe(2);
    expect((await fs.readdir(directory)).some((name) => name.startsWith('.pending-2-'))).toBe(true);
    await errorCode(journal.read(), 'journal_uncertain');
    await journal.close();
    await errorCode(open(), 'locked');
  });

  it('does not acknowledge a published snapshot when its directory sync fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let directoryHandle: fs.FileHandle | undefined;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (path === directory) directoryHandle = handle;
      return handle;
    });
    const journal = await open();
    await journal.write({ status: 'prepared' });
    const old = await fs.readFile(join(directory, first));
    vi.spyOn(directoryHandle!, 'sync').mockRejectedValueOnce(new Error('synthetic-secret sync detail'));
    await errorCode(journal.write({ status: 'signed' }), 'storage_failed');
    expect(await fs.readFile(join(directory, first))).toEqual(old);
    expect((await fs.stat(join(directory, second))).nlink).toBe(1);
    expect((await fs.readdir(directory)).some((name) => name.startsWith('.pending-'))).toBe(false);
    await errorCode(journal.write({ status: 'sent' }), 'journal_uncertain');
    await journal.close();
    await errorCode(open(), 'locked');
  });

  it('never writes into or removes a lock from a replacement directory', async () => {
    const journal = await open();
    await journal.write({ status: 'prepared' });
    const original = join(parent, 'moved-session');
    await fs.rename(directory, original);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(join(directory, '.lock'), 'replacement-lock', { mode: 0o600 });
    await errorCode(journal.write({ status: 'signed' }), 'storage_failed');
    await journal.close();
    expect(await fs.readdir(directory)).toEqual(['.lock']);
    expect(await fs.readFile(join(directory, '.lock'), 'utf8')).toBe('replacement-lock');
    expect((await fs.readdir(original)).sort()).toEqual(['.lock', first]);
  });

  it('makes close idempotent and rejects operations after closing', async () => {
    const journal = await open();
    await journal.close(); await journal.close();
    await errorCode(journal.read(), 'closed');
    await errorCode(journal.write({ status: 'prepared' }), 'closed');
    expect(new SmokeJournalError('closed').message).not.toContain(directory);
  });
});
