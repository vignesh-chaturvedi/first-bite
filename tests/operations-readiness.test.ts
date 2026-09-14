import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistryHealthProbe } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { evaluateOperationalReadiness, type OperationalSnapshot } from '../src/lib/operations/readiness';
import { chainFixture, systemAccount } from './helpers/chain-fixture';

const now = 1_800_000_000_000;
const sponsor = Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey.toBase58();
const id = 'dc722419-c650-4638-8bd3-60e0d4e3d9d6';
function fixture() {
  const snapshot: OperationalSnapshot = { checkedAtMs: now, migrated: true, workerFresh: true, accountingConsistent: true,
    manualReviews: 0, sponsorHeldNative: 100n,
    campaign: { id, slug: 'test', name: 'Test', status: 'active', startsAt: new Date(now - 60_000), endsAt: new Date(now + 60_000),
      maxUsers: 10, capNative: '1000', reservedNative: '100', spentNative: '200', reservedUsers: 1, consumedUsers: 2,
      sponsorPublicKey: sponsor, policyVersion: policy.id, limits: { maxRegistrationPrice: 70n, maxTransactionFee: 10n, recoveryAllowance: 10n, maxReservation: 100n, ttlMs: 45_000 } } };
  const health = { checkedAtMs: now, slot: 123, sponsorBalance: 1000n, policyId: policy.id, genesisHash: policy.genesisHash };
  const deps = { snapshot: vi.fn(async () => snapshot), chain: vi.fn(async () => health),
    signer: { enabled: true, publicKey: sponsor as string | null }, expectedGenesisHash: policy.genesisHash, now: () => now };
  return { snapshot, health, deps };
}
afterEach(() => vi.useRealTimers());
describe('operational admission readiness', () => {
  it('permits new authorization only after all private checks pass', async () => {
    const f = fixture(); const result = await evaluateOperationalReadiness(id, f.deps);
    expect(result).toMatchObject({ newSignaturesAllowed: true, canPrepare: true, failures: [], funding: { nextPassFloorNative: '200' } });
  });
  it.each(['migrated', 'workerFresh', 'accountingConsistent'] as const)('denies when %s is false', async (field) => {
    const f = fixture(); f.snapshot[field] = false;
    expect((await evaluateOperationalReadiness(id, f.deps)).newSignaturesAllowed).toBe(false);
  });
  it.each(['paused', 'ended', 'draft'] as const)('denies a %s campaign', async (state) => {
    const f = fixture(); f.snapshot.campaign.status = state;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toContain('campaign_unavailable');
  });
  it('does not let the exhausted next-pass budget prevent signing an already reserved pass', async () => {
    const f = fixture(); f.snapshot.campaign.capNative = '300'; f.snapshot.campaign.maxUsers = 3;
    expect(await evaluateOperationalReadiness(id, f.deps)).toMatchObject({ newSignaturesAllowed: true, canPrepare: false });
  });
  it('covers aggregate holds for the same sponsor and uses exact integer arithmetic', async () => {
    const f = fixture(); f.snapshot.sponsorHeldNative = 90071992547409930n; f.health.sponsorBalance = 90071992547409929n;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toContain('sponsor_underfunded');
    f.health.sponsorBalance += 1n;
    expect(await evaluateOperationalReadiness(id, f.deps)).toMatchObject({ newSignaturesAllowed: true, canPrepare: false,
      funding: { heldNative: '90071992547409930', balanceNative: '90071992547409930' } });
  });
  it('rejects ledger drift, unresolved review and signer identity/activation errors', async () => {
    const f = fixture(); f.snapshot.campaign.reservedNative = '999'; f.snapshot.manualReviews = 1; f.deps.signer.enabled = false;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toEqual(expect.arrayContaining(['accounting_mismatch', 'manual_review', 'signer_disabled']));
    expect(f.deps.chain).not.toHaveBeenCalled();
    f.deps.signer.enabled = true; f.deps.signer.publicKey = null;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toContain('signer_mismatch');
  });
  it('rejects unexpected configured genesis before contacting RPC', async () => {
    const f = fixture(); f.deps.expectedGenesisHash = sponsor;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toContain('policy_changed'); expect(f.deps.chain).not.toHaveBeenCalled();
  });
  it.each([-5001, 1])('rejects database/chain evidence offset by %d ms', async (offset) => {
    const f = fixture(); f.snapshot.checkedAtMs += offset; f.health.checkedAtMs += offset;
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toContain('stale_evidence');
  });
  it('fails closed without retaining private database/RPC errors', async () => {
    const f = fixture(); f.deps.chain.mockRejectedValueOnce(new Error('https://private:secret@rpc.invalid'));
    const result = await evaluateOperationalReadiness(id, f.deps);
    expect(result.failures).toContain('rpc_unavailable'); expect(JSON.stringify(result)).not.toMatch(/secret|rpc.invalid/);
    f.deps.snapshot.mockRejectedValueOnce(new Error('private database'));
    expect((await evaluateOperationalReadiness(id, f.deps)).failures).toEqual(['database_unavailable']);
  });
  it('bounds stalled probes without leaving a readiness timer', async () => {
    vi.useFakeTimers(); const f = fixture(); f.deps.chain.mockImplementationOnce(() => new Promise(() => {}));
    const result = evaluateOperationalReadiness(id, f.deps, 25); await vi.advanceTimersByTimeAsync(25);
    expect((await result).failures).toEqual(['timeout']); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('read-only infrastructure and sponsor probe', () => {
  function probeFixture() {
    const f = chainFixture();
    const probe = createRegistryHealthProbe('https://rpc.invalid/private', { connection: f.connection, policy: f.policy, clock: () => now });
    return { ...f, probe, sponsor: f.input.sponsor.toBase58() };
  }
  it('checks finalized executable/config/rent and sponsor without a name or send request', async () => {
    const f = probeFixture();
    expect(await f.probe(f.sponsor)).toMatchObject({ slot: 100, sponsorBalance: 1_000_000_000_000_000n, policyId: f.policy.id });
    expect(f.connection.getMultipleAccountsInfoAndContext.mock.calls[0]![0]).toHaveLength(6);
    expect(f.connection.getLatestBlockhashAndContext).not.toHaveBeenCalled(); expect(f.connection.getFeeForMessage).not.toHaveBeenCalled();
  });
  it('treats an unfunded absent sponsor as zero', async () => {
    const f = probeFixture(); f.accounts.delete(f.sponsor);
    expect((await f.probe(f.sponsor)).sponsorBalance).toBe(0n);
  });
  it.each(['genesis', 'elf', 'config', 'rent', 'sponsor', 'unsafe', 'rollback'] as const)('rejects changed %s evidence', async (mode) => {
    const f = probeFixture();
    if (mode === 'genesis') f.connection.getGenesisHash.mockResolvedValue('wrong');
    if (mode === 'elf') f.accounts.get(f.policy.programDataAddress)!.data[60] = f.accounts.get(f.policy.programDataAddress)!.data[60]! ^ 1;
    if (mode === 'config') f.accounts.get(f.policy.configAddress)!.data[60] = f.accounts.get(f.policy.configAddress)!.data[60]! ^ 1;
    if (mode === 'rent') f.connection.getMinimumBalanceForRentExemption.mockResolvedValue(1);
    if (mode === 'sponsor') f.accounts.get(f.sponsor)!.executable = true;
    if (mode === 'unsafe') f.accounts.set(f.sponsor, systemAccount(Number.MAX_SAFE_INTEGER + 1));
    if (mode === 'rollback') { await f.probe(f.sponsor); f.connection.getMultipleAccountsInfoAndContext.mockResolvedValueOnce({ context: { slot: 99 }, value: [] }); }
    await expect(f.probe(f.sponsor)).rejects.toHaveProperty('code');
  });
  it('rejects slow RPC and sanitizes arbitrary upstream errors', async () => {
    vi.useFakeTimers(); const f = probeFixture(); f.connection.getGenesisHash.mockImplementationOnce(() => new Promise(() => {}));
    const probe = createRegistryHealthProbe('https://rpc.invalid/private', { connection: f.connection, policy: f.policy, requestTimeoutMs: 20 });
    const pending = expect(probe(f.sponsor)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20); await pending;
    f.connection.getGenesisHash.mockRejectedValueOnce(new Error('private-rpc-key'));
    await expect(probe(f.sponsor)).rejects.toMatchObject({ code: 'RPC_FAILED', message: 'Registry observation failed: RPC_FAILED' });
  });
});
