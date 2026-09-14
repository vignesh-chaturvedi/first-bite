import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPilotInput, summarizePilot, type PilotInput } from '../src/lib/pilot/report';
import { MAX_PILOT_INPUT_BYTES, readPilotInput, runPilotReport } from '../scripts/pilot/report';

const now = Date.parse('2026-09-14T12:00:00Z');
const observedAt = '2026-09-14T10:00:00Z';
const commit = 'c'.repeat(40);
const inputTemplate = fileURLToPath(new URL('../docs/pilot-input.template.json', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/pilot/report.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));

// Entirely synthetic unit-test records. They are never copied to pilot evidence.
function fixture(): PilotInput {
  const input = emptyPilotInput();
  const evidence = (kind: PilotInput['evidence'][number]['kind']) => {
    const index = input.evidence.length + 1;
    const id = `E${String(index).padStart(3, '0')}`;
    input.evidence.push({ id, kind, sha256: index.toString(16).padStart(64, '0'), recordedAt: observedAt });
    return id;
  };
  input.prerequisites = { nightly: evidence('nightly'), fundedRegistration: evidence('registration'),
    budget: evidence('budget'), activation: evidence('activation'), hosting: evidence('hosting') };
  for (let i = 1; i <= 5; i++) input.observations.push({
    participantId: `P00${i}`, sessionId: `S00${i}`, environment: 'live', observedAt, commit,
    outcome: 'completed', promptCount: 1, elapsedSeconds: i * 10, manualSteps: i,
    walletRejected: false, neededHelp: false, recoveredAfterReload: null, blockers: [],
    proof: { registration: evidence('registration'), ownerAndPrimaryMatch: true,
      resolution: evidence('resolution'), resolutionOutcome: 'matches_owner' },
  });
  input.baselines = [{ id: 'B001', observedAt, manualSteps: 8, evidence: evidence('baseline') },
    { id: 'B002', observedAt, manualSteps: 10, evidence: evidence('baseline') }];
  input.accounting = { evidence: evidence('accounting'), consistent: true, capNative: '90071992547409931',
    spentNative: '90071992547409930', heldNative: '0', residualNative: '0', pendingAttempts: 0, manualReviewAttempts: 0 };
  input.demo = { evidence: evidence('demo'), seconds: 75, usesRealProduct: true, participantDisclosure: 'none' };
  return input;
}

