import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWalletProbe } from '../scripts/phase0/wallet-probe';
import type { ChainSnapshot } from '../scripts/phase0/inspect-chain';
import type { RegistryClient } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import type { SponsorProbeSimulationConnection } from '../src/lib/operations/sponsor-probe';

describe('sponsor diagnostic loopback boundary', () => {
  let probe: Awaited<ReturnType<typeof startWalletProbe>>;
  let token: string;
  const user = Keypair.generate();
  const sponsor = Keypair.generate();
  const snapshot = JSON.parse(readFileSync('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot;
  let sponsorBalance = 0n;
  let userBalance = 0n;
  let simulation: SponsorProbeSimulationConnection;
  let client: RegistryClient;
  const input = () => ({ name: 'firstbitecheck', sponsor: sponsor.publicKey.toBase58(), user: user.publicKey.toBase58(),
    limits: { maxRegistrationPrice: '15000000000000', maxTransactionFee: '100000', recoveryAllowance: '100000', maxTotalSpend: '15001000000000' } });

  beforeEach(async () => {
    sponsorBalance = 0n; userBalance = 0n;
    client = {
      observe: vi.fn(async (request) => ({ ...request, feeReceiver: new PublicKey(policy.feeReceiverAddress),
        registrationPrice: 15_000_000_000_000n, domainRent: policy.domainRent, primaryRent: policy.primaryRent,
        sponsorBalance, userBalance, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 500,
        observedSlot: 100, blockhashContextSlot: 101, observedAtMs: Date.now(), genesisHash: policy.genesisHash,
        configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id })),
      getMessageFee: vi.fn(async () => 15_000n),
    };
    simulation = {
      getGenesisHash: vi.fn(async () => policy.genesisHash),
      getBlockHeight: vi.fn(async () => 200),
      simulateTransaction: vi.fn(async () => ({ context: { slot: 102 }, value: { err: null, logs: [], unitsConsumed: 50_000 } })),
    } as SponsorProbeSimulationConnection;
    probe = await startWalletProbe({ snapshot, port: 0, sponsorDependencies: { client, simulation } });
    const response = await fetch(`${probe.url}/sponsor`);
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    token = JSON.parse(page.match(/const config = (\{[^\n]+\});/)![1]!).token;
  });
  afterEach(async () => { if (probe) await probe.close(); vi.restoreAllMocks(); });
  async function post(path: string, body: unknown, origin = probe.url, session = token) {
    return fetch(`${probe.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Probe-Token': session }, body: JSON.stringify(body) });
  }
  async function ready() {
    sponsorBalance = 16_000_000_000_000n;
    const response = await post('/sponsor/prepare', input());
    expect(response.status).toBe(200);
    return await response.json() as { report: Record<string, unknown>; candidate: { id: string; transactionBase64: string; expiresAtMs: number } };
  }

  it('returns a downloadable shortfall report without a candidate or simulation', async () => {
    const response = await post('/sponsor/prepare', input());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ candidate: null, report: { outcome: 'blocked', signatureRequestReady: false, blockers: ['sponsor_funding_shortfall'], phase0GateComplete: false } });
    expect(JSON.stringify(result)).not.toMatch(/transactionBase64|secretKey|privateKey/);
    expect(simulation.simulateTransaction).not.toHaveBeenCalled();
  });

  it('accepts only the newcomer signature on the prepared fixed message, then consumes the candidate', async () => {
    const result = await ready();
    expect(result.report).toMatchObject({ outcome: 'ready', signatureRequestReady: true, spendAuthorized: false, phase0GateComplete: false });
    const tx = Transaction.from(Buffer.from(result.candidate.transactionBase64, 'base64'));
    expect(tx.signatures).toHaveLength(3);
    expect(tx.signatures.every(({ signature }) => signature === null)).toBe(true);
    expect(tx.feePayer!.equals(sponsor.publicKey)).toBe(true);
    tx.partialSign(user);
    const body = { id: result.candidate.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') };
    const response = await post('/sponsor/verify', body);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({ outcome: 'passed', signatureRequestReady: false, userSignatureValid: true, messageUnchanged: true,
      sponsorSignaturePresent: false, attemptSignaturePresent: false, broadcast: false, registrationCompleted: false, phase0GateComplete: false });
    expect(JSON.stringify(report)).not.toMatch(/transactionBase64|signedTransactionBase64|secretKey|privateKey/);
    expect((await post('/sponsor/verify', body)).status).toBe(410);
    expect((await post('/verify', body)).status).toBe(410);
  });

  it.each(['changed-message', 'sponsor-signed', 'unsigned'] as const)('rejects %s bytes instead of declaring compatibility', async (kind) => {
    const { candidate } = await ready();
    const tx = Transaction.from(Buffer.from(candidate.transactionBase64, 'base64'));
    if (kind === 'changed-message') tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    if (kind !== 'unsigned') tx.partialSign(user);
    if (kind === 'sponsor-signed') tx.partialSign(sponsor);
    const body = { id: candidate.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') };
    expect((await post('/sponsor/verify', body)).status).toBe(400);
    expect((await post('/sponsor/verify', body)).status).toBe(410);
  });

  it.each(['height', 'clock', 'genesis'])('rejects verification after %s changes', async (kind) => {
    const { candidate } = await ready();
    const tx = Transaction.from(Buffer.from(candidate.transactionBase64, 'base64'));
    tx.partialSign(user);
    if (kind === 'height') vi.mocked(simulation.getBlockHeight).mockResolvedValue(501);
    if (kind === 'clock') vi.spyOn(Date, 'now').mockReturnValue(candidate.expiresAtMs + 1);
    if (kind === 'genesis') vi.mocked(simulation.getGenesisHash).mockResolvedValue('another-chain');
    expect((await post('/sponsor/verify', { id: candidate.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') })).status).toBe(410);
  });

  it('rejects origins, missing tokens, arbitrary fields, account aliases and send routes', async () => {
    expect((await post('/sponsor/prepare', input(), 'https://other.example')).status).toBe(403);
    expect((await post('/sponsor/prepare', input(), probe.url, '')).status).toBe(403);
    expect((await post('/sponsor/prepare', { ...input(), secretKey: 'never-echo-this' })).status).toBe(400);
    expect((await post('/sponsor/prepare', { ...input(), sponsor: input().user })).status).toBe(400);
    expect((await post('/sponsor/send', input())).status).toBe(404);
    expect((await post('/sponsor/prepare', { ...input(), name: 'a'.repeat(9000) })).status).toBe(413);
    expect(client.observe).not.toHaveBeenCalled();
  });
});
