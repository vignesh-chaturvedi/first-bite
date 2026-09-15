import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Keypair, Message, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegistryClient, type RegistryObservation } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { buildSponsoredTransaction, unsignedBytes, U64_MAX } from '../src/lib/cookie/transaction';
import { domainPda, primaryPda } from '../src/lib/cookie/registry';
import { prepareSponsoredQuote } from '../src/lib/transactions/quote';
import { prepareSmokeWorksheet, type SmokeWorksheetInput } from '../src/lib/operations/smoke-worksheet';
import { runSmokeWorksheet } from '../scripts/phase0/smoke-worksheet';

const epoch = Date.parse('2026-09-15T00:00:00Z');
const key = (seed: number) => Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
function fixture() {
  const input: SmokeWorksheetInput = { name: ' FirstBite.cook ', sponsor: key(1).toBase58(), user: key(2).toBase58(),
    limits: { maxRegistrationPrice: '15000000000000', maxTransactionFee: '15000', recoveryAllowance: '15000', maxTotalSpend: '15000003384720' } };
  const observed: { -readonly [K in keyof RegistryObservation]: RegistryObservation[K] } = {
    label: 'firstbite', sponsor: key(1), user: key(2), attemptPayer: key(3), feeReceiver: new PublicKey(policy.feeReceiverAddress),
    registrationPrice: 15_000_000_000_000n, domainRent: policy.domainRent, primaryRent: policy.primaryRent,
    sponsorBalance: 0n, userBalance: 0n, blockhash: key(4).toBase58(), lastValidBlockHeight: 500,
    observedSlot: 100, blockhashContextSlot: 101, observedAtMs: epoch, genesisHash: policy.genesisHash,
    configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id,
  };
  const client = { observe: vi.fn(async () => observed),
    getMessageFee: vi.fn(async (_message: Message, _minSlot: number) => 15_000n) } satisfies RegistryClient;
  const prepare = (now = () => epoch) => prepareSmokeWorksheet(input, client, key(3), now);
  return { input, observed, client, prepare };
}

