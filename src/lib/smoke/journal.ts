import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MAX_PLAINTEXT_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 192 * 1024;
const MAX_RECORDS = 10_000;
const ROOT_HASH = '0'.repeat(64);
const LOCK_NAME = '.lock';
const RECORD_NAME = /^snapshot-(\d{12})\.json$/;

export type SmokeJournalCode = 'invalid_key' | 'invalid_value' | 'unsafe_path' | 'locked'
  | 'corrupt_journal' | 'storage_failed' | 'journal_uncertain' | 'closed';

/** Codes are safe to expose. Underlying errors may contain paths or payloads. */
export class SmokeJournalError extends Error {
  constructor(readonly code: SmokeJournalCode) { super('Private smoke journal failed'); }
}

export interface SmokeJournal<T> {
  read(): Promise<T | null>;
  write(value: T): Promise<void>;
  close(): Promise<void>;
}

function fail(code: SmokeJournalCode): never { throw new SmokeJournalError(code); }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function privateStat(stat: Stats, directory: boolean, parent = false): void {
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()
    || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & (parent ? 0o022 : 0o077)) !== 0
    || (!directory && stat.nlink !== 1)) fail('unsafe_path');
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function context(directory: string, sequence: number, previous: string): Buffer {
  return Buffer.from(JSON.stringify(['first-bite', 'smoke-journal', 1, directory, sequence, previous]));
}
function decode(value: unknown, minimum: number, maximum: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('corrupt_journal');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64url') !== value) fail('corrupt_journal');
  return bytes;
}

function encrypt(value: Buffer, key: Buffer, directory: string, sequence: number, previous: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(context(directory, sequence, previous));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.from(JSON.stringify({ version: 1, sequence, previous, nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }) + '\n');
}

function decrypt(bytes: Buffer, key: Buffer, directory: string, sequence: number, previous: string): string {
  let provisional: Buffer | undefined, final: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'ciphertext,nonce,previous,sequence,tag,version'
      || value.version !== 1 || value.sequence !== sequence || value.previous !== previous) fail('corrupt_journal');
    const decipher = createDecipheriv('aes-256-gcm', key, decode(value.nonce, 12, 12), { authTagLength: 16 });
    decipher.setAAD(context(directory, sequence, previous));
    decipher.setAuthTag(decode(value.tag, 16, 16));
    provisional = decipher.update(decode(value.ciphertext, 1, MAX_PLAINTEXT_BYTES));
    final = decipher.final();
    plaintext = Buffer.concat([provisional, final]);
    const text = plaintext.toString('utf8');
    JSON.parse(text);
    return text;
  } catch { return fail('corrupt_journal'); }
  finally { provisional?.fill(0); final?.fill(0); plaintext?.fill(0); }
}

/**
 * One private directory represents one registration session. It must have an
 * existing, owned, non-writable-by-others parent and cannot be moved: the absolute
 * directory is authenticated with every record. Crashed/uncertain writers leave
 * .lock for operator recovery; this module never guesses whether a lock is stale.
 * A hash chain detects gaps and altered records, but cannot detect restoring an
 * entire older directory backup (or deleting its tail) without an external anchor.
 */
