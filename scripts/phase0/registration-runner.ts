import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { COOKIE_REGISTRY_POLICY } from '../../src/lib/chain/policy';
import { createRegistryClient } from '../../src/lib/chain/client';
import { createExecutionChain } from '../../src/lib/execution/chain';
import { createSponsorProbeSimulationConnection } from '../../src/lib/operations/sponsor-probe';
import { smokeWorksheetInputSchema } from '../../src/lib/operations/smoke-worksheet';
import { openSmokeJournal } from '../../src/lib/smoke/journal';
import { createSmokeRunner, SmokeRunnerError, type SmokeRunner, type SmokeRunnerState } from '../../src/lib/smoke/runner';

const RPC_URL = 'https://rpc.cookiescan.io';
const MAX_REQUEST_BYTES = 8192;
class HttpError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function exactFields(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new HttpError('invalid_input', 400);
}
async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type'] !== 'application/json') throw new HttpError('invalid_input', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError('invalid_input', 413);
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('invalid_input', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('invalid_input', 400);
  return value as Record<string, unknown>;
}

/** Second export boundary: never serialize the private runner snapshot. */
function publicState(state: Awaited<ReturnType<SmokeRunner['status']>>) {
  return {
    status: state.status, id: state.id,
    config: state.config ? { name: state.config.name, sponsor: state.config.sponsor, user: state.config.user,
      limits: select(state.config.limits, ['maxRegistrationPrice', 'maxTransactionFee', 'recoveryAllowance', 'maxTotalSpend']) } : null,
    attemptPayer: state.attemptPayer,
    quote: state.quote ? { ...select(state.quote, ['messageSha256', 'preparedAtMs', 'expiresAtMs', 'lastValidBlockHeight',
      'observedSlot', 'blockhashContextSlot', 'policyId', 'genesisHash', 'configSha256', 'programSha256']),
      cost: select(state.quote.cost, ['registrationPrice', 'domainRent', 'primaryRent', 'transactionFee', 'recoveryAllowance', 'maxSponsorDebit', 'maximumReservation']),
      expected: select(state.quote.expected, ['domain', 'owner', 'primary', 'primaryName']),
      simulation: select(state.quote.simulation, ['slot', 'unitsConsumed', 'blockHeight']) } : null,
    userSigned: state.userSigned, sponsorSigned: state.sponsorSigned,
    transactionSignature: state.transactionSignature,
    settlement: state.settlement ? select(state.settlement, ['success', 'fee', 'debit', 'residual', 'slot']) : null,
    observation: state.observation ? select(state.observation, ['status', 'finalizedBlockHeight', 'accountSlot']) : null,
    manualReason: state.manualReason,
    allowLive: state.allowLive, phase0GateComplete: false,
  };
}
function select(value: object, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, (value as Record<string, unknown>)[key]]));
}