describe('read-only smoke worksheet', () => {
  it('shows exact funding shortfall and zero-COOK state without exporting a signable payload', async () => {
    const { input, observed, client, prepare } = fixture();
    const report = await prepare();
    expect(report).toMatchObject({ planningChecksSatisfied: false, blockers: ['sponsor_funding_shortfall'],
      name: 'firstbite.cook', spendAuthorized: false, signingEnabled: false, broadcastEnabled: false,
      phase0GateComplete: false, refreshRequired: true, attemptKeyRetained: false });
    expect(report.observation).toMatchObject({ slot: 100, blockhashContextSlot: 101,
      recipientBalanceNative: '0', sponsorBalanceNative: '0' });
    expect(report.costs).toEqual({ registrationPriceNative: '15000000000000', domainRentNative: '1927920',
      primaryRentNative: '1426800', transactionFeeNative: '15000', recoveryAllowanceNative: '15000',
      estimatedExecutionDebitNative: '15000003369720', estimatedReservationNative: '15000003384720',
      sponsorFundingShortfallNative: '15000003384720' });
    expect(report.expected).toEqual({ domain: domainPda('firstbite').toBase58(), owner: input.user, primary: primaryPda(key(2)).toBase58() });
    const tx = buildSponsoredTransaction(observed);
    expect(report.transaction).toEqual({ messageSha256: createHash('sha256').update(tx.serializeMessage()).digest('hex'),
      bytes: unsignedBytes(tx).length, requiredSigners: tx.signatures.map(({ publicKey }) => publicKey.toBase58()) });
    expect(client.getMessageFee).toHaveBeenCalledOnce();
    expect(client.getMessageFee.mock.calls[0]![1]).toBe(101);
    expect(client.getMessageFee.mock.calls[0]![0].serialize()).toEqual(tx.serializeMessage());
    expect(JSON.stringify(report)).not.toMatch(/secretKey|privateKey|messageBase64|unsignedTransactionBase64|transactionBase64/);
  });

  it('keeps signing and phase gates closed even when planning checks pass', async () => {
    const { observed, prepare } = fixture(); observed.sponsorBalance = 15_000_003_384_720n;
    const report = await prepare();
    expect(report).toMatchObject({ planningChecksSatisfied: true, blockers: [], spendAuthorized: false,
      signingEnabled: false, broadcastEnabled: false, phase0GateComplete: false, refreshRequired: true });
    expect(report.costs.sponsorFundingShortfallNative).toBe('0');
  });

  it('reports all independent blockers without increasing any supplied limits', async () => {
    const { input, observed, prepare } = fixture();
    input.limits = { maxRegistrationPrice: '1', maxTransactionFee: '1', recoveryAllowance: '15000', maxTotalSpend: '1' };
    observed.userBalance = 1n;
    const before = structuredClone(input);
    const report = await prepare();
    expect(report.blockers).toEqual(['registration_price_exceeds_limit', 'transaction_fee_exceeds_limit',
      'total_exceeds_limit', 'sponsor_funding_shortfall', 'recipient_not_zero_cook']);
    expect(report.limits).toEqual(before.limits);
    expect(input).toEqual(before);
  });

  it('retains exact large costs and omits primary rent for an eligible existing primary', async () => {
    const { input, observed, prepare } = fixture();
    observed.primaryRent = 0n; observed.registrationPrice = 9_007_199_254_740_993n;
    observed.sponsorBalance = 9_007_199_256_698_912n;
    input.limits.maxRegistrationPrice = U64_MAX.toString(); input.limits.maxTotalSpend = U64_MAX.toString();
    const report = await prepare();
    expect(report.costs.primaryRentNative).toBe('0');
    expect(report.costs.estimatedReservationNative).toBe('9007199256698913');
    expect(report.costs.sponsorFundingShortfallNative).toBe('1');
  });

  it('does not weaken the existing funded quote balance requirement', async () => {
    const { input, observed, client, prepare } = fixture();
    expect((await prepare()).blockers).toContain('sponsor_funding_shortfall');
    await expect(prepareSponsoredQuote({ name: input.name, sponsor: observed.sponsor,
      user: observed.user, attemptPayer: observed.attemptPayer }, client, {
      maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: 15_000n, recoveryAllowance: 15_000n,
      maxReservation: 15_000_003_384_720n, ttlMs: 30_000,
    }, () => epoch)).rejects.toMatchObject({ code: 'insufficient_sponsor_balance' });
  });

  it.each(['0', '-1', '01', '1.5', '1e6', '18446744073709551616', '9'.repeat(100)])('rejects invalid cap %s before RPC', async (value) => {
    const { input, client, prepare } = fixture(); input.limits.maxTotalSpend = value;
    await expect(prepare()).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.observe).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'abc' }, { sponsor: 'secret-must-not-echo' }, { user: PublicKey.default.toBase58() },
    { user: key(1).toBase58() }, { user: domainPda('firstbite').toBase58() }, { secret: 'never-log-this' },
  ])('rejects malformed inputs before RPC: %j', async (change) => {
    const { input, client } = fixture();
    await expect(prepareSmokeWorksheet({ ...input, ...change }, client, key(3), () => epoch)).rejects.toMatchObject({ code: 'invalid_input', message: 'Smoke worksheet unavailable: invalid_input' });
    expect(client.observe).not.toHaveBeenCalled();
  });
  it.each([key(1), key(2), PublicKey.default, domainPda('firstbite')])('rejects a colliding or nonsigning A identity', async (attempt) => {
    const { input, client } = fixture();
    await expect(prepareSmokeWorksheet(input, client, attempt, () => epoch)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.observe).not.toHaveBeenCalled();
  });

  it.each([
    { userBalance: -1n }, { userBalance: undefined }, { sponsorBalance: 1 as unknown as bigint },
    { registrationPrice: 0n }, { registrationPrice: U64_MAX }, { domainRent: 1n }, { primaryRent: 1n },
    { user: key(8) }, { attemptPayer: key(8) }, { label: 'another' }, { feeReceiver: key(8) },
    { policyId: 'unreviewed' }, { programSha256: 'a'.repeat(64) }, { configSha256: 'a'.repeat(64) },
    { genesisHash: key(8).toBase58() }, { observedSlot: Number.MAX_SAFE_INTEGER + 1 },
    { blockhashContextSlot: 99 }, { observedAtMs: epoch - 1 }, { observedAtMs: epoch + 1 },
    { blockhash: '' }, { lastValidBlockHeight: -1 },
  ])('rejects mismatched or unsafe observation case %#', async (change) => {
    const { observed, client, prepare } = fixture(); Object.assign(observed, change);
    await expect(prepare()).rejects.toMatchObject({ code: 'invalid_observation' });
    expect(client.getMessageFee).not.toHaveBeenCalled();
  });
  it.each([0n, -1n, U64_MAX + 1n, 1 as unknown as bigint])('rejects an unsafe exact fee %s', async (fee) => {
    const { client, prepare } = fixture(); client.getMessageFee.mockResolvedValue(fee);
    await expect(prepare()).rejects.toMatchObject({ code: 'invalid_observation' });
  });
  it.each(['observe', 'getMessageFee'] as const)('sanitizes %s failures without propagating causes', async (method) => {
    const { client, prepare } = fixture(); client[method].mockRejectedValue(new Error('private-endpoint-and-key'));
    const error = await prepare().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'chain_unavailable', message: 'Smoke worksheet unavailable: chain_unavailable' });
    expect(error).not.toHaveProperty('cause');
  });
  it('rejects slow preparation, backward clocks and invalid timestamps', async () => {
    for (const [times, code] of [
      [[epoch, epoch, epoch + 30_000], 'observation_expired'], [[epoch, epoch, epoch - 1], 'observation_expired'],
      [[epoch, NaN, epoch], 'invalid_observation'], [[NaN], 'invalid_input'],
    ] as const) {
      const { prepare } = fixture(); let index = 0;
      await expect(prepare(() => times[index++] ?? epoch)).rejects.toMatchObject({ code });
    }
  });

  it('captures caller identities/limits and returned observations before later awaits', async () => {
    const { input, observed, client } = fixture();
    let finish!: (value: RegistryObservation) => void;
    client.observe.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = prepareSmokeWorksheet(input, client, key(3), () => epoch);
    input.user = key(8).toBase58(); input.limits.maxTotalSpend = '1';
    client.getMessageFee.mockImplementation(async (message) => {
      message.accountKeys[0] = key(9);
      observed.userBalance = 99n; observed.sponsorBalance = U64_MAX;
      observed.programSha256 = 'changed'; observed.user = key(9); return 15_000n;
    });
    finish(observed);
    const report = await pending;
    expect(report.user).toBe(key(2).toBase58());
    expect(report.limits.maxTotalSpend).toBe('15000003384720');
    expect(report.observation).toMatchObject({ recipientBalanceNative: '0', sponsorBalanceNative: '0', programSha256: policy.programSha256 });
    expect(report.blockers).toEqual(['sponsor_funding_shortfall']);
  });
});

