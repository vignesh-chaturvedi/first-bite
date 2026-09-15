import { createHash } from 'node:crypto';
import { Keypair, Message, PublicKey, VersionedTransaction, type SimulateTransactionConfig } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryClient, RegistryInput, RegistryObservation } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { prepareSmokePlan, prepareSmokeWorksheet, type SmokeWorksheetInput } from '../src/lib/operations/smoke-worksheet';
import { createSponsorProbeSimulationConnection, prepareSponsorProbe, type SponsorProbeSimulationConnection } from '../src/lib/operations/sponsor-probe';

const epoch = Date.parse('2026-09-15T00:00:00Z');
const key = (seed: number) => Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
function fixture() {
  const input: SmokeWorksheetInput = { name: ' FirstBite.cook ', sponsor: key(1).toBase58(), user: key(2).toBase58(),
    limits: { maxRegistrationPrice: '15000000000000', maxTransactionFee: '15000', recoveryAllowance: '15000', maxTotalSpend: '15000003384720' } };
  const observation: { -readonly [K in keyof RegistryObservation]: RegistryObservation[K] } = {
    label: 'firstbite', sponsor: key(1), user: key(2), attemptPayer: key(3), feeReceiver: new PublicKey(policy.feeReceiverAddress),
    registrationPrice: 15_000_000_000_000n, domainRent: policy.domainRent, primaryRent: policy.primaryRent,
    sponsorBalance: 15_000_003_384_720n, userBalance: 0n, blockhash: key(4).toBase58(), lastValidBlockHeight: 500,
    observedSlot: 100, blockhashContextSlot: 101, observedAtMs: epoch, genesisHash: policy.genesisHash,
    configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id,
  };
  const client = {
    observe: vi.fn(async (actors: RegistryInput) => { Object.assign(observation, actors); return observation; }),
    getMessageFee: vi.fn(async (_message: Message, _minSlot: number) => 15_000n),
  } satisfies RegistryClient;
  const response = { context: { slot: 102 }, value: { err: null as unknown, unitsConsumed: 40_000,
    logs: ['secret-rpc-details'], returnData: { data: ['never-export-this', 'base64'] } } };
  const connection = {
    getGenesisHash: vi.fn(async () => policy.genesisHash),
    getBlockHeight: vi.fn(async (_config?: unknown) => 490),
    simulateTransaction: vi.fn(async (_tx: VersionedTransaction, _config?: SimulateTransactionConfig) => response),
  };
  const port = connection as unknown as SponsorProbeSimulationConnection;
  const prepare = (now = () => epoch) => prepareSponsorProbe(input, client, port, now);
  return { input, observation, client, response, connection, port, prepare };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sponsor-backed signature preparation', () => {
  it('simulates the exact captured three-signer bytes and returns only a short-lived unsigned candidate', async () => {
    const { prepare, client, connection } = fixture();
    const { report, candidate } = await prepare();
    expect(report).toMatchObject({ purpose: 'sponsor_backed_signature_diagnostic', outcome: 'ready', signatureRequestReady: true,
      spendAuthorized: false, signingEnabled: false, broadcastEnabled: false, phase0GateComplete: false,
      attemptKeyRetained: false, planningChecksSatisfied: true, blockers: [],
      observation: { recipientBalanceNative: '0', genesisHash: policy.genesisHash, programSha256: policy.programSha256, configSha256: policy.configSha256 },
      simulation: { status: 'passed', error: null, contextSlot: 102, unitsConsumed: 40_000, blockHeightBefore: 490, blockHeightAfter: 490 } });
    expect(candidate).not.toBeNull();
    expect(candidate!.expiresAtMs).toBe(epoch + 120_000);
    expect(candidate!.lastValidBlockHeight).toBe(500);
    expect(candidate!.label).toBe('firstbite');
    expect(candidate!.sponsor.toBase58()).toBe(report.sponsor);
    expect(candidate!.user.toBase58()).toBe(report.user);
    expect(candidate!.attemptPayer.toBase58()).toBe(report.diagnosticAttemptPayer);
    expect(candidate!.transaction.signatures).toHaveLength(3);
    expect(candidate!.transaction.signatures.every(({ signature }) => signature === null)).toBe(true);
    const bytes = unsignedBytes(candidate!.transaction);
    const [simulated, config] = connection.simulateTransaction.mock.calls[0]!;
    expect(Buffer.from(simulated.serialize())).toEqual(bytes);
    expect(config).toEqual({ commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: 101 });
    expect(candidate!.transaction.serializeMessage()).toEqual(client.getMessageFee.mock.calls[0]![0].serialize());
    expect(report.transaction.messageSha256).toBe(createHash('sha256').update(candidate!.transaction.serializeMessage()).digest('hex'));
    expect(report.transaction.bytes).toBe(bytes.length);
    expect(connection.getBlockHeight.mock.calls).toEqual([[{ commitment: 'finalized', minContextSlot: 101 }], [{ commitment: 'finalized', minContextSlot: 102 }]]);
    expect(connection.getGenesisHash.mock.invocationCallOrder[0]).toBeLessThan(connection.simulateTransaction.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(report)).not.toMatch(/secretKey|privateKey|unsignedTransaction|transactionBase64|messageBase64|secret-rpc-details|never-export-this/);
  });

  it('generates a distinct fresh A on each preparation without retaining key material', async () => {
    const { prepare } = fixture(); const first = await prepare(); const second = await prepare();
    expect(first.report.diagnosticAttemptPayer).not.toBe(second.report.diagnosticAttemptPayer);
    expect([first.report.sponsor, first.report.user]).not.toContain(first.report.diagnosticAttemptPayer);
    expect(Object.keys(first.candidate!).sort()).toEqual(['attemptPayer', 'expiresAtMs', 'label', 'lastValidBlockHeight', 'report', 'sponsor', 'transaction', 'user']);
  });

  it.each([
    ['registration_price_exceeds_limit', (f: ReturnType<typeof fixture>) => { f.input.limits.maxRegistrationPrice = '1'; }],
    ['transaction_fee_exceeds_limit', (f: ReturnType<typeof fixture>) => { f.input.limits.maxTransactionFee = '1'; }],
    ['total_exceeds_limit', (f: ReturnType<typeof fixture>) => { f.input.limits.maxTotalSpend = '1'; }],
    ['sponsor_funding_shortfall', (f: ReturnType<typeof fixture>) => { f.observation.sponsorBalance = 0n; }],
    ['recipient_not_zero_cook', (f: ReturnType<typeof fixture>) => { f.observation.userBalance = 1n; }],
  ] as const)('skips the entire simulation port for %s', async (code, change) => {
    const f = fixture(); change(f); const result = await f.prepare();
    expect(result.candidate).toBeNull();
    expect(result.report).toMatchObject({ outcome: 'blocked', signatureRequestReady: false, planningChecksSatisfied: false,
      simulation: { status: 'not_run', error: null } });
    expect(result.report.blockers).toContain(code);
    for (const method of Object.values(f.connection)) expect(method).not.toHaveBeenCalled();
  });

  it('rejects arbitrary fields and policy drift before invoking simulation', async () => {
    const f = fixture();
    await expect(prepareSponsorProbe({ ...f.input, instructions: ['arbitrary'] }, f.client, f.port, () => epoch)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.client.observe).not.toHaveBeenCalled();
    f.observation.programSha256 = 'unreviewed';
    await expect(f.prepare()).rejects.toMatchObject({ code: 'invalid_observation' });
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled();
  });

  it('does not accept a different simulation chain even when the quote is valid', async () => {
    const f = fixture(); f.connection.getGenesisHash.mockResolvedValue(key(8).toBase58());
    const result = await f.prepare();
    expect(result.candidate).toBeNull(); expect(result.report.blockers).toEqual(['wrong_chain']);
    expect(f.connection.getBlockHeight).not.toHaveBeenCalled(); expect(f.connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['AccountNotFound', 'AccountNotFound'], ['BlockhashNotFound', 'BlockhashNotFound'],
    ['InsufficientFundsForFee', 'transaction_failed'], [{ InstructionError: [2, { Custom: 6000 }] }, 'transaction_failed'],
    [{ secret: 'never-export-me' }, 'transaction_failed'], [undefined, 'invalid_simulation'], [99, 'invalid_simulation'],
    [[], 'invalid_simulation'], [{}, 'invalid_simulation'],
  ])('returns a bounded failure classification for simulation error %#', async (err, expected) => {
    const f = fixture(); f.response.value.err = err;
    const result = await f.prepare();
    expect(result.candidate).toBeNull();
    expect(result.report).toMatchObject({ outcome: 'blocked', signatureRequestReady: false,
      simulation: { status: 'failed', error: expected } });
    expect(JSON.stringify(result.report)).not.toContain('never-export');
  });

  it.each([NaN, -1, Number.MAX_SAFE_INTEGER + 1, 100])('rejects unsafe or stale simulation context %s', async (slot) => {
    const f = fixture(); f.response.context.slot = slot;
    const result = await f.prepare();
    expect(result.candidate).toBeNull();
    expect(result.report.simulation.error).toBe(slot === 100 ? 'stale_context' : 'invalid_simulation');
  });

  it.each([-1, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe simulation units %s', async (units) => {
    const f = fixture(); f.response.value.unitsConsumed = units;
    const result = await f.prepare();
    expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe('invalid_simulation');
  });

  it('rejects a malformed successful response without exposing its content', async () => {
    const f = fixture(); f.connection.simulateTransaction.mockResolvedValue(null as unknown as typeof f.response);
    const result = await f.prepare(); expect(result.candidate).toBeNull();
    expect(result.report.simulation.error).toBe('invalid_simulation');
  });

  it.each([
    [[501, 501], 'blockhash_expired', 0], [[500, 501], 'blockhash_expired', 1],
    [[490, 489], 'invalid_simulation', 1], [[NaN, 490], 'invalid_simulation', 0],
    [[490, -1], 'invalid_simulation', 1],
  ] as const)('checks blockheight before and after simulation %#', async (heights, expected, simulated) => {
    const f = fixture(); f.connection.getBlockHeight.mockResolvedValueOnce(heights[0]).mockResolvedValueOnce(heights[1]);
    const result = await f.prepare();
    expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe(expected);
    expect(f.connection.simulateTransaction).toHaveBeenCalledTimes(simulated);
  });

  it('allows the last valid blockheight while fresh', async () => {
    const f = fixture(); f.connection.getBlockHeight.mockResolvedValue(500);
    expect((await f.prepare()).report.signatureRequestReady).toBe(true);
  });

  it.each(['getGenesisHash', 'getBlockHeight', 'simulateTransaction'] as const)('redacts %s exceptions', async (method) => {
    const f = fixture(); f.connection[method].mockRejectedValue(new Error('https://private-rpc/?key=never-export'));
    const result = await f.prepare();
    expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe('rpc_failed');
    expect(JSON.stringify(result.report)).not.toMatch(/private-rpc|never-export/);
  });

  it('turns aborted simulation into a fixed timeout code', async () => {
    const f = fixture(); f.connection.simulateTransaction.mockRejectedValue(new DOMException('secret', 'AbortError'));
    expect((await f.prepare()).report.simulation.error).toBe('rpc_timeout');
  });

  it('bounds an unresolved simulation to four seconds', async () => {
    vi.useFakeTimers(); const f = fixture(); f.connection.simulateTransaction.mockImplementation(() => new Promise(() => {}));
    const pending = f.prepare(); await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending; expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe('rpc_timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds a hung registry adapter and keeps its errors sanitized', async () => {
    vi.useFakeTimers(); const f = fixture(); f.client.observe.mockImplementation(() => new Promise(() => {}));
    const caught = f.prepare().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await caught).toMatchObject({ code: 'chain_unavailable', message: 'Smoke worksheet unavailable: chain_unavailable' });
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['getGenesisHash', 'getBlockHeight', 'simulateTransaction'] as const)('rejects expired total preparation after %s', async (method) => {
    const f = fixture(); let elapsed = epoch;
    const original = f.connection[method].getMockImplementation()!;
    f.connection[method].mockImplementation(async (...args: unknown[]) => {
      elapsed = epoch + 30_000;
      return (original as (...values: unknown[]) => Promise<never>)(...args);
    });
    const result = await f.prepare(() => elapsed);
    expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe('observation_expired');
  });

  it('rejects a backward clock after otherwise successful simulation', async () => {
    const f = fixture(); let clock = epoch;
    f.connection.simulateTransaction.mockImplementation(async () => { clock = epoch - 1; return f.response; });
    const result = await f.prepare(() => clock);
    expect(result.candidate).toBeNull(); expect(result.report.simulation.error).toBe('observation_expired');
  });

  it('keeps captured bytes despite a fee adapter mutating its message and observations', async () => {
    const f = fixture(); let captured = Buffer.alloc(0);
    f.client.getMessageFee.mockImplementation(async (message) => {
      captured = Buffer.from(message.serialize()); message.accountKeys[0] = key(9);
      f.observation.user = key(9); f.observation.sponsorBalance = 0n; f.observation.programSha256 = 'changed';
      return 15_000n;
    });
    const result = await f.prepare();
    expect(result.candidate!.transaction.serializeMessage()).toEqual(captured);
    expect(result.report.observation.programSha256).toBe(policy.programSha256);
    expect(result.report.user).toBe(key(2).toBase58());
  });

  it('rejects a simulator that mutates the transaction it was asked to simulate', async () => {
    const f = fixture(); f.connection.simulateTransaction.mockImplementation(async (tx) => {
      tx.message.recentBlockhash = key(8).toBase58(); return f.response;
    });
    const result = await f.prepare(); expect(result.candidate).toBeNull();
    expect(result.report.simulation.error).toBe('invalid_simulation');
  });

  it('captures simulation result scalars before the post-simulation height await', async () => {
    const f = fixture(); f.connection.getBlockHeight.mockResolvedValueOnce(490).mockImplementationOnce(async () => {
      f.response.context.slot = 1; f.response.value.err = 'AccountNotFound'; f.response.value.unitsConsumed = -1;
      return 490;
    });
    const result = await f.prepare();
    expect(result.report.simulation).toMatchObject({ status: 'passed', contextSlot: 102, unitsConsumed: 40_000 });
  });

  it('keeps the worksheet public API unchanged after extracting the internal plan', async () => {
    const f = fixture();
    const worksheet = await prepareSmokeWorksheet(f.input, f.client, key(3), () => epoch);
    const plan = await prepareSmokePlan(f.input, f.client, key(3), () => epoch);
    expect(plan.report).toEqual(worksheet); expect(worksheet.purpose).toBe('read_only_smoke_planning');
    expect(plan.transaction.signatures.every(({ signature }) => signature === null)).toBe(true);
    expect(plan.report).not.toHaveProperty('candidate');
  });
});

describe('simulation connection transport', () => {
  it('exposes only the three read-only methods and propagates finalized context without replacement', async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string); requests.push(request);
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const result = request.method === 'getGenesisHash' ? policy.genesisHash
        : request.method === 'getBlockHeight' ? 490 : { context: { slot: 102 }, value: { err: null, logs: [], unitsConsumed: 40_000 } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const connection = createSponsorProbeSimulationConnection('https://example.invalid');
    expect(Object.keys(connection).sort()).toEqual(['getBlockHeight', 'getGenesisHash', 'simulateTransaction']);
    const f = fixture(); const result = await prepareSponsorProbe(f.input, f.client, connection, () => epoch);
    expect(result.report.signatureRequestReady).toBe(true);
    expect(requests.map(({ method }) => method)).toEqual(['getGenesisHash', 'getBlockHeight', 'simulateTransaction', 'getBlockHeight']);
    const config = requests[2]!.params[1];
    expect(config).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, commitment: 'finalized', minContextSlot: 101, encoding: 'base64' });
  });

  it('redacts invalid endpoint errors', () => {
    expect(() => createSponsorProbeSimulationConnection('secret-endpoint')).toThrow('Sponsor probe unavailable: rpc_failed');
  });
});
