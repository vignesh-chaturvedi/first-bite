import { Keypair } from '@solana/web3.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseConfig } from '../../src/config/schema';
import { createRegistryClient, type RegistryClient } from '../../src/lib/chain/client';
import { writeAccountingExport } from '../../src/lib/operations/private-file';
import { prepareSmokeWorksheet, SmokeWorksheetError } from '../../src/lib/operations/smoke-worksheet';

export async function runSmokeWorksheet(args: string[], injectedClient?: RegistryClient) {
  let values;
  try {
    const options = { name: { type: 'string' }, sponsor: { type: 'string' }, user: { type: 'string' },
      'max-price': { type: 'string' }, 'max-fee': { type: 'string' }, recovery: { type: 'string' },
      'max-total': { type: 'string' }, out: { type: 'string' } } as const;
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: false, tokens: true });
    if (parsed.tokens.length !== 8 || Object.keys(options).some((key) => !parsed.values[key as keyof typeof options])
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}\.json$/.test(parsed.values.out!)) throw new Error();
    values = parsed.values;
  } catch { throw new SmokeWorksheetError('invalid_input'); }
  let client: RegistryClient;
  try {
    // Read only the RPC setting; no .env loading, database connection or signer configuration.
    client = injectedClient ?? createRegistryClient(parseConfig({ COOKIE_RPC_URL: process.env.COOKIE_RPC_URL }).cookieRpcUrl);
  } catch { throw new SmokeWorksheetError('chain_unavailable'); }
  const report = await prepareSmokeWorksheet({ name: values.name, sponsor: values.sponsor, user: values.user,
    limits: { maxRegistrationPrice: values['max-price'], maxTransactionFee: values['max-fee'],
      recoveryAllowance: values.recovery, maxTotalSpend: values['max-total'] } }, client, Keypair.generate().publicKey);
  let outputFile: string;
  try { outputFile = await writeAccountingExport(values.out!, report); }
  catch { throw new SmokeWorksheetError('output_failed'); }
  return { outputFile, planningChecksSatisfied: report.planningChecksSatisfied, blockerCount: report.blockers.length,
    spendAuthorized: false, broadcastEnabled: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runSmokeWorksheet(process.argv.slice(2));
    console.log(JSON.stringify({ ok: true, ...result }));
    if (!result.planningChecksSatisfied) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof SmokeWorksheetError ? error.code : 'worksheet_failed' }));
    process.exitCode = 1;
  }
}
