import {
  Connection, Keypair, PublicKey, VersionedTransaction, type FetchFn, type Transaction,
} from '@solana/web3.js';
import type { RegistryClient } from '../chain/client';
import { COOKIE_REGISTRY_POLICY } from '../chain/policy';
import { unsignedBytes } from '../cookie/transaction';
import { prepareSmokePlan, SmokeWorksheetError } from './smoke-worksheet';

/** This port cannot sign, send, fund or subscribe. Use the same endpoint as the registry reader. */
export type SponsorProbeSimulationConnection = Pick<Connection,
  'getGenesisHash' | 'getBlockHeight' | 'simulateTransaction'>;
export type SponsorProbeFailure = 'rpc_timeout' | 'rpc_failed' | 'wrong_chain'
  | 'invalid_simulation' | 'stale_context' | 'observation_expired' | 'blockhash_expired'
  | 'AccountNotFound' | 'BlockhashNotFound' | 'transaction_failed';
export interface SponsorProbeSimulation {
  status: 'not_run' | 'passed' | 'failed';
  error: SponsorProbeFailure | null;
  contextSlot: number | null;
  unitsConsumed: number | null;
  blockHeightBefore: number | null;
  blockHeightAfter: number | null;
}
type WorksheetReport = Awaited<ReturnType<typeof prepareSmokePlan>>['report'];
export type SponsorProbeReport = Omit<WorksheetReport, 'purpose'> & {
  purpose: 'sponsor_backed_signature_diagnostic';
  outcome: 'blocked' | 'ready';
  signatureRequestReady: boolean;
  simulation: SponsorProbeSimulation;
};
export interface SponsorProbeCandidate {
  transaction: Transaction;
  sponsor: PublicKey;
  user: PublicKey;
  attemptPayer: PublicKey;
  label: string;
  expiresAtMs: number;
  lastValidBlockHeight: number;
  report: SponsorProbeReport;
}
export interface SponsorProbePreparation {
  report: SponsorProbeReport;
  candidate: SponsorProbeCandidate | null;
}
class ProbeRpcError extends Error {
  constructor(readonly code: SponsorProbeFailure) { super(`Sponsor probe unavailable: ${code}`); }
}
const REQUEST_TIMEOUT_MS = 4_000;
const PREPARATION_TTL_MS = 30_000;
const SIGNATURE_REQUEST_TTL_MS = 120_000;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is number => counter(value) && value <= 8_640_000_000_000_000;

/** Deadlines also cover injected adapters; only fixed error codes cross this boundary. */
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeRpcError('rpc_timeout')), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof ProbeRpcError) throw error;
    throw new ProbeRpcError(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'rpc_timeout' : 'rpc_failed');
  } finally { clearTimeout(timer); }
}

/** HTTP/body deadline, no retry loop, and no transport methods beyond the read-only port. */
export function createSponsorProbeSimulationConnection(endpoint: string): SponsorProbeSimulationConnection {
  const fetch: FetchFn = (input, init) => globalThis.fetch(input as string, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    const connection = new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch });
    return Object.freeze({ getGenesisHash: connection.getGenesisHash.bind(connection),
      getBlockHeight: connection.getBlockHeight.bind(connection), simulateTransaction: connection.simulateTransaction.bind(connection) });
  } catch { throw new ProbeRpcError('rpc_failed'); }
}

function simulationFailure(error: unknown): SponsorProbeFailure | null {
  if (error === null) return null;
  if (error === 'AccountNotFound' || error === 'BlockhashNotFound') return error;
  if (typeof error === 'string' && error.length > 0) return 'transaction_failed';
  if (typeof error === 'object' && error !== null && !Array.isArray(error) && Object.keys(error).length > 0) return 'transaction_failed';
  throw new ProbeRpcError('invalid_simulation');
}

/**
 * Prepare only a user-first signature diagnostic. A's secret is discarded at creation,
 * S never signs, and simulation never verifies signatures or replaces the blockhash.
 * An internal candidate is returned only after exact-cost, chain and lifetime checks.
 */