describe('offline pilot observations', () => {
  it('keeps the committed template blank and every live gate open', async () => {
    expect(JSON.parse(await readFile(inputTemplate, 'utf8'))).toEqual(emptyPilotInput());
    const report = summarizePilot(emptyPilotInput(), now);
    expect(report.recordChecklistSatisfied).toBe(false);
    expect(report.phase7Complete).toBe(false);
    expect(report.observations.liveParticipants).toBe(0);
    expect(report.stepsComparison).toBeNull();
    expect(report.missingEvidence).toContain('five_live_newcomers');
    expect(report.missingEvidence.filter((code) => code.startsWith('prerequisite_'))).toHaveLength(5);
  });

  it('reports entered records without certifying, activating or publishing a pilot', () => {
    const input = fixture();
    const before = structuredClone(input);
    const report = summarizePilot(input, now);
    expect(report).toMatchObject({ recordChecklistSatisfied: true, missingEvidence: [], phase7Complete: false,
      manualReviewRequired: true, activationChanged: false, provenance: 'operator_recorded_unverified' });
    expect(report.observations).toMatchObject({ liveParticipants: 5, liveSessions: 5, medianLatestCompletedSessionSeconds: 30 });
    expect(report.stepsComparison).toEqual({ firstBiteSamples: 5, baselineSamples: 2,
      firstBiteMedianSteps: 3, baselineMedianSteps: 9, observedMedianStepDifference: 6 });
    expect(report.recordedAccounting?.availableNative).toBe('1');
    expect(input).toEqual(before);
    const text = JSON.stringify(report);
    for (const marker of ['P001', 'S001', 'E001', commit, input.evidence[0]!.sha256]) expect(text).not.toContain(marker);
  });

  it('excludes every walkthrough from live denominators and success evidence', () => {
    const input = fixture();
    input.observations.forEach((o) => { o.environment = 'walkthrough'; });
    const report = summarizePilot(input, now);
    expect(report.observations).toMatchObject({ liveParticipants: 0, liveSessions: 0, walkthroughSessions: 5,
      latestCompletedParticipants: 0, medianLatestCompletedSessionSeconds: null });
    expect(report.recordChecklistSatisfied).toBe(false);
    expect(report.stepsComparison).toBeNull();
  });

  it('counts a retry as one person and retains earlier rejection and assistance', () => {
    const input = fixture();
    const first = input.observations[0]!;
    input.observations.push({ ...structuredClone(first), sessionId: 'S006', observedAt: '2026-09-14T09:00:00Z',
      outcome: 'blocked', elapsedSeconds: 1_800, walletRejected: true, neededHelp: true, blockers: ['wallet_rejected'],
      proof: { registration: null, ownerAndPrimaryMatch: null, resolution: null, resolutionOutcome: 'not_checked' } });
    first.recoveredAfterReload = true;
    const report = summarizePilot(input, now);
    expect(report.recordChecklistSatisfied).toBe(true);
    expect(report.observations).toMatchObject({ liveParticipants: 5, liveSessions: 6, unresolvedParticipants: 0,
      sessionsWithWalletRejection: 1, sessionsNeedingHelp: 1, sessionsRecoveredAfterReload: 1,
      medianLatestCompletedSessionSeconds: 30 });
  });

  it('keeps a later failed retest open regardless of array order', () => {
    const input = fixture();
    input.observations.unshift({ ...structuredClone(input.observations[0]!), sessionId: 'S006',
      observedAt: '2026-09-14T11:00:00Z', outcome: 'blocked', blockers: ['manual_review'] });
    const report = summarizePilot(input, now);
    expect(report.observations).toMatchObject({ liveParticipants: 5, latestCompletedParticipants: 4, unresolvedParticipants: 1 });
    expect(report.missingEvidence).toEqual(expect.arrayContaining(['completion_and_resolution_evidence',
      'unresolved_participant_blockers', 'accounting_predates_observations']));
  });

  it.each(['registration', 'resolution', 'ownerAndPrimaryMatch'] as const)('requires complete recorded proof: %s', (field) => {
    const input = fixture(); input.observations[0]!.proof[field] = null;
    expect(summarizePilot(input, now).missingEvidence).toContain('completion_and_resolution_evidence');
  });
  it.each(['mismatch', 'escrow'] as const)('does not treat %s as a resolved recipient', (outcome) => {
    const input = fixture(); input.observations[0]!.proof.resolutionOutcome = outcome;
    expect(summarizePilot(input, now).missingEvidence).toContain('unresolved_participant_blockers');
  });
  it('counts an explicit ownership or primary mismatch as unresolved despite a completed label', () => {
    const input = fixture(); input.observations[0]!.proof.ownerAndPrimaryMatch = false;
    const report = summarizePilot(input, now);
    expect(report.observations.unresolvedParticipants).toBe(1);
    expect(report.missingEvidence).toEqual(expect.arrayContaining(['unresolved_participant_blockers', 'completion_and_resolution_evidence']));
  });

  it('preserves unknown observations instead of reporting them as no rejection or help', () => {
    const input = fixture();
    Object.assign(input.observations[0]!, { walletRejected: null, neededHelp: null, promptCount: null, elapsedSeconds: null, manualSteps: null });
    const report = summarizePilot(input, now);
    expect(report.missingEvidence).toContain('incomplete_session_observations');
    expect(report.observations).toMatchObject({ sessionsWithWalletRejection: 0, sessionsNeedingHelp: 0,
      sessionsWithUnknownRejection: 1, sessionsWithUnknownAssistance: 1, medianLatestCompletedSessionSeconds: 35 });
  });

  it('requires an actually recorded baseline without making a conversion claim', () => {
    const input = fixture(); input.baselines = [];
    const report = summarizePilot(input, now);
    expect(report.stepsComparison).toBeNull();
    expect(report.missingEvidence).toContain('observed_step_comparison');
  });
  it('flags participants beyond the recorded plan', () => {
    const input = fixture();
    input.observations.push({ ...structuredClone(input.observations[0]!), participantId: 'P006', sessionId: 'S006',
      proof: { registration: null, ownerAndPrimaryMatch: null, resolution: null, resolutionOutcome: 'not_checked' } });
    expect(summarizePilot(input, now).missingEvidence).toContain('observations_exceed_plan');
  });
  it.each(['heldNative', 'residualNative', 'pendingAttempts', 'manualReviewAttempts'] as const)('keeps unsettled %s open', (field) => {
    const input = fixture();
    if (field === 'heldNative' || field === 'residualNative') input.accounting![field] = '1';
    else input.accounting![field] = 1;
    expect(summarizePilot(input, now).missingEvidence).toContain('unsettled_accounting');
  });
  it.each([{ capNative: '0' }, { spentNative: '90071992547409932' }, { consistent: false }])('flags accounting discrepancy: %j', (change) => {
    const input = fixture(); Object.assign(input.accounting!, change);
    expect(summarizePilot(input, now).missingEvidence).toContain('accounting_discrepancy');
  });
  it.each([{ seconds: 59 }, { seconds: 91 }, { usesRealProduct: false }, { participantDisclosure: 'unapproved' }])('requires a live permitted demo: %j', (change) => {
    const input = fixture(); Object.assign(input.demo!, change);
    expect(summarizePilot(input, now).missingEvidence).toContain('live_demo_and_disclosure');
  });

  it.each([
    (input: PilotInput) => { input.prerequisites.nightly = 'E999'; },
    (input: PilotInput) => { input.observations[0]!.proof.registration = input.prerequisites.nightly; },
    (input: PilotInput) => { input.baselines[0]!.evidence = 'E999'; },
    (input: PilotInput) => { input.accounting!.evidence = 'E999'; },
    (input: PilotInput) => { input.demo!.evidence = 'E999'; },
  ])('rejects missing or wrong-kind evidence references', (change) => {
    const input = fixture(); change(input);
    expect(() => summarizePilot(input, now)).toThrow('invalid_reference');
  });
  it.each([
    (input: PilotInput) => { input.evidence.push(input.evidence[0]!); },
    (input: PilotInput) => { input.observations.push(input.observations[0]!); },
    (input: PilotInput) => { input.baselines.push(input.baselines[0]!); },
    (input: PilotInput) => { input.baselines[1]!.evidence = input.baselines[0]!.evidence; },
    (input: PilotInput) => {
      const [a, b] = input.baselines;
      input.evidence.find((e) => e.id === b!.evidence)!.sha256 = input.evidence.find((e) => e.id === a!.evidence)!.sha256;
    },
    (input: PilotInput) => { input.observations[0]!.blockers = ['timeout', 'timeout']; },
    (input: PilotInput) => { input.observations.push({ ...input.observations[0]!, sessionId: 'S099', observedAt: '2026-09-14T10:00:00.000Z' }); },
    (input: PilotInput) => { input.observations[1]!.proof.registration = input.observations[0]!.proof.registration; },
    (input: PilotInput) => {
      const [a, b] = input.observations;
      input.evidence.find((e) => e.id === b!.proof.registration)!.sha256 = input.evidence.find((e) => e.id === a!.proof.registration)!.sha256;
    },
  ])('rejects duplicate or reused records', (change) => {
    const input = fixture(); change(input);
    expect(() => summarizePilot(input, now)).toThrow('duplicate_record');
  });
  it.each(['evidence', 'observations', 'baselines'] as const)('rejects future timestamps in %s', (field) => {
    const input = fixture();
    if (field === 'evidence') input.evidence[0]!.recordedAt = '2026-09-15T10:00:00Z';
    else input[field][0]!.observedAt = '2026-09-15T10:00:00Z';
    expect(() => summarizePilot(input, now)).toThrow('future_observation');
  });
  it.each([NaN, -1, Infinity, 1.5, 8_640_000_000_000_001])('rejects invalid report time %s', (time) => {
    expect(() => summarizePilot(emptyPilotInput(), time)).toThrow('invalid_input');
  });
  it.each(['01', '-1', '1.5', '1e8', '1'.repeat(25)])('rejects noncanonical native amounts: %s', (amount) => {
    const input = fixture(); input.accounting!.capNative = amount;
    expect(() => summarizePilot(input, now)).toThrow('invalid_input');
  });
  it('rejects unknown sensitive fields without echoing values', () => {
    const input = { ...fixture(), secret: 'must-never-appear' };
    expect(() => summarizePilot(input, now)).toThrow('Pilot report unavailable: invalid_input');
    Object.assign(input.observations[0]!, { wallet: 'must-never-appear' });
    delete (input as Partial<typeof input>).secret;
    expect(() => summarizePilot(input, now)).toThrow('Pilot report unavailable: invalid_input');
  });
});

