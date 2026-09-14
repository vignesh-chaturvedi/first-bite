import { z } from 'zod';

const reference = z.string().regex(/^E[0-9]{3}$/);
const nullableReference = reference.nullable();
const timestamp = z.iso.datetime();
const native = z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
const count = z.number().int().min(0).max(1_000);
const evidenceKind = z.enum(['nightly', 'registration', 'budget', 'activation', 'hosting', 'resolution', 'accounting', 'baseline', 'demo']);
export const pilotInputSchema = z.object({
  schemaVersion: z.literal(1),
  plannedParticipants: z.number().int().min(5).max(50),
  prerequisites: z.object({ nightly: nullableReference, fundedRegistration: nullableReference, budget: nullableReference,
    activation: nullableReference, hosting: nullableReference }).strict(),
  evidence: z.array(z.object({ id: reference, kind: evidenceKind, sha256: z.string().regex(/^[a-f0-9]{64}$/), recordedAt: timestamp }).strict()).max(500),
  observations: z.array(z.object({
    participantId: z.string().regex(/^P[0-9]{3}$/), sessionId: z.string().regex(/^S[0-9]{3}$/),
    environment: z.enum(['walkthrough', 'live']), observedAt: timestamp, commit: z.string().regex(/^[a-f0-9]{40}$/),
    outcome: z.enum(['completed', 'blocked', 'abandoned']), promptCount: count.nullable(),
    elapsedSeconds: z.number().int().min(0).max(86_400).nullable(), manualSteps: count.nullable(),
    walletRejected: z.boolean().nullable(), neededHelp: z.boolean().nullable(), recoveredAfterReload: z.boolean().nullable(),
    blockers: z.array(z.enum(['wallet_missing', 'wallet_rejected', 'wrong_wallet', 'wrong_network', 'name_unavailable',
      'unclear_coverage', 'unclear_approval', 'offline', 'timeout', 'session_expired', 'manual_review',
      'ownership_mismatch', 'resolution_failed', 'other'])).max(14),
    proof: z.object({ registration: nullableReference, ownerAndPrimaryMatch: z.boolean().nullable(), resolution: nullableReference,
      resolutionOutcome: z.enum(['not_checked', 'matches_owner', 'mismatch', 'escrow']) }).strict(),
  }).strict()).max(500),
  baselines: z.array(z.object({ id: z.string().regex(/^B[0-9]{3}$/), observedAt: timestamp,
    manualSteps: count, evidence: reference }).strict()).max(100),
  accounting: z.object({ evidence: reference, consistent: z.boolean(), capNative: native, spentNative: native,
    heldNative: native, residualNative: native, pendingAttempts: count, manualReviewAttempts: count }).strict().nullable(),
  demo: z.object({ evidence: reference, seconds: z.number().int().min(1).max(300), usesRealProduct: z.boolean(),
    participantDisclosure: z.enum(['none', 'consented', 'unapproved']) }).strict().nullable(),
}).strict();
export type PilotInput = z.infer<typeof pilotInputSchema>;
export class PilotReportError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_reference' | 'duplicate_record' | 'future_observation' | 'invalid_file' | 'file_unavailable') {
    super(`Pilot report unavailable: ${code}`); this.name = 'PilotReportError';
  }
}

