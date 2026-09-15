import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { buildSponsoredTransaction, MAX_TRANSACTION_BYTES, unsignedBytes, validateUserSignature } from '../../src/lib/cookie/transaction.js';
import { createRegistryClient, type RegistryClient } from '../../src/lib/chain/client.js';
import { SmokeWorksheetError } from '../../src/lib/operations/smoke-worksheet.js';
import { createSponsorProbeSimulationConnection, prepareSponsorProbe, type SponsorProbeCandidate, type SponsorProbeSimulationConnection } from '../../src/lib/operations/sponsor-probe.js';
import type { ChainSnapshot } from './inspect-chain.js';

type ProbeMode = 'user-first' | 'preserve-attempt-signature';
type ReadOnlyRpc = Pick<Connection, 'getGenesisHash' | 'getLatestBlockhash'>;
interface PreparedProbe {
  transaction: Transaction;
  wallet: PublicKey;
  sponsor: PublicKey;
  attemptPayer: PublicKey;
  mode: ProbeMode;
  createdAt: number;
  lastValidBlockHeight: number;
  label: string;
}
type RequestErrorCode = 'blockhash_expired' | 'chain_changed';
class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: RequestErrorCode) { super(message); }
}
const MAX_BODY_BYTES = 8_192;
const PROBE_TTL_MS = 5 * 60_000;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type'] !== 'application/json') throw new RequestError(415, 'Use application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestError(400, 'Expected a JSON object.');
  return parsed as Record<string, unknown>;
}
function onlyFields(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).length !== keys.length || keys.some((key) => !(key in input))) throw new RequestError(400, 'Unexpected request fields.');
}
function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}
function publicEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The snapshot must identify a public HTTPS RPC without credentials or query parameters.');
  return url.toString();
}