export async function openSmokeJournal<T>(directory: string, wrappingKeyHex: string): Promise<SmokeJournal<T>> {
  if (typeof wrappingKeyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(wrappingKeyHex)) fail('invalid_key');
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) fail('unsafe_path');
  const key = Buffer.from(wrappingKeyHex, 'hex');
  const path = resolve(directory), parent = dirname(path), lockPath = join(path, LOCK_NAME);
  let directoryHandle: FileHandle | undefined, lockHandle: FileHandle | undefined;
  let parentIdentity: Stats, directoryIdentity: Stats, lockIdentity: Stats | undefined;
  let sequence = 0, previous = ROOT_HASH, latest: string | null = null;
  let closed = false, uncertain = false;
  let queue: Promise<void> = Promise.resolve();

  const assertDirectory = async () => {
    const parentNow = await lstat(parent), directoryNow = await lstat(path);
    privateStat(parentNow, true, true); privateStat(directoryNow, true);
    if (!sameFile(parentNow, parentIdentity) || !sameFile(directoryNow, directoryIdentity)
      || await realpath(path) !== path) fail('unsafe_path');
  };
  const assertLock = async () => {
    const current = await lstat(lockPath);
    privateStat(current, false);
    if (!lockIdentity || !sameFile(current, lockIdentity)) fail('locked');
  };
  const removeOwnLock = async () => {
    await assertDirectory(); await assertLock();
    await unlink(lockPath);
    await directoryHandle!.sync();
  };
  const serial = <R>(work: () => Promise<R>): Promise<R> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const assertOpen = () => { if (closed) fail('closed'); if (uncertain) fail('journal_uncertain'); };

  try {
    parentIdentity = await lstat(parent);
    privateStat(parentIdentity, true, true);
    if (await realpath(parent) !== parent || path === parent) fail('unsafe_path');
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    if (created) {
      const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameFile(await parentHandle.stat(), parentIdentity)) fail('unsafe_path');
        await parentHandle.sync();
      } finally { await parentHandle.close(); }
    }
    directoryIdentity = await lstat(path); privateStat(directoryIdentity, true);
    directoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameFile(await directoryHandle.stat(), directoryIdentity)) fail('unsafe_path');
    await assertDirectory();
    try { lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (hasCode(error, 'EEXIST') || hasCode(error, 'ELOOP')) fail('locked'); throw error; }
    lockIdentity = await lockHandle.stat(); privateStat(lockIdentity, false);
    await lockHandle.writeFile(JSON.stringify({ version: 1, pid: process.pid, id: randomBytes(16).toString('hex') }) + '\n');
    await lockHandle.sync(); await directoryHandle.sync();
    const names = (await readdir(path)).filter((name) => name !== LOCK_NAME).sort();
    if (names.length > MAX_RECORDS) fail('corrupt_journal');
    for (const name of names) {
      const next = sequence + 1;
      if (!RECORD_NAME.test(name) || name !== `snapshot-${String(next).padStart(12, '0')}.json`) fail('corrupt_journal');
      const filename = join(path, name), identity = await lstat(filename);
      privateStat(identity, false);
      if (identity.size < 1 || identity.size > MAX_RECORD_BYTES) fail('corrupt_journal');
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameFile(await handle.stat(), identity)) fail('unsafe_path');
        // A concurrent size change must not turn a private record into an
        // unbounded read, even if the replacing process has this user's access.
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length !== identity.size || length > MAX_RECORD_BYTES) fail('corrupt_journal');
        const bytes = buffer.subarray(0, length);
        latest = decrypt(bytes, key, path, next, previous);
        previous = digest(bytes); sequence = next;
      } finally { await handle.close(); }
    }
    await assertDirectory(); await assertLock();
  } catch (error) {
    if (lockIdentity) await removeOwnLock().catch(() => undefined);
    await lockHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    key.fill(0);
    if (error instanceof SmokeJournalError) throw error;
    return fail('storage_failed');
  }

  return {
    read: () => serial(async () => {
      assertOpen();
      try { await assertDirectory(); await assertLock(); }
      catch { uncertain = true; return fail('journal_uncertain'); }
      return latest === null ? null : JSON.parse(latest) as T;
    }),
    write: (value) => serial(async () => {
      assertOpen();
      let text: string, plaintext: Buffer;
      try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_PLAINTEXT_BYTES) fail('invalid_value');
        text = encoded; plaintext = Buffer.from(encoded);
      } catch { return fail('invalid_value'); }
      const next = sequence + 1;
      if (next > MAX_RECORDS) { plaintext.fill(0); return fail('invalid_value'); }
      let handle: FileHandle | undefined;
      try {
        await assertDirectory(); await assertLock();
        const bytes = encrypt(plaintext, key, path, next, previous);
        const temporary = join(path, `.pending-${next}-${randomBytes(16).toString('hex')}`);
        const filename = join(path, `snapshot-${String(next).padStart(12, '0')}.json`);
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        privateStat(await handle.stat(), false);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
        await assertDirectory(); await assertLock();
        // link is exclusive, unlike rename, and cannot overwrite a committed record.
        await link(temporary, filename);
        await unlink(temporary);
        await directoryHandle!.sync();
        sequence = next; previous = digest(bytes); latest = text;
      } catch {
        // Do not acknowledge or continue after possibly committing bytes. Preserve
        // the lock and any pending file so restart requires deliberate inspection.
        uncertain = true; return fail('storage_failed');
      } finally { plaintext.fill(0); await handle?.close().catch(() => undefined); }
    }),
    close: () => serial(async () => {
      if (closed) return;
      closed = true; latest = null; key.fill(0);
      let failed = false;
      try { if (!uncertain) await removeOwnLock(); }
      catch { uncertain = true; failed = true; }
      await lockHandle!.close().catch(() => { failed = true; });
      await directoryHandle!.close().catch(() => { failed = true; });
      if (failed) fail('storage_failed');
    }),
  };
}