export function emptyPilotInput(): PilotInput {
  return { schemaVersion: 1, plannedParticipants: 5,
    prerequisites: { nightly: null, fundedRegistration: null, budget: null, activation: null, hosting: null },
    evidence: [], observations: [], baselines: [], accounting: null, demo: null };
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new PilotReportError('duplicate_record');
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

/** Summarizes human-entered observations. It neither verifies artifacts nor certifies a live pilot. */
export function summarizePilot(value: unknown, now = Date.now()) {
  const parsed = pilotInputSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new PilotReportError('invalid_input');
  const input = parsed.data;
  unique(input.evidence.map((e) => e.id)); unique(input.observations.map((o) => o.sessionId)); unique(input.baselines.map((b) => b.id));
  unique(input.observations.map((o) => `${o.environment}:${o.participantId}:${Date.parse(o.observedAt)}`));
  const evidence = new Map(input.evidence.map((e) => [e.id, e]));
  const check = (id: string | null, kind: z.infer<typeof evidenceKind>) => {
    if (id !== null && evidence.get(id)?.kind !== kind) throw new PilotReportError('invalid_reference');
  };
  const p = input.prerequisites;
  check(p.nightly, 'nightly'); check(p.fundedRegistration, 'registration'); check(p.budget, 'budget');
  check(p.activation, 'activation'); check(p.hosting, 'hosting');
  const moments = [...input.evidence.map((e) => e.recordedAt), ...input.observations.map((o) => o.observedAt), ...input.baselines.map((b) => b.observedAt)];
  if (moments.some((m) => Date.parse(m) > now)) throw new PilotReportError('future_observation');
  for (const b of input.baselines) check(b.evidence, 'baseline');
  // Each baseline artifact represents one observation; renaming it cannot add weight.
  unique(input.baselines.map((b) => evidence.get(b.evidence)!.sha256));
  if (input.accounting) check(input.accounting.evidence, 'accounting');
  if (input.demo) check(input.demo.evidence, 'demo');
  const transactionOwners = new Map<string, string>();
  for (const o of input.observations) {
    unique(o.blockers); check(o.proof.registration, 'registration'); check(o.proof.resolution, 'resolution');
    // The same transaction artifact cannot count as two different newcomers.
    if (o.environment === 'live' && o.proof.registration) {
      const digest = evidence.get(o.proof.registration)!.sha256;
      const owner = transactionOwners.get(digest);
      if (owner && owner !== o.participantId) throw new PilotReportError('duplicate_record');
      transactionOwners.set(digest, o.participantId);
    }
  }
  const live = input.observations.filter((o) => o.environment === 'live');
  const latest = new Map<string, PilotInput['observations'][number]>();
  for (const o of live) {
    const previous = latest.get(o.participantId);
    if (!previous || Date.parse(previous.observedAt) < Date.parse(o.observedAt)) latest.set(o.participantId, o);
  }
  const participants = [...latest.values()];
  const completed = participants.filter((o) => o.outcome === 'completed');
  const completeProof = completed.filter((o) => o.proof.registration && o.proof.ownerAndPrimaryMatch
    && o.proof.resolution && o.proof.resolutionOutcome === 'matches_owner' && !o.blockers.length);
  const unresolved = participants.filter((o) => o.outcome !== 'completed' || o.blockers.length > 0
    || o.proof.ownerAndPrimaryMatch === false || o.proof.resolutionOutcome === 'mismatch' || o.proof.resolutionOutcome === 'escrow');
  const steps = completed.flatMap((o) => o.manualSteps === null ? [] : [o.manualSteps]);
  const baselineSteps = input.baselines.map((b) => b.manualSteps);
  const missing: string[] = Object.entries(p).filter(([, id]) => id === null).map(([key]) => `prerequisite_${key}`);
  if (participants.length < 5) missing.push('five_live_newcomers');
  if (participants.length > input.plannedParticipants) missing.push('observations_exceed_plan');
  if (completeProof.length < 5 || completeProof.length !== participants.length) missing.push('completion_and_resolution_evidence');
  if (unresolved.length) missing.push('unresolved_participant_blockers');
  if (live.some((o) => o.promptCount === null || o.manualSteps === null || o.elapsedSeconds === null
    || o.walletRejected === null || o.neededHelp === null)) missing.push('incomplete_session_observations');
  if (!steps.length || !baselineSteps.length) missing.push('observed_step_comparison');
  const a = input.accounting;
  let money: { capNative: string; spentNative: string; heldNative: string; residualNative: string; availableNative: string } | null = null;
  if (!a) missing.push('accounting_evidence');
  else {
    const available = BigInt(a.capNative) - BigInt(a.spentNative) - BigInt(a.heldNative);
    if (BigInt(a.capNative) <= 0n || available < 0n || !a.consistent) missing.push('accounting_discrepancy');
    if (BigInt(a.heldNative) !== 0n || BigInt(a.residualNative) !== 0n || a.pendingAttempts || a.manualReviewAttempts) missing.push('unsettled_accounting');
    money = { capNative: a.capNative, spentNative: a.spentNative, heldNative: a.heldNative,
      residualNative: a.residualNative, availableNative: available.toString() };
  }
  const d = input.demo;
  const lastSession = Math.max(0, ...live.map((o) => Date.parse(o.observedAt)));
  if (a && Date.parse(evidence.get(a.evidence)!.recordedAt) < lastSession) missing.push('accounting_predates_observations');
  if (!d || !d.usesRealProduct || d.seconds < 60 || d.seconds > 90 || d.participantDisclosure === 'unapproved') missing.push('live_demo_and_disclosure');
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), provenance: 'operator_recorded_unverified',
    phase7Complete: false, manualReviewRequired: true, activationChanged: false,
    recordChecklistSatisfied: missing.length === 0, missingEvidence: missing,
    observations: { plannedParticipants: input.plannedParticipants, liveSessions: live.length,
      liveParticipants: participants.length, walkthroughSessions: input.observations.length - live.length,
      latestCompletedParticipants: completed.length, participantsWithCompleteRecordedProof: completeProof.length,
      unresolvedParticipants: unresolved.length, sessionsWithWalletRejection: live.filter((o) => o.walletRejected).length,
      sessionsWithUnknownRejection: live.filter((o) => o.walletRejected === null).length,
      sessionsNeedingHelp: live.filter((o) => o.neededHelp).length,
      sessionsWithUnknownAssistance: live.filter((o) => o.neededHelp === null).length,
      sessionsRecoveredAfterReload: live.filter((o) => o.recoveredAfterReload === true).length,
      medianLatestCompletedSessionSeconds: median(completed.flatMap((o) => o.elapsedSeconds === null ? [] : [o.elapsedSeconds])),
    },
    stepsComparison: steps.length && baselineSteps.length ? { firstBiteSamples: steps.length, baselineSamples: baselineSteps.length,
      firstBiteMedianSteps: median(steps), baselineMedianSteps: median(baselineSteps),
      observedMedianStepDifference: median(baselineSteps)! - median(steps)! } : null,
    recordedAccounting: money,
    limitations: ['Artifact hashes and observations are entered by the operator; their contents were not independently checked.',
      'Participant codes do not prove unique people. Review recruitment and artifact mappings privately.',
      'Step counts are descriptive observations, not a causal conversion or performance claim.',
      'This report cannot authorize signing, distribute invitations, publish participant data or mark the phase complete.'],
  };
}