/** Local signing diagnostic only. The RPC dependency deliberately exposes no send method. */
export async function startWalletProbe(options: {
  snapshot: ChainSnapshot;
  port?: number;
  rpc?: ReadOnlyRpc;
  /** Trusted local test injection; never supplied by browser requests. */
  sponsorDependencies?: { client: RegistryClient; simulation: SponsorProbeSimulationConnection };
}): Promise<{ url: string; close: () => Promise<void> }> {
  const { snapshot } = options;
  const rpcUrl = publicEndpoint(snapshot.endpoint);
  new PublicKey(snapshot.genesisHash);
  const feeReceiver = new PublicKey(snapshot.feeReceiver.address);
  for (const amount of [snapshot.quote.price, snapshot.quote.domainRent, snapshot.quote.primaryRent]) {
    if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error('Invalid exact amount in chain snapshot.');
  }
  const rpc = options.rpc ?? new Connection(process.env.COOKIE_RPC_URL ?? rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true });
  const sponsorDependencies = options.sponsorDependencies ?? {
    client: createRegistryClient(process.env.COOKIE_RPC_URL ?? rpcUrl),
    simulation: createSponsorProbeSimulationConnection(process.env.COOKIE_RPC_URL ?? rpcUrl),
  };
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const nonce = randomBytes(24).toString('base64');
  const template = await readFile(new URL('./wallet-probe.html', import.meta.url), 'utf8');
  const page = template.replaceAll('__NONCE__', nonce).replace('__BOOTSTRAP__', safeJson({ token, genesisHash: snapshot.genesisHash, rpcUrl }));
  const sponsorTemplate = await readFile(new URL('./sponsor-probe.html', import.meta.url), 'utf8');
  const sponsorPage = sponsorTemplate.replaceAll('__NONCE__', nonce).replace('__BOOTSTRAP__', safeJson({ token, genesisHash: snapshot.genesisHash, rpcUrl }));
  const prepared = new Map<string, PreparedProbe>();
  const sponsorPrepared = new Map<string, SponsorProbeCandidate>();
  let origin = '';
  let preparing = false;

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    try {
      if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Use the local diagnostic URL directly.');
      if (request.method === 'GET' && (request.url === '/' || request.url === '/sponsor')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(request.url === '/sponsor' ? sponsorPage : page);
        return;
      }
      if (request.method !== 'POST' || !['/prepare', '/verify', '/sponsor/prepare', '/sponsor/verify'].includes(request.url ?? '')) throw new RequestError(404, 'Not found.');
      const providedToken = request.headers['x-probe-token'];
      const supplied = typeof providedToken === 'string' ? Buffer.from(providedToken) : Buffer.alloc(0);
      if (request.headers.origin !== origin || supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) throw new RequestError(403, 'Invalid local session or origin. Refresh the diagnostic page.');
      const input = await body(request);
      for (const [id, probe] of prepared) if (Date.now() - probe.createdAt > PROBE_TTL_MS) prepared.delete(id);
      for (const [id, probe] of sponsorPrepared) if (Date.now() >= probe.expiresAtMs) sponsorPrepared.delete(id);

      if (request.url === '/sponsor/prepare') {
        if (preparing || prepared.size + sponsorPrepared.size >= 20) throw new RequestError(429, 'A test is preparing or too many tests are pending. Wait before retrying.');
        preparing = true;
        try {
          const result = await prepareSponsorProbe(input, sponsorDependencies.client, sponsorDependencies.simulation);
          if (response.destroyed || response.writableEnded) return;
          let candidate = null;
          if (result.candidate) {
            const probe = result.candidate;
            if (Date.now() >= probe.expiresAtMs) throw new RequestError(410, 'The preparation expired. Check again before signing.');
            const id = randomUUID();
            sponsorPrepared.set(id, probe);
            candidate = { id, wallet: probe.user.toBase58(), name: `${probe.label}.cook`, mode: 'user-first',
              transactionBase64: unsignedBytes(probe.transaction).toString('base64'),
              messageSha256: createHash('sha256').update(probe.transaction.serializeMessage()).digest('hex'),
              expiresAtMs: probe.expiresAtMs, lastValidBlockHeight: probe.lastValidBlockHeight };
          }
          json(response, 200, { report: result.report, candidate });
        } finally { preparing = false; }
        return;
      }

      if (request.url === '/sponsor/verify') {
        onlyFields(input, ['id', 'signedTransactionBase64']);
        if (typeof input.id !== 'string' || typeof input.signedTransactionBase64 !== 'string') throw new RequestError(400, 'Invalid verification request.');
        const probe = sponsorPrepared.get(input.id);
        if (!probe) throw new RequestError(410, 'The test expired or was already verified. Check again before signing.');
        // Consume once, including failures and concurrent requests. This is a diagnostic, not a retry queue.
        sponsorPrepared.delete(input.id);
        const encoded = input.signedTransactionBase64;
        if (encoded.length > Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new RequestError(400, 'Invalid signed transaction encoding.');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || bytes.length > MAX_TRANSACTION_BYTES) throw new RequestError(400, 'Invalid signed transaction size or encoding.');
        let signed: Transaction;
        try { signed = validateUserSignature(probe.transaction, bytes, probe.user); }
        catch { throw new RequestError(400, 'The returned signature or transaction does not match this prepared test.'); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const [genesis, height] = await Promise.race([
            Promise.all([sponsorDependencies.simulation.getGenesisHash(), sponsorDependencies.simulation.getBlockHeight({
              commitment: 'finalized', minContextSlot: probe.report.simulation.contextSlot ?? probe.report.observation.blockhashContextSlot,
            })]),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RequestError(504, 'The chain freshness check timed out. Prepare another test.')), 4_000); }),
          ]);
          if (genesis !== snapshot.genesisHash || !Number.isSafeInteger(height) || height < (probe.report.simulation.blockHeightAfter ?? 0)) {
            throw new RequestError(410, 'The chain freshness check changed or returned invalid data. Prepare another test.', 'chain_changed');
          }
          if (height > probe.lastValidBlockHeight) {
            throw new RequestError(410, 'The transaction blockhash expired before verification. Prepare another test.', 'blockhash_expired');
          }
          if (Date.now() >= probe.expiresAtMs) throw new RequestError(410, 'The local preparation deadline passed. Prepare another test.');
        } finally { if (timer) clearTimeout(timer); }
        json(response, 200, {
          ...probe.report, outcome: 'passed', signatureRequestReady: false, signingEnabled: false,
          verifiedAt: new Date().toISOString(), mode: 'user-first', wallet: probe.user.toBase58(), genesisHash: snapshot.genesisHash,
          messageSha256: createHash('sha256').update(signed.serializeMessage()).digest('hex'), transactionBytes: bytes.length,
          requiredSignatures: 3, userSignatureValid: true, messageUnchanged: true,
          priorAttemptSignaturePreserved: 'Not tested in user-first mode', sponsorSignaturePresent: false, attemptSignaturePresent: false,
          lastValidBlockHeight: probe.lastValidBlockHeight, broadcast: false, registrationCompleted: false, phase0GateComplete: false,
        });
        return;
      }

      if (request.url === '/prepare') {
        onlyFields(input, ['wallet', 'mode']);
        if (typeof input.wallet !== 'string' || input.wallet.length > 44 || !['user-first', 'preserve-attempt-signature'].includes(String(input.mode))) throw new RequestError(400, 'Invalid wallet or test mode.');
        let wallet: PublicKey;
        try { wallet = new PublicKey(input.wallet); } catch { throw new RequestError(400, 'Invalid wallet address.'); }
        if (!PublicKey.isOnCurve(wallet.toBytes())) throw new RequestError(400, 'The wallet must be an on-curve signing account.');
        if (preparing || prepared.size + sponsorPrepared.size >= 20) throw new RequestError(429, 'A test is preparing or too many tests are pending. Wait before retrying.');
        preparing = true;
        try {
          const [genesis, block] = await Promise.all([rpc.getGenesisHash(), rpc.getLatestBlockhash('finalized')]);
          if (genesis !== snapshot.genesisHash) throw new RequestError(409, 'RPC genesis changed. Stop and review the chain snapshot.');
          // The sponsor secret is discarded immediately and is never used to sign.
          const sponsor = Keypair.generate().publicKey;
          const attempt = Keypair.generate();
          const mode = input.mode as ProbeMode;
          const label = `firstbiteprobe${randomBytes(5).toString('hex')}`;
          const transaction = buildSponsoredTransaction({
            label, sponsor, attemptPayer: attempt.publicKey, user: wallet, feeReceiver,
            registrationPrice: BigInt(snapshot.quote.price), domainRent: BigInt(snapshot.quote.domainRent),
            primaryRent: BigInt(snapshot.quote.primaryRent), blockhash: block.blockhash,
          });
          if (mode === 'preserve-attempt-signature') transaction.partialSign(attempt);
          const bytes = unsignedBytes(transaction);
          const id = randomUUID();
          prepared.set(id, { transaction, wallet, sponsor, attemptPayer: attempt.publicKey, mode, label, createdAt: Date.now(), lastValidBlockHeight: block.lastValidBlockHeight });
          json(response, 200, {
            id, wallet: wallet.toBase58(), name: `${label}.cook`, mode,
            transactionBase64: bytes.toString('base64'), transactionBytes: bytes.length,
            messageSha256: createHash('sha256').update(transaction.serializeMessage()).digest('hex'),
            requiredSigners: transaction.signatures.map(({ publicKey }) => publicKey.toBase58()),
            sponsor: sponsor.toBase58(), attemptPayer: attempt.publicKey.toBase58(),
            snapshotObservedAt: snapshot.observedAt, snapshotAmounts: { registrationPrice: snapshot.quote.price, domainRent: snapshot.quote.domainRent, primaryRent: snapshot.quote.primaryRent, unit: 'native base units' },
            blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight,
            sponsorSignature: 'Never created; transaction cannot be submitted successfully',
            broadcast: false,
          });
        } finally { preparing = false; }
        return;
      }

      onlyFields(input, ['id', 'signedTransactionBase64']);
      if (typeof input.id !== 'string' || typeof input.signedTransactionBase64 !== 'string') throw new RequestError(400, 'Invalid verification request.');
      const probe = prepared.get(input.id);
      if (!probe) throw new RequestError(410, 'The test expired or was already verified. Prepare another test.');
      const encoded = input.signedTransactionBase64;
      if (encoded.length > Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new RequestError(400, 'Invalid signed transaction encoding.');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length > MAX_TRANSACTION_BYTES) throw new RequestError(400, 'Invalid signed transaction size or encoding.');
      let signed: Transaction;
      try {
        if (probe.mode === 'user-first') signed = validateUserSignature(probe.transaction, bytes, probe.wallet);
        else {
          signed = Transaction.from(bytes);
          if (!signed.serializeMessage().equals(probe.transaction.serializeMessage())) throw new Error('Wallet changed the prepared message.');
          const originalAttempt = probe.transaction.signatures.find(({ publicKey }) => publicKey.equals(probe.attemptPayer))?.signature;
          const returnedAttempt = signed.signatures.find(({ publicKey }) => publicKey.equals(probe.attemptPayer))?.signature;
          if (!originalAttempt || !returnedAttempt?.equals(originalAttempt)) throw new Error('Nightly did not preserve the attempt-payer signature.');
          if (!signed.signatures.find(({ publicKey }) => publicKey.equals(probe.wallet))?.signature) throw new Error('Expected user signature is missing.');
          if (signed.signatures.find(({ publicKey }) => publicKey.equals(probe.sponsor))?.signature) throw new Error('Unexpected sponsor signature.');
          if (!signed.verifySignatures(false)) throw new Error('A returned signature is invalid.');
        }
      } catch (error) {
        throw new RequestError(400, error instanceof Error ? error.message : 'Signature verification failed.');
      }
      prepared.delete(input.id);
      json(response, 200, {
        test: 'Nightly signature compatibility only', verifiedAt: new Date().toISOString(),
        mode: probe.mode, wallet: probe.wallet.toBase58(), name: `${probe.label}.cook`,
        genesisHash: snapshot.genesisHash, messageSha256: createHash('sha256').update(signed.serializeMessage()).digest('hex'),
        transactionBytes: bytes.length, requiredSignatures: 3, userSignatureValid: true,
        messageUnchanged: true, priorAttemptSignaturePreserved: probe.mode === 'preserve-attempt-signature' ? true : 'Not tested in user-first mode',
        sponsorSignaturePresent: false, lastValidBlockHeight: probe.lastValidBlockHeight,
        broadcast: false, registrationCompleted: false, phase0GateComplete: false,
      });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error instanceof RequestError ? error.status : error instanceof SmokeWorksheetError && error.code === 'invalid_input' ? 400 : 500, {
        error: error instanceof RequestError || error instanceof SmokeWorksheetError ? error.message : 'The local test could not finish. Check that the public RPC is reachable and the saved snapshot is valid.',
        code: error instanceof SmokeWorksheetError ? error.code : error instanceof RequestError
          ? error.code ?? ({ 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 410: 'expired', 429: 'busy', 504: 'rpc_timeout' } as Record<number, string>)[error.status] ?? 'diagnostic_failed'
          : 'diagnostic_failed',
      });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the local diagnostic server.');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: async () => {
    prepared.clear();
    sponsorPrepared.clear();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

async function main(): Promise<void> {
  const snapshot = JSON.parse(await readFile('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot;
  const port = Number(process.env.WALLET_PROBE_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('WALLET_PROBE_PORT must be an integer from 1 to 65535.');
  const probe = await startWalletProbe({ snapshot, port });
  console.log(`Nightly signature diagnostic: ${probe.url}\nSponsor-backed check: ${probe.url}/sponsor\nOpen it in your Nightly browser. No funding or broadcast. Press Ctrl+C to stop.`);
  process.once('SIGINT', () => { void probe.close(); });
  process.once('SIGTERM', () => { void probe.close(); });
}

if (process.argv[1]?.endsWith('wallet-probe.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Missing chain snapshot. Complete phase0:inspect and review docs/evidence/chain-snapshot.json first.' : 'Could not start the local wallet diagnostic. Check the snapshot, port and dependencies.');
    process.exitCode = 1;
  });
}