export async function prepareSponsorProbe(
  value: unknown, client: RegistryClient, connection: SponsorProbeSimulationConnection, now = Date.now,
): Promise<SponsorProbePreparation> {
  const startedAt = now();
  if (!time(startedAt) || startedAt > 8_640_000_000_000_000 - SIGNATURE_REQUEST_TTL_MS) throw new SmokeWorksheetError('invalid_input');
  // Keep only the public identity. No private-key reference survives this statement.
  const attemptPayer = Keypair.generate().publicKey;
  const plan = await prepareSmokePlan(value, {
    observe: (input) => bounded(() => client.observe(input)),
    getMessageFee: (message, slot) => bounded(() => client.getMessageFee(message, slot)),
  }, attemptPayer, now);
  const report: SponsorProbeReport = { ...plan.report,
    purpose: 'sponsor_backed_signature_diagnostic', outcome: 'blocked', signatureRequestReady: false,
    simulation: { status: 'not_run', error: null, contextSlot: null, unitsConsumed: null,
      blockHeightBefore: null, blockHeightAfter: null },
    limitations: [
      'This is a signature diagnostic. The sponsor never signs and the attempt key is discarded; the transaction cannot execute.',
      'Simulation uses the exact unsigned message with signature verification disabled. Success does not verify wallet signing or guarantee execution.',
      'The report contains metadata only. Unsigned candidate bytes stay in memory for a short-lived user signing request.',
      'The recovery allowance is operator supplied; concurrent sponsor activity and other campaign holds are not reserved.',
      'A funded registration, durable attempt custody, finality, independent resolution and pilot allocation remain separate gates.',
    ],
  };
  const blocked = (code?: SponsorProbeFailure): SponsorProbePreparation => {
    if (code) { report.blockers.push(code); report.simulation.error = code; report.simulation.status = 'failed'; }
    return { report, candidate: null };
  };
  if (!report.planningChecksSatisfied) return blocked();
  let latestTime = Date.parse(report.generatedAt);
  const fresh = () => {
    const current = now();
    if (!time(current) || current < latestTime || current - startedAt >= PREPARATION_TTL_MS
      || current - Date.parse(report.observation.observedAt) >= PREPARATION_TTL_MS) throw new ProbeRpcError('observation_expired');
    latestTime = current;
  };
  const minContextSlot = report.observation.blockhashContextSlot;
  const lastValidBlockHeight = report.observation.lastValidBlockHeight;
  try {
    fresh();
    const genesis = await bounded(() => connection.getGenesisHash());
    fresh();
    if (genesis !== COOKIE_REGISTRY_POLICY.genesisHash) return blocked('wrong_chain');
    const before = await bounded(() => connection.getBlockHeight({ commitment: 'finalized', minContextSlot }));
    fresh();
    if (!counter(before)) return blocked('invalid_simulation');
    report.simulation.blockHeightBefore = before;
    if (before > lastValidBlockHeight) return blocked('blockhash_expired');

    const expectedBytes = unsignedBytes(plan.transaction);
    // Keep the captured plan separate from the mutable object supplied to an injected adapter.
    const simulationTransaction = VersionedTransaction.deserialize(expectedBytes);
    const simulated = await bounded(() => connection.simulateTransaction(simulationTransaction, {
      commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot,
    }));
    fresh();
    if (!Buffer.from(simulationTransaction.serialize()).equals(expectedBytes)) return blocked('invalid_simulation');
    if (!simulated || !simulated.context || !counter(simulated.context.slot) || !simulated.value) return blocked('invalid_simulation');
    const contextSlot = simulated.context.slot;
    if (contextSlot < minContextSlot) return blocked('stale_context');
    report.simulation.contextSlot = contextSlot;
    const units = simulated.value.unitsConsumed;
    if (units !== undefined && !counter(units)) return blocked('invalid_simulation');
    report.simulation.unitsConsumed = units ?? null;
    const failure = simulationFailure(simulated.value.err);
    // No raw logs, return data or adapter-owned errors survive the await below.
    const after = await bounded(() => connection.getBlockHeight({ commitment: 'finalized', minContextSlot: contextSlot }));
    fresh();
    if (!counter(after) || after < before) return blocked('invalid_simulation');
    report.simulation.blockHeightAfter = after;
    if (after > lastValidBlockHeight) return blocked('blockhash_expired');
    if (failure) return blocked(failure);
    report.simulation.status = 'passed';
    report.outcome = 'ready';
    report.signatureRequestReady = true;
    return { report, candidate: { transaction: plan.transaction, sponsor: new PublicKey(report.sponsor),
      user: new PublicKey(report.user), attemptPayer: new PublicKey(report.diagnosticAttemptPayer),
      label: report.name.slice(0, -5), expiresAtMs: startedAt + SIGNATURE_REQUEST_TTL_MS,
      lastValidBlockHeight, report } };
  } catch (error) {
    return blocked(error instanceof ProbeRpcError ? error.code : 'invalid_simulation');
  }
}
