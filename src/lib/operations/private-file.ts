import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AccountingError } from './accounting';

/** Operator exports contain public chain identifiers but remain private by default. */
export async function writeAccountingExport(filename: string, data: unknown): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}\.json$/.test(filename)) throw new AccountingError('invalid_input');
  const base = resolve('artifacts/private');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (await realpath(base) !== base) throw new AccountingError('invalid_input');
  const path = resolve(base, filename);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } catch (error) { await unlink(path).catch(() => undefined); throw error; }
  finally { await handle.close(); }
  return path;
}