/** Separate from /sponsor: the only send route requires both wallet signatures and an explicit acknowledgement. */
export async function startRegistrationServer(options: { runner: SmokeRunner; port?: number; allowLive: boolean }) {
  const token = randomBytes(32).toString('hex'); const tokenBytes = Buffer.from(token);
  const nonce = randomBytes(24).toString('base64');
  const bootstrap = JSON.stringify({ token, genesisHash: COOKIE_REGISTRY_POLICY.genesisHash, rpcUrl: RPC_URL, allowLive: options.allowLive }).replaceAll('<', '\\u003c');
  const template = await readFile(new URL('./registration-runner.html', import.meta.url), 'utf8');
  const page = template.replaceAll('__NONCE__', nonce).replace('__BOOTSTRAP__', bootstrap);
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    try {
      if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError('forbidden', 403);
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return;
      }
      if (!(request.method === 'GET' && request.url === '/state')
        && !(request.method === 'POST' && ['/prepare', '/wallet-request', '/signature', '/submit', '/reconcile'].includes(request.url ?? ''))) throw new HttpError('not_found', 404);
      const header = request.headers['x-smoke-token']; const provided = typeof header === 'string' ? Buffer.from(header) : Buffer.alloc(0);
      if (provided.length !== tokenBytes.length || !timingSafeEqual(provided, tokenBytes)
        || (request.method === 'POST' && request.headers.origin !== origin)
        || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HttpError('forbidden', 403);
      if (request.url === '/state') { json(response, 200, publicState(await options.runner.status())); return; }
      const body = await requestBody(request);
      switch (request.url) {
        case '/prepare': exactFields(body, []); json(response, 200, publicState(await options.runner.prepare())); return;
        case '/reconcile': exactFields(body, []); json(response, 200, publicState(await options.runner.reconcile())); return;
        case '/wallet-request': {
          exactFields(body, ['role']);
          if (body.role !== 'user' && body.role !== 'sponsor') throw new HttpError('invalid_input', 400);
          const candidate = await options.runner.walletRequest(body.role);
          json(response, 200, { role: candidate.role, address: candidate.address, transactionBase64: candidate.transactionBase64,
            id: candidate.id, messageSha256: candidate.messageSha256, expiresAtMs: candidate.expiresAtMs }); return;
        }
        case '/signature':
          exactFields(body, ['role', 'id', 'signedTransactionBase64']);
          if ((body.role !== 'user' && body.role !== 'sponsor') || typeof body.id !== 'string' || typeof body.signedTransactionBase64 !== 'string') throw new HttpError('invalid_input', 400);
          json(response, 200, publicState(await options.runner.acceptSignature(body.role, body.id, body.signedTransactionBase64))); return;
        case '/submit':
          exactFields(body, ['messageSha256', 'maxTotalSpend', 'confirmSpend']);
          if (!options.allowLive) throw new HttpError('live_disabled', 403);
          json(response, 200, publicState(await options.runner.submit(body))); return;
      }
    } catch (error) {
      // Never echo request bodies, raw RPC errors, key material or transaction bytes.
      if (!response.headersSent && !response.destroyed) json(response, error instanceof HttpError ? error.status : error instanceof SmokeRunnerError ? 409 : 500,
        { code: error instanceof HttpError || error instanceof SmokeRunnerError ? error.code : 'runner_unavailable' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 2000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 8788, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('runner_unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: () => new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); }) };
}

export function parseRunnerArgs(args: string[]) {
  const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
    config: { type: 'string' }, 'state-dir': { type: 'string' }, 'key-file': { type: 'string' },
    'allow-live': { type: 'boolean' }, port: { type: 'string' },
  } });
  if (parsed.positionals.length !== 1 || !['init', 'serve'].includes(parsed.positionals[0]!)) throw new Error('invalid_arguments');
  const command = parsed.positionals[0] as 'init' | 'serve';
  const names = parsed.tokens.filter((entry) => entry.kind === 'option').map((entry) => entry.name);
  if (new Set(names).size !== names.length || !parsed.values['state-dir'] || !parsed.values['key-file']) throw new Error('invalid_arguments');
  if ((command === 'init' && (!parsed.values.config || parsed.values['allow-live'] || parsed.values.port))
    || (command === 'serve' && parsed.values.config)) throw new Error('invalid_arguments');
  const portText = parsed.values.port ?? '8788';
  const port = Number(portText);
  if (!/^[0-9]{1,5}$/.test(portText) || port < 1024 || port > 65535) throw new Error('invalid_arguments');
  const stateDir = resolve(parsed.values['state-dir']), keyFile = resolve(parsed.values['key-file']);
  const configFile = parsed.values.config ? resolve(parsed.values.config) : null;
  const inside = (path: string) => { const child = relative(stateDir, path); return child === '' || (!child.startsWith(`..${sep}`) && child !== '..'); };
  if (inside(keyFile) || (configFile && (inside(configFile) || configFile === keyFile))) throw new Error('invalid_arguments');
  return { command, stateDir, keyFile, configFile, allowLive: parsed.values['allow-live'] === true, port };
}

/** Master key for this local runner only, not a wallet private key. Never print it. */
export async function loadRunnerKey(filename: string, initialize: boolean): Promise<string> {
  const full = resolve(filename), parent = dirname(full);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0
    || await realpath(parent) !== parent) throw new Error('private_directory_required');
  let handle;
  if (initialize) {
    handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(randomBytes(32).toString('hex') + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size !== 65) throw new Error('invalid_key_file');
    const buffer = Buffer.alloc(66);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat(), parentAfter = await lstat(parent), fileAfter = await lstat(full);
    if (length !== 65 || after.size !== 65 || fileAfter.isSymbolicLink()
      || fileAfter.ino !== info.ino || fileAfter.dev !== info.dev
      || parentAfter.ino !== parentStat.ino || parentAfter.dev !== parentStat.dev
      || (parentAfter.mode & 0o077) !== 0 || await realpath(parent) !== parent) throw new Error('invalid_key_file');
    const value = buffer.subarray(0, length).toString('utf8');
    buffer.fill(0);
    if (!/^[a-f0-9]{64}\n$/.test(value)) throw new Error('invalid_key_file');
    return value.trim();
  } finally { await handle.close(); }
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));
  let config: unknown;
  if (args.command === 'init') {
    const file = await open(args.configFile!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8192) throw new Error('invalid_config');
      config = smokeWorksheetInputSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
    // The state/key parent is created once with private permissions; an existing
    // public or symlinked parent is rejected rather than modified silently.
    await mkdir(dirname(args.stateDir), { recursive: true, mode: 0o700 });
    await mkdir(dirname(args.keyFile), { recursive: true, mode: 0o700 });
  }
  const key = await loadRunnerKey(args.keyFile, args.command === 'init');
  const journal = await openSmokeJournal<SmokeRunnerState>(args.stateDir, key);
  let server: Awaited<ReturnType<typeof startRegistrationServer>> | undefined;
  try {
    const runner = await createSmokeRunner({ journal, registry: createRegistryClient(RPC_URL),
      chain: createExecutionChain(RPC_URL, { allowBroadcast: args.allowLive, registryObservationTimeoutMs: 15_000 }),
      simulation: createSponsorProbeSimulationConnection(RPC_URL), allowLive: args.allowLive });
    if (args.command === 'init') {
      await runner.initialize(config);
      console.log('Private registration state initialized. No wallet request or transaction was sent.');
      await journal.close(); return;
    }
    if ((await runner.status()).status === 'uninitialized') throw new Error('initialize_first');
    server = await startRegistrationServer({ runner, port: args.port, allowLive: args.allowLive });
    let closing = false;
    const close = () => {
      if (closing) return; closing = true;
      void server!.close().then(() => journal.close()).catch(() => { console.error('runner_shutdown_failed'); process.exitCode = 1; });
    };
    // Terminal and package-manager forwarding can deliver the same signal twice.
    // Keep handlers installed until asynchronous journal shutdown has finished.
    process.on('SIGINT', close); process.on('SIGTERM', close);
    // Readiness can trigger an immediate signal from a terminal or supervisor.
    // Publish it only after shutdown can release the journal safely.
    console.log(`One-registration runner: ${server.url}\nLive sending: ${args.allowLive ? 'enabled; explicit final review required' : 'disabled'}\nKeep this process open. Ctrl+C closes the journal cleanly.`);
  } catch (error) { await server?.close(); await journal.close(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Registration runner could not start. Check arguments and private state/key files. Do not delete existing state or locks to retry.'); process.exitCode = 1; });
}
