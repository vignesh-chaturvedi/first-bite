import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAccountingExport } from '../../src/lib/operations/private-file';
import { PilotReportError, summarizePilot } from '../../src/lib/pilot/report';

export const MAX_PILOT_INPUT_BYTES = 256 * 1024;
export async function readPilotInput(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PILOT_INPUT_BYTES) throw new PilotReportError('invalid_file');
    const bytes = Buffer.alloc(MAX_PILOT_INPUT_BYTES + 1);
    try {
      // Read through EOF, handling short reads and growth without an unbounded allocation.
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_PILOT_INPUT_BYTES) throw new PilotReportError('invalid_file');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))); }
      catch { throw new PilotReportError('invalid_file'); }
    } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof PilotReportError) throw error;
    throw new PilotReportError('file_unavailable');
  } finally { await handle?.close(); }
}
export async function runPilotReport(args: string[]) {
  let values: { input: string; out: string };
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: { input: { type: 'string' }, out: { type: 'string' } } });
    if (!parsed.values.input || !parsed.values.out || parsed.tokens.length !== 2) throw new Error();
    values = { input: parsed.values.input, out: parsed.values.out };
  } catch { throw new PilotReportError('invalid_input'); }
  const report = summarizePilot(await readPilotInput(values.input));
  const outputFile = await writeAccountingExport(values.out, report);
  return { outputFile, recordChecklistSatisfied: report.recordChecklistSatisfied,
    liveParticipants: report.observations.liveParticipants, missingEvidenceCount: report.missingEvidence.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runPilotReport(process.argv.slice(2));
    console.log(JSON.stringify({ ok: true, ...result }));
    if (!result.recordChecklistSatisfied) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof PilotReportError ? error.code : 'pilot_report_failed' }));
    process.exitCode = 1;
  }
}