describe('private smoke worksheet command', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'first-bite-worksheet-')));
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  const args = () => ['--name', 'firstbite', '--sponsor', key(1).toBase58(), '--user', key(2).toBase58(),
    '--max-price', '15000000000000', '--max-fee', '15000', '--recovery', '15000', '--max-total', '15000003384720', '--out', 'worksheet.json'];
  function client(): RegistryClient {
    const { observed } = fixture();
    return { observe: async (input) => ({ ...observed, ...input, observedAtMs: Date.now() }), getMessageFee: async () => 15_000n };
  }
  it('creates a private blocked report with generated diagnostic A and a minimal console result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runSmokeWorksheet(args(), client());
    expect(result).toEqual({ outputFile: join(directory, 'artifacts/private/worksheet.json'), planningChecksSatisfied: false,
      blockerCount: 1, spendAuthorized: false, broadcastEnabled: false });
    expect((await stat(result.outputFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'artifacts/private'))).mode & 0o777).toBe(0o700);
    const report = JSON.parse(await readFile(result.outputFile, 'utf8'));
    expect(report.diagnosticAttemptPayer).not.toBe(key(3).toBase58());
    expect(report.attemptKeyRetained).toBe(false);
    expect(report.blockers).toEqual(['sponsor_funding_shortfall']);
    expect(log).not.toHaveBeenCalled();
    await expect(runSmokeWorksheet(args(), client())).rejects.toMatchObject({ code: 'output_failed' });
    expect(JSON.parse(await readFile(result.outputFile, 'utf8'))).toEqual(report);
  });
  it.each([
    { edit: (values: string[]) => values.slice(0, -2) },
    { edit: (values: string[]) => [...values, '--out', 'another.json'] },
    { edit: (values: string[]) => [...values, '--send'] },
    { edit: (values: string[]) => [...values.slice(0, -1), '../outside.json'] },
    { edit: (values: string[]) => [...values, 'extra'] },
  ])('rejects unsafe CLI arguments without reading the chain or writing files', async ({ edit }) => {
    const read = vi.fn(client().observe);
    await expect(runSmokeWorksheet(edit(args()), { ...client(), observe: read })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(read).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });
  it('uses no defaults or raw exception messages at the actual command boundary', () => {
    const cli = fileURLToPath(new URL('../scripts/phase0/smoke-worksheet.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', tsx, cli, '--secret=never-print-this'],
      { cwd: directory, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, code: 'invalid_input' });
  });
});
