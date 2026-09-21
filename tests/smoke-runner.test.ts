import { Keypair, PublicKey, Transaction, type SimulatedTransactionResponse } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryClient, RegistryInput, RegistryObservation } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { ExecutionError, type ExecutionChain, type ExecutionObservation } from '../src/lib/execution/types';
import type { SmokeWorksheetInput } from '../src/lib/operations/smoke-worksheet';
import type { SponsorProbeSimulationConnection } from '../src/lib/operations/sponsor-probe';
import type { SmokeJournal } from '../src/lib/smoke/journal';
import { createSmokeRunner, type SmokeRunnerState } from '../src/lib/smoke/runner';

const epoch = 1_800_000_000_000;
const price = 15_000_000_000_000n;
const fee = 15_000n;
const key = (seed: number) => Keypair.fromSeed(Buffer.alloc(32, seed));
function fixture(allowLive = true) {
  const sponsor = key(1), user = key(2);
  const input: SmokeWorksheetInput = { name: ' FirstBite.cook ', sponsor: sponsor.publicKey.toBase58(), user: user.publicKey.toBase58(),
    limits: { maxRegistrationPrice: price.toString(), maxTransactionFee: '100000', recoveryAllowance: '100000', maxTotalSpend: '15001000000000' } };
  const time = { now: epoch };
  const disk: { value: SmokeRunnerState | null; failAt: string | null; events: string[] } = { value: null, failAt: null, events: [] };
  const journal = { read: vi.fn(async () => structuredClone(disk.value)),
    write: vi.fn(async (value: SmokeRunnerState) => {
      disk.events.push(value.status);
      if (disk.failAt === value.status) throw new Error('secret disk error');
      disk.value = structuredClone(value);
    }), close: vi.fn(async () => {}) } satisfies SmokeJournal<SmokeRunnerState>;
  const observation: { -readonly [K in keyof RegistryObservation]: RegistryObservation[K] } = {
    label: 'firstbite', sponsor: sponsor.publicKey, user: user.publicKey, attemptPayer: key(3).publicKey,
    feeReceiver: new PublicKey(policy.feeReceiverAddress), registrationPrice: price, domainRent: policy.domainRent, primaryRent: policy.primaryRent,
    sponsorBalance: 16_000_000_000_000n, userBalance: 0n, blockhash: key(4).publicKey.toBase58(), lastValidBlockHeight: 500,
    observedSlot: 100, blockhashContextSlot: 100, observedAtMs: epoch, genesisHash: policy.genesisHash,
    configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id,
  };
  const registry = { observe: vi.fn(async (actors: RegistryInput) => {
    Object.assign(observation, actors, { observedAtMs: time.now }); return observation;
  }), getMessageFee: vi.fn(async () => fee) } satisfies RegistryClient;
  const simulationResponse: { context: { slot: number }; value: SimulatedTransactionResponse } = {
    context: { slot: 100 }, value: { err: null, unitsConsumed: 31_747, logs: null },
  };
  const simulation = { getGenesisHash: vi.fn(async () => policy.genesisHash), getBlockHeight: vi.fn(async () => 490),
    simulateTransaction: vi.fn(async () => simulationResponse) } satisfies SponsorProbeSimulationConnection;
  const chain = { preflight: vi.fn(async () => ({ checkedAtMs: time.now, slot: 100, blockHeight: 490, fee,
    sponsorBalance: observation.sponsorBalance })),
    broadcast: vi.fn(async (signed: string) => {
      expect(disk.value?.status).toBe('broadcasting');
      expect(disk.value?.signedBase64).toBe(signed);
      expect(Transaction.from(Buffer.from(signed, 'base64')).verifySignatures(true)).toBe(true);
      disk.events.push('broadcast'); return disk.value!.transactionSignature!;
    }),
    observe: vi.fn(async (): Promise<ExecutionObservation> => ({ finalizedBlockHeight: 491, status: 'missing', receipt: null,
      accountSlot: 100, payerBalance: 0n, domainOwner: null, primaryOwner: null, primaryName: null })),
    prepareRecovery: vi.fn(async () => { throw new Error('Recovery is deliberately unavailable'); }),
  } satisfies ExecutionChain;
  const create = () => createSmokeRunner({ journal, registry, simulation, chain, now: () => time.now, allowLive });
  const initialize = async () => { const runner = await create(); await runner.initialize(input); return runner; };
  const prepared = async () => { const runner = await initialize(); await runner.prepare(); return runner; };
  const signed = async () => {
    const runner = await prepared();
    for (const role of ['user', 'sponsor'] as const) {
      const request = await runner.walletRequest(role);
      const tx = Transaction.from(Buffer.from(request.transactionBase64, 'base64'));
      expect(tx.signatures.every((entry) => entry.signature === null)).toBe(true);
      tx.partialSign(role === 'user' ? user : sponsor);
      await runner.acceptSignature(role, request.id, unsignedBytes(tx).toString('base64'));
    }
    return runner;
  };
  const ack = () => ({ messageSha256: disk.value!.candidate!.quote.messageSha256, maxTotalSpend: input.limits.maxTotalSpend, confirmSpend: true });
  const finalized = (failed = false, residual = 0n): ExecutionObservation => {
    const q = disk.value!.candidate!.quote;
    const tx = Transaction.from(Buffer.from(disk.value!.signedBase64!, 'base64'));
    const accountKeys = tx.compileMessage().accountKeys.map((entry) => entry.toBase58());
    const preBalances = accountKeys.map(() => 100n), index = (address: string) => accountKeys.indexOf(address);
    preBalances[index(q.sponsor)] = observation.sponsorBalance;
    for (const address of [q.attemptPayer, q.user, q.expected.domain, q.expected.primary]) preBalances[index(address)] = 0n;
    const postBalances = preBalances.slice();
    postBalances[index(q.sponsor)]! -= failed ? fee : BigInt(q.cost.maxSponsorDebit);
    if (!failed) {
      postBalances[index(q.attemptPayer)] = residual;
      postBalances[index(q.feeReceiver)]! += price - residual;
      postBalances[index(q.expected.domain)]! += policy.domainRent;
      postBalances[index(q.expected.primary)]! += policy.primaryRent;
    }
    return { finalizedBlockHeight: 499, status: 'finalized', accountSlot: 201, payerBalance: residual,
      domainOwner: failed ? null : q.user, primaryOwner: failed ? null : q.user, primaryName: failed ? null : q.name,
      receipt: { signedBase64: disk.value!.signedBase64!, slot: 200, fee, failed, accountKeys, preBalances, postBalances } };
  };
  return { sponsor, user, input, time, disk, journal, observation, registry, simulation, simulationResponse, chain,
    create, initialize, prepared, signed, ack, finalized };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('one-registration engine', () => {
  it('fixes the configuration and persists a fresh A before reads, without exposing secrets or transaction packets', async () => {
    const f = fixture(), runner = await f.initialize();
    const status = await runner.status();
    expect(status).toMatchObject({ status: 'initialized', config: { name: 'firstbite' }, phase0GateComplete: false });
    expect([f.input.sponsor, f.input.user]).not.toContain(status.attemptPayer);
    expect(f.registry.observe).not.toHaveBeenCalled(); expect(f.chain.broadcast).not.toHaveBeenCalled();
    const original = f.disk.value!.attemptPayer;
    f.input.sponsor = key(8).publicKey.toBase58();
    status.config!.sponsor = key(9).publicKey.toBase58();
    expect((await runner.status()).config!.sponsor).toBe(f.sponsor.publicKey.toBase58());
    await expect(runner.initialize(f.input)).rejects.toMatchObject({ code: 'already_initialized' });
    await runner.prepare(); await runner.prepare();
    expect(f.disk.value!.attemptPayer).toBe(original);
    expect(JSON.stringify(await runner.status())).not.toMatch(/secret|Base64|signedPayload|privateKey/i);
    await expect((await f.create()).status()).resolves.toMatchObject({ attemptPayer: original });
  });

  it('requires independent U then S signatures and stores authorization and all signatures before broadcasting once', async () => {
    const f = fixture(), runner = await f.signed();
    expect((await runner.status()).status).toBe('wallets_signed');
    expect(f.disk.value!.signedBase64).toBeNull(); expect(f.disk.value!.authorizedAtMs).toBeNull();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    const result = await runner.submit(f.ack());
    expect(result).toMatchObject({ status: 'submitted', userSigned: true, sponsorSigned: true, phase0GateComplete: false });
    expect(f.disk.events.slice(-5)).toEqual(['authorized', 'signed', 'broadcasting', 'broadcast', 'submitted']);
    await runner.submit(f.ack());
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
    await expect(runner.prepare()).rejects.toMatchObject({ code: 'wrong_stage' });
  });

  it('keeps live submission disabled unless the runner was explicitly enabled', async () => {
    const f = fixture(false), runner = await f.signed();
    await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'disabled' });
    expect(f.chain.broadcast).not.toHaveBeenCalled(); expect(f.disk.value!.status).toBe('wallets_signed');
  });

  it.each(['missing', 'hash', 'cap', 'false', 'extra'] as const)('rejects %s acknowledgement before any signing or send', async (mode) => {
    const f = fixture(), runner = await f.signed();
    const ack: Record<string, unknown> = f.ack();
    if (mode === 'missing') delete ack.confirmSpend;
    if (mode === 'hash') ack.messageSha256 = '0'.repeat(64);
    if (mode === 'cap') ack.maxTotalSpend = '99999999999999';
    if (mode === 'false') ack.confirmSpend = false;
    if (mode === 'extra') ack.instructions = ['arbitrary'];
    await expect(runner.submit(ack)).rejects.toMatchObject({ code: 'acknowledgement_required' });
    expect(f.disk.value!.signedBase64).toBeNull(); expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it.each(['wrong-role', 'unsigned', 'changed-message', 'foreign-signature', 'invalid-signature', 'noncanonical'] as const)
  ('rejects %s wallet payloads and leaves the prior state untouched', async (mode) => {
    const f = fixture(), runner = await f.prepared();
    const request = await runner.walletRequest('user');
    const tx = Transaction.from(Buffer.from(request.transactionBase64, 'base64'));
    if (mode === 'changed-message') tx.recentBlockhash = key(7).publicKey.toBase58();
    if (mode !== 'unsigned') tx.partialSign(mode === 'wrong-role' ? f.sponsor : f.user);
    if (mode === 'foreign-signature') tx.partialSign(f.sponsor);
    if (mode === 'invalid-signature') tx.signatures.find((s) => s.publicKey.equals(f.user.publicKey))!.signature!.fill(0xab);
    const payload = unsignedBytes(tx).toString('base64') + (mode === 'noncanonical' ? '\n' : '');
    await expect(runner.acceptSignature('user', request.id, payload)).rejects.toMatchObject({ code: 'signature_invalid' });
    expect((await runner.status()).status).toBe('prepared');
    await expect(runner.walletRequest('sponsor')).rejects.toMatchObject({ code: 'wrong_stage' });
  });

  it('rejects stale candidate IDs and invalidates old approvals before a failed prepare', async () => {
    const f = fixture(), runner = await f.signed(), old = f.disk.value!.candidate!.id;
    f.simulationResponse.value.err = 'AccountNotFound';
    await expect(runner.prepare()).rejects.toMatchObject({ code: 'simulation_failed' });
    expect(await runner.status()).toMatchObject({ status: 'initialized', userSigned: false, sponsorSigned: false, quote: null });
    f.simulationResponse.value.err = null; await runner.prepare();
    await expect(runner.acceptSignature('user', old, '')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.disk.value!.candidate!.id).not.toBe(old);
  });

  it.each(['user-only', 'both-wallets', 'changed-message', 'invalid-sponsor'] as const)
  ('rejects a %s sponsor response while preserving the accepted newcomer signature', async (mode) => {
    const f = fixture(), runner = await f.prepared();
    const userRequest = await runner.walletRequest('user');
    const userTx = Transaction.from(Buffer.from(userRequest.transactionBase64, 'base64'));
    userTx.partialSign(f.user);
    await runner.acceptSignature('user', userRequest.id, unsignedBytes(userTx).toString('base64'));
    const storedUser = f.disk.value!.userSignedBase64;
    const sponsorRequest = await runner.walletRequest('sponsor');
    expect(sponsorRequest.transactionBase64).toBe(userRequest.transactionBase64);
    const tx = Transaction.from(Buffer.from(sponsorRequest.transactionBase64, 'base64'));
    if (mode === 'changed-message') tx.recentBlockhash = key(7).publicKey.toBase58();
    tx.partialSign(mode === 'user-only' ? f.user : f.sponsor);
    if (mode === 'both-wallets') tx.partialSign(f.user);
    if (mode === 'invalid-sponsor') tx.signatures.find((entry) => entry.publicKey.equals(f.sponsor.publicKey))!.signature!.fill(0xab);
    await expect(runner.acceptSignature('sponsor', sponsorRequest.id, unsignedBytes(tx).toString('base64')))
      .rejects.toMatchObject({ code: 'signature_invalid' });
    expect(f.disk.value!.userSignedBase64).toBe(storedUser);
    expect(await runner.status()).toMatchObject({ status: 'user_signed', sponsorSigned: false });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it.each(['user-funded', 'program', 'price', 'fee', 'sponsor-shortfall', 'expired-height', 'expired-time'] as const)
  ('rechecks %s before enabling a wallet signature', async (mode) => {
    const f = fixture(), runner = await f.prepared();
    if (mode === 'user-funded') f.observation.userBalance = 1n;
    if (mode === 'program') f.observation.programSha256 = '0'.repeat(64);
    if (mode === 'price') f.observation.registrationPrice -= 1n;
    if (mode === 'fee') f.registry.getMessageFee.mockResolvedValue(fee + 1n);
    if (mode === 'sponsor-shortfall') f.observation.sponsorBalance = 1n;
    if (mode === 'expired-height') f.simulation.getBlockHeight.mockResolvedValue(501);
    if (mode === 'expired-time') f.time.now += 60_000;
    await expect(runner.walletRequest('user')).rejects.toMatchObject({ code: mode.startsWith('expired') ? 'quote_expired' : 'policy_changed' });
    expect(f.disk.value!.userSignedBase64).toBeNull();
  });

  it('rechecks newcomer balance and final fee after both approvals, before A signs', async () => {
    const f = fixture(), runner = await f.signed();
    f.observation.userBalance = 1n;
    await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'policy_changed' });
    f.observation.userBalance = 0n; f.chain.preflight.mockResolvedValue({ checkedAtMs: epoch, slot: 100, blockHeight: 490, fee: fee + 1n,
      sponsorBalance: f.observation.sponsorBalance });
    await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'policy_changed' });
    expect(f.disk.value!.signedBase64).toBeNull(); expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it.each(['authorized', 'signed', 'broadcasting'] as const)('poisons the instance and does not send after a %s persistence failure', async (stage) => {
    const f = fixture(), runner = await f.signed(); f.disk.failAt = stage;
    await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    await expect(runner.status()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(runner.prepare()).rejects.toMatchObject({ code: 'storage_unavailable' });
  });

  it('does not create the attempt signature until the authorization journal write has completed', async () => {
    const f = fixture(), runner = await f.signed();
    let begin!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const released = new Promise<void>((resolve) => { finish = resolve; });
    const persist = f.journal.write.getMockImplementation()!;
    f.journal.write.mockImplementation(async (state) => {
      if (state.status === 'authorized') { begin(); await released; }
      await persist(state);
    });
    const sign = vi.spyOn(Transaction.prototype, 'partialSign');
    const submitted = runner.submit(f.ack());
    await started;
    expect(sign).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(f.disk.value!.status).toBe('wallets_signed');
    finish();
    expect(await submitted).toMatchObject({ status: 'submitted' });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it('resumes an authorized or fully signed record only after a new exact acknowledgement and fresh checks', async () => {
    for (const failedWrite of ['signed', 'broadcasting']) {
      const f = fixture(), runner = await f.signed(); f.disk.failAt = failedWrite;
      await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'storage_unavailable' });
      f.disk.failAt = null;
      const reopened = await f.create(); expect(f.chain.broadcast).not.toHaveBeenCalled();
      await expect(reopened.submit({})).rejects.toMatchObject({ code: 'acknowledgement_required' });
      await reopened.submit(f.ack()); expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
    }
  });

  it('retains an uncertain broadcast and never resends on restart, re-submit, or expiry', async () => {
    const f = fixture(), runner = await f.signed(); f.chain.broadcast.mockRejectedValue(new Error('network lost after acceptance'));
    expect(await runner.submit(f.ack())).toMatchObject({ status: 'broadcast_unknown' });
    const reopened = await f.create();
    expect((await reopened.submit(f.ack())).status).toBe('broadcast_unknown');
    expect((await reopened.reconcile()).status).toBe('broadcast_unknown');
    f.chain.observe.mockResolvedValue({ ...await f.chain.observe(), finalizedBlockHeight: 501 });
    expect(await reopened.reconcile()).toMatchObject({ status: 'manual_review', manualReason: 'expired' });
    await expect(reopened.prepare()).rejects.toMatchObject({ code: 'wrong_stage' });
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
    expect(f.disk.value!.attemptSecretBase64).not.toBeNull();
  });

  it('treats a crash after persisting broadcasting as uncertain even when no send was observed', async () => {
    const f = fixture(), runner = await f.signed(); f.disk.failAt = 'submitted';
    await expect(runner.submit(f.ack())).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(f.disk.value!.status).toBe('broadcasting'); f.disk.failAt = null;
    const reopened = await f.create(); await reopened.submit(f.ack());
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not resend when a timed-out broadcast resolves after the runner has recorded uncertainty', async () => {
    const f = fixture(), runner = await f.signed();
    vi.useFakeTimers();
    let accept: ((signature: string) => void) | undefined;
    f.chain.broadcast.mockImplementation(() => new Promise<string>((resolve) => { accept = resolve; }));
    const submitted = runner.submit(f.ack());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await submitted).toMatchObject({ status: 'broadcast_unknown' });
    expect(accept).toBeTypeOf('function');
    accept!(f.disk.value!.transactionSignature!);
    await Promise.resolve();
    expect(await runner.submit(f.ack())).toMatchObject({ status: 'broadcast_unknown' });
    const reopened = await f.create();
    expect(await reopened.submit(f.ack())).toMatchObject({ status: 'broadcast_unknown' });
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires finalized receipt evidence and exact ownership, and records verified amounts', async () => {
    const f = fixture(), runner = await f.signed(); await runner.submit(f.ack());
    f.chain.observe.mockResolvedValue({ ...await f.chain.observe(), status: 'confirmed' });
    expect(await runner.reconcile()).toMatchObject({ status: 'confirmed', settlement: null });
    expect(f.disk.value!.attemptSecretBase64).not.toBeNull();
    f.chain.observe.mockResolvedValue(f.finalized());
    expect(await runner.reconcile()).toMatchObject({ status: 'complete', settlement: { success: true, fee: '15000',
      debit: '15000003369720', residual: '0', slot: 200 }, phase0GateComplete: false });
    expect(f.disk.value!.attemptSecretBase64).toBeNull();
    expect(await (await f.create()).status()).toMatchObject({ status: 'complete' });
    await runner.reconcile(); await runner.submit(f.ack()); expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-owner', 'wrong-primary', 'wrong-name', 'receipt-mismatch', 'recipient-funded', 'wrong-debit', 'stale-account', 'adapter-evidence-error'] as const)
  ('retains A for manual review when finalized evidence has %s', async (mode) => {
    const f = fixture(), runner = await f.signed(); await runner.submit(f.ack());
    const observed = f.finalized();
    if (mode === 'wrong-owner') observed.domainOwner = f.input.sponsor;
    if (mode === 'wrong-primary') observed.primaryOwner = f.input.sponsor;
    if (mode === 'wrong-name') observed.primaryName = 'other';
    if (mode === 'receipt-mismatch') observed.receipt!.signedBase64 = '';
    if (mode === 'recipient-funded') {
      const i = observed.receipt!.accountKeys.indexOf(f.input.user);
      observed.receipt!.preBalances[i] = 1n; observed.receipt!.postBalances[i] = 1n;
    }
    if (mode === 'wrong-debit') observed.receipt!.postBalances[0]! -= 1n;
    if (mode === 'stale-account') observed.accountSlot = 199;
    f.chain.observe.mockResolvedValue(observed);
    if (mode === 'adapter-evidence-error') f.chain.observe.mockRejectedValue(new ExecutionError('evidence_invalid'));
    expect(await runner.reconcile()).toMatchObject({ status: 'manual_review', manualReason: 'evidence_invalid', settlement: null });
    expect(f.disk.value!.attemptSecretBase64).not.toBeNull(); expect(f.chain.prepareRecovery).not.toHaveBeenCalled();
  });

  it('records failure fees separately and never retries a failed registration', async () => {
    const f = fixture(), runner = await f.signed(); await runner.submit(f.ack()); f.chain.observe.mockResolvedValue(f.finalized(true));
    expect(await runner.reconcile()).toMatchObject({ status: 'failed', settlement: { success: false, fee: '15000', debit: '15000', residual: '0' } });
    expect(f.disk.value!.attemptSecretBase64).toBeNull();
    await expect(runner.prepare()).rejects.toMatchObject({ code: 'wrong_stage' }); expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it('retains residual funds and A after a price reduction without automatically sweeping', async () => {
    const f = fixture(), runner = await f.signed(); await runner.submit(f.ack()); f.chain.observe.mockResolvedValue(f.finalized(false, 100n));
    expect(await runner.reconcile()).toMatchObject({ status: 'manual_review', manualReason: 'recovery_needed', settlement: { success: true, residual: '100' } });
    expect(f.disk.value!.attemptSecretBase64).not.toBeNull(); expect(f.chain.prepareRecovery).not.toHaveBeenCalled();
  });

  it('retains the previous durable state when recording finalized evidence fails and rechecks it after restart', async () => {
    const f = fixture(), runner = await f.signed();
    await runner.submit(f.ack());
    f.chain.observe.mockResolvedValue(f.finalized());
    f.disk.failAt = 'complete';
    await expect(runner.reconcile()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(f.disk.value!.status).toBe('submitted');
    expect(f.disk.value!.attemptSecretBase64).not.toBeNull();
    await expect(runner.status()).rejects.toMatchObject({ code: 'storage_unavailable' });
    f.disk.failAt = null;
    const reopened = await f.create();
    expect(await reopened.reconcile()).toMatchObject({ status: 'complete' });
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it.each(['key', 'message', 'status', 'terminal', 'signature', 'config'] as const)('rejects corrupted persisted %s before any chain calls', async (mode) => {
    const f = fixture(), runner = await f.signed();
    if (mode === 'key') f.disk.value!.attemptSecretBase64 = Buffer.alloc(64).toString('base64');
    if (mode === 'message') (f.disk.value!.candidate!.quote as { messageBase64: string }).messageBase64 = '';
    if (mode === 'status') f.disk.value!.status = 'unknown' as SmokeRunnerState['status'];
    if (mode === 'terminal') f.disk.value!.status = 'complete';
    if (mode === 'signature') f.disk.value!.userSignedBase64 = f.disk.value!.sponsorSignedBase64;
    if (mode === 'config') f.disk.value!.config.user = key(8).publicKey.toBase58();
    const before = f.registry.observe.mock.calls.length;
    await expect(f.create()).rejects.toMatchObject({ code: 'invalid_state' });
    expect(f.registry.observe).toHaveBeenCalledTimes(before); expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect((await runner.status()).status).toBe('wallets_signed');
  });

  it('serializes mutations and bounds a hung read without echoing provider details', async () => {
    vi.useFakeTimers(); const f = fixture(), runner = await f.initialize();
    f.registry.observe.mockImplementation(() => new Promise(() => {}));
    const pending = runner.prepare().catch((error: unknown) => error);
    await expect(runner.prepare()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: 'chain_unavailable', message: 'Registration check unavailable: chain_unavailable' });
    expect(vi.getTimerCount()).toBe(0); expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it('allows a composite read longer than one RPC deadline while preserving the quote deadline', async () => {
    vi.useFakeTimers(); const f = fixture(), runner = await f.initialize();
    const observe = f.registry.observe.getMockImplementation()!;
    f.registry.observe.mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return observe(input);
    });
    const pending = runner.prepare();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ status: 'prepared' });
    f.time.now += 60_000;
    await expect(runner.walletRequest('user')).rejects.toMatchObject({ code: 'quote_expired' });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still bounds a single simulation RPC at four seconds', async () => {
    vi.useFakeTimers(); const f = fixture(), runner = await f.initialize();
    f.simulation.simulateTransaction.mockImplementation(() => new Promise(() => {}));
    const pending = runner.prepare().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toMatchObject({ code: 'chain_unavailable' });
    expect(await runner.status()).toMatchObject({ status: 'initialized' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
