import { createHash, randomUUID } from 'node:crypto';
import { Keypair, Message, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import type { CampaignContext } from '../campaigns/types';
import { validateStoredQuote } from '../campaigns/validation';
import type { RegistryClient, RegistryInput, RegistryObservation } from '../chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../chain/policy';
import { normalizeName } from '../cookie/registry';
import { MAX_TRANSACTION_BYTES, nativeAmount, unsignedBytes } from '../cookie/transaction';
import { verifySettlement } from '../execution/settlement';
import { ExecutionError, type ExecutionAttempt, type ExecutionChain, type ExecutionObservation, type ExecutionOperation } from '../execution/types';
import { smokeWorksheetInputSchema, type SmokeWorksheetInput } from '../operations/smoke-worksheet';
import type { SponsorProbeSimulationConnection } from '../operations/sponsor-probe';
import { assertUnsignedQuoteFresh, prepareSponsoredQuote, QuoteError, type SponsoredQuote } from '../transactions/quote';
import type { SmokeJournal } from './journal';

export type SmokeRunnerStatus = 'initialized' | 'prepared' | 'user_signed' | 'wallets_signed' | 'authorized'
  | 'signed' | 'broadcasting' | 'submitted' | 'broadcast_unknown' | 'confirmed' | 'complete' | 'failed' | 'manual_review';
type Role = 'user' | 'sponsor';
type Code = 'invalid_input' | 'not_initialized' | 'already_initialized' | 'wrong_stage' | 'busy'
  | 'storage_unavailable' | 'invalid_state' | 'signature_invalid' | 'quote_expired' | 'policy_changed'
  | 'chain_unavailable' | 'simulation_failed' | 'disabled' | 'acknowledgement_required' | 'evidence_invalid';
export class SmokeRunnerError extends Error {
  constructor(readonly code: Code) { super(`Registration check unavailable: ${code}`); this.name = 'SmokeRunnerError'; }
}
interface Candidate {
  id: string;
  quote: SponsoredQuote;
  simulation: { slot: number; unitsConsumed: number | null; blockHeight: number };
}
interface SettlementReport { success: boolean; fee: string; debit: string; residual: string; slot: number }
/** Private, whole-snapshot encrypted journal content. Never return or log this object. */
export interface SmokeRunnerState {
  version: 1;
  status: SmokeRunnerStatus;
  config: SmokeWorksheetInput;
  attemptId: string;
  attemptPayer: string;
  attemptSecretBase64: string | null;
  candidate: Candidate | null;
  userSignedBase64: string | null;
  sponsorSignedBase64: string | null;
  authorizedAtMs: number | null;
  signedBase64: string | null;
  transactionSignature: string | null;
  settlement: SettlementReport | null;
  observation: { status: ExecutionObservation['status']; finalizedBlockHeight: number; accountSlot: number } | null;
  manualReason: 'expired' | 'evidence_invalid' | 'recovery_needed' | null;
}
export interface SmokeRunnerOptions {
  journal: SmokeJournal<SmokeRunnerState>;
  registry: RegistryClient;
  chain: ExecutionChain;
  simulation: SponsorProbeSimulationConnection;
  now?: () => number;
  allowLive: boolean;
}
const acknowledgement = z.object({ messageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxTotalSpend: z.string(), confirmSpend: z.literal(true) }).strict();
const uuid = z.string().uuid();
const states: SmokeRunnerStatus[] = ['initialized', 'prepared', 'user_signed', 'wallets_signed', 'authorized',
  'signed', 'broadcasting', 'submitted', 'broadcast_unknown', 'confirmed', 'complete', 'failed', 'manual_review'];
const refreshable: SmokeRunnerStatus[] = ['initialized', 'prepared', 'user_signed', 'wallets_signed'];
const observedStates: SmokeRunnerStatus[] = ['broadcasting', 'submitted', 'broadcast_unknown', 'confirmed', 'manual_review'];
function fail(code: Code): never { throw new SmokeRunnerError(code); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const count = (v: number, minimum = 0) => {
  if (!Number.isSafeInteger(v) || v < minimum) fail('evidence_invalid');
  return v;
};
function bytes(value: string): Buffer {
  if (typeof value !== 'string' || value.length > 1644) fail('signature_invalid');
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.length > MAX_TRANSACTION_BYTES || result.toString('base64') !== value) fail('signature_invalid');
  return result;
}
function transaction(value: string): Transaction {
  const raw = bytes(value), tx = Transaction.from(raw);
  if (raw[0] !== 3 || raw[193] !== 3 || tx.signatures.length !== 3 || !unsignedBytes(tx).equals(raw)) fail('signature_invalid');
  return tx;
}
function signature58(signature: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${signature.toString('hex')}`), encoded = '', zeroes = 0;
  while (value) { encoded = alphabet[Number(value % 58n)]! + encoded; value /= 58n; }
  while (zeroes < signature.length && signature[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + encoded;
}
function singleSignature(q: SponsoredQuote, value: string, role: Role): Transaction {
  try {
    const tx = transaction(value), original = transaction(q.unsignedTransactionBase64);
    if (!tx.serializeMessage().equals(original.serializeMessage()) || hash(tx.serializeMessage()) !== q.messageSha256
      || !tx.signatures.some(({ publicKey }) => publicKey.toBase58() === q[role])
      || tx.signatures.some(({ publicKey, signature }) => (signature !== null) !== (publicKey.toBase58() === q[role]))
      || !tx.verifySignatures(false)) throw new Error();
    return tx;
  } catch { fail('signature_invalid'); }
}
function campaign(s: SmokeRunnerState): CampaignContext {
  const l = s.config.limits;
  return { id: s.attemptId, slug: 'single-registration', name: 'One registration', status: 'active',
    startsAt: new Date(0), endsAt: new Date(8_640_000_000_000_000), maxUsers: 1,
    capNative: l.maxTotalSpend, reservedNative: s.candidate?.quote.cost.maximumReservation ?? '0', spentNative: '0',
    reservedUsers: 1, consumedUsers: 0, sponsorPublicKey: s.config.sponsor, policyVersion: policy.id,
    limits: { maxRegistrationPrice: BigInt(l.maxRegistrationPrice), maxTransactionFee: BigInt(l.maxTransactionFee),
      recoveryAllowance: BigInt(l.recoveryAllowance), maxReservation: BigInt(l.maxTotalSpend), ttlMs: 60_000 } };
}
function validateQuote(s: SmokeRunnerState, at: number): SponsoredQuote {
  const q = s.candidate?.quote;
  if (!q || q.attemptPayer !== s.attemptPayer || q.name !== s.config.name) fail('invalid_state');
  try { validateStoredQuote(q, campaign(s), s.config.user, at); }
  catch { fail(at >= q.expiresAtMs ? 'quote_expired' : 'policy_changed'); }
  return q;
}
function execution(s: SmokeRunnerState): { operation: ExecutionOperation; attempt: ExecutionAttempt } {
  const q = s.candidate!.quote;
  const operation: ExecutionOperation = { id: s.candidate!.id, attemptId: s.attemptId, campaignId: s.attemptId,
    kind: 'registration', status: 'submitted', messageHash: q.messageSha256, messageBase64: q.messageBase64,
    encryptedUserPayload: null, encryptedSignedPayload: null, signature: s.transactionSignature,
    blockhash: q.blockhash, lastValidBlockHeight: q.lastValidBlockHeight, feeCapNative: q.cost.transactionFee,
    amountNative: q.cost.maxSponsorDebit, authorizedAt: new Date(s.authorizedAtMs!) };
  return { operation, attempt: { id: s.attemptId, inviteId: s.attemptId, campaignId: s.attemptId,
    wallet: s.config.user, name: s.config.name, payerPublicKey: s.attemptPayer, status: s.status,
    encryptedPayerKey: null, remainingReservationNative: q.cost.maximumReservation,
    actualCostNative: s.settlement?.debit ?? '0', residualNative: s.settlement?.residual ?? null,
    quote: structuredClone(q), campaign: campaign(s), operation } };
}
// Composite adapters perform several independently bounded RPC reads. Their
// overall deadline allows those reads to finish without relaxing quote expiry.
const COMPOSITE_READ_TIMEOUT_MS = 15_000;
async function bounded<T>(action: () => Promise<T>, timeoutMs = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmokeRunnerError('chain_unavailable')), timeoutMs);
  })]); } catch (error) {
    if (error instanceof SmokeRunnerError) throw error;
    if (error instanceof ExecutionError && ['evidence_invalid', 'quote_expired', 'policy_changed'].includes(error.code)) {
      fail(error.code as 'evidence_invalid' | 'quote_expired' | 'policy_changed');
    }
    fail('chain_unavailable');
  }
  finally { clearTimeout(timer); }
}
function checkedObservation(value: RegistryObservation, input: RegistryInput): RegistryObservation {
  try {
    if (value.label !== input.label || !value.sponsor.equals(input.sponsor) || !value.user.equals(input.user)
      || !value.attemptPayer.equals(input.attemptPayer) || value.policyId !== policy.id || value.genesisHash !== policy.genesisHash
      || value.configSha256 !== policy.configSha256 || value.programSha256 !== policy.programSha256
      || value.feeReceiver.toBase58() !== policy.feeReceiverAddress || value.domainRent !== policy.domainRent
      || ![0n, policy.primaryRent].includes(value.primaryRent) || value.userBalance !== 0n) throw new Error();
    nativeAmount(value.sponsorBalance); nativeAmount(value.registrationPrice);
    count(value.observedSlot); count(value.blockhashContextSlot, value.observedSlot); count(value.lastValidBlockHeight); count(value.observedAtMs);
    return { ...value, sponsor: new PublicKey(value.sponsor.toBytes()), user: new PublicKey(value.user.toBytes()),
      attemptPayer: new PublicKey(value.attemptPayer.toBytes()), feeReceiver: new PublicKey(value.feeReceiver.toBytes()) };
  } catch { fail('policy_changed'); }
}
function validateState(value: SmokeRunnerState): void {
  try {
    const parsed = smokeWorksheetInputSchema.parse(value.config);
    if (value.version !== 1 || !states.includes(value.status) || parsed.name !== normalizeName(parsed.name)
      || !uuid.safeParse(value.attemptId).success || parsed.sponsor === parsed.user
      || [parsed.sponsor, parsed.user].includes(value.attemptPayer)) throw new Error();
    const key = new PublicKey(value.attemptPayer);
    if (!PublicKey.isOnCurve(key.toBytes()) || key.toBase58() !== value.attemptPayer) throw new Error();
    if (value.attemptSecretBase64 !== null) {
      const secret = Buffer.from(value.attemptSecretBase64, 'base64');
      try { if (secret.length !== 64 || secret.toString('base64') !== value.attemptSecretBase64
        || !Keypair.fromSecretKey(secret).publicKey.equals(key)) throw new Error(); } finally { secret.fill(0); }
    } else if (!['complete', 'failed'].includes(value.status) || value.settlement?.residual !== '0') throw new Error();
    if (value.candidate) {
      uuid.parse(value.candidate.id);
      const q = validateQuote(value, value.candidate.quote.preparedAtMs);
      count(q.preparedAtMs); count(q.observedSlot); count(q.blockhashContextSlot, q.observedSlot);
      count(value.candidate.simulation.slot, q.blockhashContextSlot);
      if (count(value.candidate.simulation.blockHeight) > q.lastValidBlockHeight) throw new Error();
      if (value.candidate.simulation.unitsConsumed !== null) count(value.candidate.simulation.unitsConsumed);
      if (value.userSignedBase64) singleSignature(q, value.userSignedBase64, 'user');
      if (value.sponsorSignedBase64) singleSignature(q, value.sponsorSignedBase64, 'sponsor');
      if (value.signedBase64) {
        const tx = transaction(value.signedBase64);
        if (!tx.verifySignatures(true) || !tx.signature || signature58(tx.signature) !== value.transactionSignature
          || !tx.serializeMessage().equals(bytes(q.messageBase64)) || value.authorizedAtMs === null) throw new Error();
      } else if (value.transactionSignature !== null) throw new Error();
    } else if (value.status !== 'initialized') throw new Error();
    if (value.status === 'initialized' && (value.candidate || value.userSignedBase64 || value.sponsorSignedBase64)) throw new Error();
    if (value.status === 'prepared' && (value.userSignedBase64 || value.sponsorSignedBase64)) throw new Error();
    if (value.status === 'user_signed' && (!value.userSignedBase64 || value.sponsorSignedBase64)) throw new Error();
    if (!['initialized', 'prepared', 'user_signed'].includes(value.status) && (!value.userSignedBase64 || !value.sponsorSignedBase64)) throw new Error();
    if (refreshable.includes(value.status) && (value.authorizedAtMs !== null || value.signedBase64)) throw new Error();
    if (value.authorizedAtMs !== null) count(value.authorizedAtMs);
    if (!refreshable.includes(value.status) && value.authorizedAtMs === null) throw new Error();
    if (['signed', 'broadcasting', 'submitted', 'broadcast_unknown', 'confirmed', 'complete', 'failed'].includes(value.status) && !value.signedBase64) throw new Error();
    if (!['expired', 'evidence_invalid', 'recovery_needed', null].includes(value.manualReason)) throw new Error();
    if (value.observation !== null) {
      if (!['missing', 'processed', 'confirmed', 'finalized'].includes(value.observation.status)) throw new Error();
      count(value.observation.finalizedBlockHeight); count(value.observation.accountSlot);
    }
    if (value.settlement !== null) {
      const settled = value.settlement;
      if (typeof settled.success !== 'boolean' || !value.candidate || value.observation?.status !== 'finalized') throw new Error();
      for (const amount of [settled.fee, settled.debit, settled.residual]) {
        if (typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error();
        nativeAmount(BigInt(amount));
      }
      if (BigInt(settled.fee) > BigInt(value.candidate.quote.cost.transactionFee)
        || BigInt(settled.debit) > BigInt(value.candidate.quote.cost.maxSponsorDebit)
        || count(settled.slot) > value.observation.accountSlot) throw new Error();
    }
    if (['complete', 'failed'].includes(value.status) && (!value.settlement || value.settlement.residual !== '0'
      || value.settlement.success !== (value.status === 'complete') || value.attemptSecretBase64 !== null)) throw new Error();
  } catch { fail('invalid_state'); }
}

/** One durable A and one fixed config. Opening a journal never signs or sends. */
export async function createSmokeRunner(options: SmokeRunnerOptions) {
  const { journal, registry, chain, simulation } = options;
  const now = options.now ?? Date.now, allowLive = options.allowLive === true;
  let state: SmokeRunnerState | null;
  try { state = structuredClone(await journal.read()); } catch { fail('storage_unavailable'); }
  if (state) validateState(state);
  let busy = false, poisoned = false;
  function required() { if (!state) fail('not_initialized'); return state; }
  async function write(value: SmokeRunnerState) {
    validateState(value);
    try { await journal.write(structuredClone(value)); state = structuredClone(value); }
    catch { poisoned = true; fail('storage_unavailable'); }
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (poisoned) fail('storage_unavailable');
    if (busy) fail('busy');
    busy = true;
    try { return await operation(); }
    catch (error) {
      if (error instanceof SmokeRunnerError) throw error;
      if (error instanceof QuoteError && error.code === 'quote_expired') fail('quote_expired');
      fail('chain_unavailable');
    }
    finally { busy = false; }
  }
  function report() {
    if (!state) return { status: 'uninitialized', config: null, attemptPayer: null, quote: null, id: null,
      userSigned: false, sponsorSigned: false, transactionSignature: null, settlement: null,
      observation: null, manualReason: null, allowLive, phase0GateComplete: false };
    const s = state, q = s.candidate?.quote;
    return structuredClone({ status: s.status, config: s.config, attemptPayer: s.attemptPayer, id: s.candidate?.id ?? null,
      quote: q ? { messageSha256: q.messageSha256, preparedAtMs: q.preparedAtMs, expiresAtMs: q.expiresAtMs,
        observedSlot: q.observedSlot, blockhashContextSlot: q.blockhashContextSlot, lastValidBlockHeight: q.lastValidBlockHeight,
        policyId: q.policyId, genesisHash: q.genesisHash, configSha256: q.configSha256, programSha256: q.programSha256,
        cost: { registrationPrice: q.cost.registrationPrice, domainRent: q.cost.domainRent, primaryRent: q.cost.primaryRent,
          transactionFee: q.cost.transactionFee, recoveryAllowance: q.cost.recoveryAllowance,
          maxSponsorDebit: q.cost.maxSponsorDebit, maximumReservation: q.cost.maximumReservation },
        expected: { domain: q.expected.domain, owner: q.expected.owner, primary: q.expected.primary, primaryName: q.expected.primaryName },
        simulation: { slot: s.candidate!.simulation.slot, unitsConsumed: s.candidate!.simulation.unitsConsumed,
          blockHeight: s.candidate!.simulation.blockHeight } } : null,
      userSigned: s.userSignedBase64 !== null, sponsorSigned: s.sponsorSignedBase64 !== null,
      transactionSignature: s.transactionSignature,
      settlement: s.settlement ? { success: s.settlement.success, fee: s.settlement.fee, debit: s.settlement.debit,
        residual: s.settlement.residual, slot: s.settlement.slot } : null,
      observation: s.observation ? { status: s.observation.status, finalizedBlockHeight: s.observation.finalizedBlockHeight,
        accountSlot: s.observation.accountSlot } : null,
      manualReason: s.manualReason, allowLive, phase0GateComplete: false });
  }
  const guardedRegistry: RegistryClient = {
    async observe(input) {
      const owned = { label: input.label, sponsor: new PublicKey(input.sponsor.toBytes()), user: new PublicKey(input.user.toBytes()),
        attemptPayer: new PublicKey(input.attemptPayer.toBytes()) };
      const start = count(now());
      const result = checkedObservation(await bounded(() => registry.observe({ ...owned,
        sponsor: new PublicKey(owned.sponsor.toBytes()), user: new PublicKey(owned.user.toBytes()), attemptPayer: new PublicKey(owned.attemptPayer.toBytes()) }), COMPOSITE_READ_TIMEOUT_MS), owned);
      if (result.observedAtMs < start || result.observedAtMs > count(now(), start)) fail('policy_changed');
      return result;
    },
    getMessageFee: (message, slot) => bounded(() => registry.getMessageFee(message, slot)),
  };
  async function height(q: SponsoredQuote, minimumSlot: number, minimumHeight: number) {
    if (await bounded(() => simulation.getGenesisHash()) !== policy.genesisHash) fail('policy_changed');
    const h = count(await bounded(() => simulation.getBlockHeight({ commitment: 'finalized', minContextSlot: minimumSlot })), minimumHeight);
    try { assertUnsignedQuoteFresh(q, count(now()), h); } catch { fail('quote_expired'); }
    return h;
  }
  async function recheck(s: SmokeRunnerState) {
    const q = validateQuote(s, count(now()));
    const o = await guardedRegistry.observe({ label: q.name, sponsor: new PublicKey(q.sponsor),
      user: new PublicKey(q.user), attemptPayer: new PublicKey(q.attemptPayer) });
    if (o.observedSlot < s.candidate!.simulation.slot || o.registrationPrice.toString() !== q.cost.registrationPrice
      || o.domainRent.toString() !== q.cost.domainRent || o.primaryRent.toString() !== q.cost.primaryRent
      || o.sponsorBalance < BigInt(q.cost.maximumReservation)) fail('policy_changed');
    const fee = await guardedRegistry.getMessageFee(Message.from(bytes(q.messageBase64)), o.blockhashContextSlot);
    if (typeof fee !== 'bigint' || fee <= 0n || fee > BigInt(q.cost.transactionFee)) fail('policy_changed');
    return height(q, o.blockhashContextSlot, s.candidate!.simulation.blockHeight);
  }
  async function markReview(reason: SmokeRunnerState['manualReason']) {
    await write({ ...required(), status: 'manual_review', manualReason: reason });
    return report();
  }
  return {
    status: async () => { if (poisoned) fail('storage_unavailable'); return report(); },
    initialize: (input: unknown) => exclusive(async () => {
      if (state) fail('already_initialized');
      let config: SmokeWorksheetInput;
      try { config = smokeWorksheetInputSchema.parse(input); config.name = normalizeName(config.name);
        if (config.sponsor === config.user) throw new Error(); } catch { fail('invalid_input'); }
      const payer = Keypair.generate();
      await write({ version: 1, status: 'initialized', config, attemptId: randomUUID(), attemptPayer: payer.publicKey.toBase58(),
        attemptSecretBase64: Buffer.from(payer.secretKey).toString('base64'), candidate: null, userSignedBase64: null,
        sponsorSignedBase64: null, authorizedAtMs: null, signedBase64: null, transactionSignature: null,
        settlement: null, observation: null, manualReason: null });
      return report();
    }),
    prepare: () => exclusive(async () => {
      const s = required();
      if (!refreshable.includes(s.status)) fail('wrong_stage');
      // Invalidate old wallet approvals before the first external read, even if preparation fails.
      await write({ ...s, status: 'initialized', candidate: null, userSignedBase64: null, sponsorSignedBase64: null });
      const q = await prepareSponsoredQuote({ name: s.config.name, sponsor: new PublicKey(s.config.sponsor),
        user: new PublicKey(s.config.user), attemptPayer: new PublicKey(s.attemptPayer) }, guardedRegistry, campaign(s).limits, now);
      const before = await height(q, q.blockhashContextSlot, 0);
      const original = bytes(q.unsignedTransactionBase64), tx = VersionedTransaction.deserialize(original);
      const simulated = await bounded(() => simulation.simulateTransaction(tx, { commitment: 'finalized', sigVerify: false,
        replaceRecentBlockhash: false, minContextSlot: q.blockhashContextSlot }));
      if (!Buffer.from(tx.serialize()).equals(original) || simulated.value.err !== null
        || ('replacementBlockhash' in simulated.value && simulated.value.replacementBlockhash)) fail('simulation_failed');
      const slot = count(simulated.context.slot, q.blockhashContextSlot);
      const unitsConsumed = simulated.value.unitsConsumed === undefined ? null : count(simulated.value.unitsConsumed);
      const blockHeight = await height(q, slot, before);
      await write({ ...required(), status: 'prepared', candidate: { id: randomUUID(), quote: structuredClone(q),
        simulation: { slot, unitsConsumed, blockHeight } } });
      return report();
    }),
    walletRequest: (role: Role) => exclusive(async () => {
      const s = required();
      if ((role !== 'user' || s.status !== 'prepared') && (role !== 'sponsor' || s.status !== 'user_signed')) fail('wrong_stage');
      await recheck(s);
      const { id, quote: q } = s.candidate!;
      return { role, address: q[role], transactionBase64: q.unsignedTransactionBase64, id,
        messageSha256: q.messageSha256, expiresAtMs: q.expiresAtMs };
    }),
    acceptSignature: (role: Role, id: string, signedBase64: string) => exclusive(async () => {
      const s = required();
      if ((role !== 'user' || s.status !== 'prepared') && (role !== 'sponsor' || s.status !== 'user_signed')) fail('wrong_stage');
      if (!s.candidate || id !== s.candidate.id) fail('invalid_input');
      singleSignature(s.candidate.quote, signedBase64, role);
      await recheck(s);
      await write(role === 'user' ? { ...s, status: 'user_signed', userSignedBase64: signedBase64 }
        : { ...s, status: 'wallets_signed', sponsorSignedBase64: signedBase64 });
      return report();
    }),
    submit: (input: unknown) => exclusive(async () => {
      let s = required();
      if (!allowLive) fail('disabled');
      const ack = acknowledgement.safeParse(input);
      if (!ack.success || !s.candidate || ack.data.messageSha256 !== s.candidate.quote.messageSha256
        || ack.data.maxTotalSpend !== s.config.limits.maxTotalSpend) fail('acknowledgement_required');
      // Once any send may have happened, only reconcile the original bytes; never automatically resend.
      if (observedStates.includes(s.status) || ['complete', 'failed'].includes(s.status)) return report();
      if (!['wallets_signed', 'authorized', 'signed'].includes(s.status)) fail('wrong_stage');
      try {
        await recheck(s);
        const q = s.candidate.quote;
        singleSignature(q, s.userSignedBase64!, 'user'); singleSignature(q, s.sponsorSignedBase64!, 'sponsor');
        const preflight = await bounded(() => chain.preflight(structuredClone(q), s.userSignedBase64!), COMPOSITE_READ_TIMEOUT_MS);
        if (count(preflight.checkedAtMs, q.preparedAtMs) > count(now()) || count(now()) - preflight.checkedAtMs >= 4_000
          || count(preflight.slot, s.candidate.simulation.slot) < q.blockhashContextSlot
          || typeof preflight.fee !== 'bigint' || preflight.fee <= 0n || preflight.fee > BigInt(q.cost.transactionFee)
          || typeof preflight.sponsorBalance !== 'bigint' || preflight.sponsorBalance < BigInt(q.cost.maximumReservation)) fail('policy_changed');
        try { assertUnsignedQuoteFresh(q, count(now()), count(preflight.blockHeight, s.candidate.simulation.blockHeight)); }
        catch { fail('quote_expired'); }
      } catch (error) {
        if (s.status !== 'wallets_signed' && error instanceof SmokeRunnerError && error.code === 'quote_expired') return markReview('expired');
        throw error;
      }
      if (s.status === 'wallets_signed') {
        await write({ ...s, status: 'authorized', authorizedAtMs: count(now()) });
        s = required();
      }
      if (s.status === 'authorized') {
        const q = s.candidate!.quote;
        const tx = singleSignature(q, s.userSignedBase64!, 'user');
        const sponsor = singleSignature(q, s.sponsorSignedBase64!, 'sponsor').signatures.find((v) => v.publicKey.toBase58() === q.sponsor)!;
        tx.addSignature(sponsor.publicKey, sponsor.signature!);
        const secret = Buffer.from(s.attemptSecretBase64!, 'base64');
        try { tx.partialSign({ publicKey: new PublicKey(s.attemptPayer), secretKey: secret }); }
        finally { secret.fill(0); }
        if (!tx.verifySignatures(true) || !tx.signature || hash(tx.serializeMessage()) !== q.messageSha256) fail('signature_invalid');
        const signedBase64 = tx.serialize({ requireAllSignatures: true, verifySignatures: true }).toString('base64');
        await write({ ...s, status: 'signed', signedBase64, transactionSignature: signature58(tx.signature) });
        s = required();
      }
      await write({ ...s, status: 'broadcasting' });
      // Crash after this write is ambiguous, even if broadcast was never reached. Resume observes only.
      try {
        const signature = await bounded(() => chain.broadcast(s.signedBase64!));
        if (signature !== s.transactionSignature) throw new Error();
      } catch {
        await write({ ...required(), status: 'broadcast_unknown' });
        return report();
      }
      await write({ ...required(), status: 'submitted' });
      return report();
    }),
    reconcile: () => exclusive(async () => {
      const s = required();
      if (['complete', 'failed'].includes(s.status)) return report();
      if (!observedStates.includes(s.status) || !s.signedBase64 || !s.transactionSignature) fail('wrong_stage');
      const { operation, attempt } = execution(s);
      let observation: ExecutionObservation;
      try { observation = await bounded(() => chain.observe(structuredClone(operation), structuredClone(attempt)), COMPOSITE_READ_TIMEOUT_MS); }
      catch (error) { if (error instanceof SmokeRunnerError && error.code === 'chain_unavailable') throw error; return markReview('evidence_invalid'); }
      try {
        count(observation.finalizedBlockHeight, s.observation?.finalizedBlockHeight ?? s.candidate!.simulation.blockHeight);
        count(observation.accountSlot, s.observation?.accountSlot ?? s.candidate!.simulation.slot);
        if (!['missing', 'processed', 'confirmed', 'finalized'].includes(observation.status)) throw new Error();
        const summary = { status: observation.status, finalizedBlockHeight: observation.finalizedBlockHeight, accountSlot: observation.accountSlot };
        if (observation.status !== 'finalized') {
          if (observation.receipt !== null) throw new Error();
          await write({ ...s, observation: summary,
            status: observation.finalizedBlockHeight > s.candidate!.quote.lastValidBlockHeight ? 'manual_review'
              : observation.status === 'confirmed' ? 'confirmed' : s.status,
            manualReason: observation.finalizedBlockHeight > s.candidate!.quote.lastValidBlockHeight ? 'expired' : s.manualReason });
          return report();
        }
        const result = verifySettlement(operation, attempt, observation, s.signedBase64);
        if (result.debit > BigInt(s.candidate!.quote.cost.maxSponsorDebit)
          || observation.receipt!.preBalances[observation.receipt!.accountKeys.indexOf(s.config.user)] !== 0n) throw new Error();
        const settlement = { success: result.success, fee: result.fee.toString(), debit: result.debit.toString(),
          residual: result.residual.toString(), slot: result.slot };
        await write({ ...s, settlement, observation: summary,
          status: result.residual > 0n ? 'manual_review' : result.success ? 'complete' : 'failed',
          manualReason: result.residual > 0n ? 'recovery_needed' : null,
          attemptSecretBase64: result.residual > 0n ? s.attemptSecretBase64 : null });
        return report();
      } catch (error) {
        if (error instanceof SmokeRunnerError && error.code === 'storage_unavailable') throw error;
        return markReview('evidence_invalid');
      }
    }),
  };
}
export type SmokeRunner = Awaited<ReturnType<typeof createSmokeRunner>>;