describe('private pilot report CLI', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'first-bite-pilot-')));
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function save(input: unknown = emptyPilotInput()) {
    const path = join(directory, 'input.json');
    await writeFile(path, JSON.stringify(input), { mode: 0o600 }); return path;
  }
  it('writes only aggregate fields to a new private file and never overwrites it', async () => {
    const path = await save();
    const result = await runPilotReport(['--input', path, '--out', 'report.json']);
    expect(result).toMatchObject({ recordChecklistSatisfied: false, liveParticipants: 0 });
    expect((await stat(result.outputFile)).mode & 0o777).toBe(0o600);
    const original = await readFile(result.outputFile, 'utf8');
    expect(JSON.parse(original).phase7Complete).toBe(false);
    await expect(runPilotReport(['--input', path, '--out', 'report.json'])).rejects.toThrow();
    expect(await readFile(result.outputFile, 'utf8')).toBe(original);
  });
  it('accepts equals-style options too', async () => {
    const path = await save();
    expect((await runPilotReport([`--input=${path}`, '--out=report.json'])).liveParticipants).toBe(0);
  });
  it.each([[], ['--input', 'input.json'], ['--input', 'x', '--out', 'x', '--out', 'y'],
    ['--input', 'x', '--out', 'x', '--send'], ['x', '--out', 'y']].map((args) => ({ args })))('rejects malformed options without writes: $args', async ({ args }) => {
    await expect(runPilotReport(args)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects invalid input before creating an output directory', async () => {
    const path = await save({ secret: 'private-value' });
    await expect(runPilotReport(['--input', path, '--out', 'report.json'])).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(directory)).toEqual(['input.json']);
  });
  it('rejects traversal at the output boundary', async () => {
    const path = await save();
    await expect(runPilotReport(['--input', path, '--out', '../outside.json'])).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readdir(directory)).toEqual(['input.json']);
  });
  it('reads an input at the byte limit and rejects an oversized file', async () => {
    const path = join(directory, 'input.json');
    await writeFile(path, ' '.repeat(MAX_PILOT_INPUT_BYTES - 2) + '{}');
    expect(await readPilotInput(path)).toEqual({});
    await writeFile(path, ' '.repeat(MAX_PILOT_INPUT_BYTES - 1) + '{}');
    await expect(readPilotInput(path)).rejects.toMatchObject({ code: 'invalid_file' });
  });
  it.each([Buffer.from('{"secret":"hidden"'), Buffer.from([0x22, 0xff, 0x22])])('rejects malformed JSON/UTF-8 with a sanitized error', async (bytes) => {
    const path = join(directory, 'invalid.json'); await writeFile(path, bytes);
    await expect(readPilotInput(path)).rejects.toMatchObject({ code: 'invalid_file', message: 'Pilot report unavailable: invalid_file' });
  });
  it('rejects a symlink, directory and unavailable file without reading their contents', async () => {
    const path = await save(); const link = join(directory, 'link.json'); await symlink(path, link);
    await expect(readPilotInput(link)).rejects.toMatchObject({ code: 'file_unavailable' });
    await expect(readPilotInput(directory)).rejects.toMatchObject({ code: 'invalid_file' });
    await expect(readPilotInput(join(directory, 'absent.json'))).rejects.toMatchObject({ code: 'file_unavailable' });
  });
  it('distinguishes incomplete, invalid and satisfied records at the actual CLI boundary', async () => {
    const path = await save();
    const run = (name: string) => spawnSync(process.execPath, ['--import', tsx, cli, '--input', path, '--out', name],
      { cwd: directory, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' } });
    const incomplete = run('incomplete.json');
    expect(incomplete.status).toBe(2);
    expect(JSON.parse(incomplete.stdout)).toMatchObject({ ok: true, liveParticipants: 0, recordChecklistSatisfied: false });
    expect(incomplete.stderr).toBe('');
    await save({ secret: 'never-print-this' });
    const invalid = run('invalid.json');
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(JSON.parse(invalid.stderr)).toEqual({ ok: false, code: 'invalid_input' });
    const synthetic = fixture();
    for (const e of synthetic.evidence) e.recordedAt = '2020-01-01T00:00:00Z';
    for (const o of synthetic.observations) o.observedAt = '2020-01-01T00:00:00Z';
    for (const b of synthetic.baselines) b.observedAt = '2020-01-01T00:00:00Z';
    await save(synthetic);
    const satisfied = run('satisfied.json');
    expect(satisfied.status).toBe(0);
    expect(JSON.parse(satisfied.stdout)).toMatchObject({ ok: true, recordChecklistSatisfied: true, liveParticipants: 5 });
    expect(JSON.parse(await readFile(join(directory, 'artifacts/private/satisfied.json'), 'utf8')).phase7Complete).toBe(false);
  });
});
