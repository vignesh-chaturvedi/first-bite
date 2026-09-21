import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTransactionDecoder } from '@solana/kit';
import { PublicKey, Transaction } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema';
import { createDatabase } from '../src/db/client';
import { upsertExecutionHeartbeat } from '../src/db/heartbeat';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { createCampaignHandlers } from '../src/lib/campaigns/http';
import { createRegistryClient, createRegistryHealthProbe, type RegistryReadConnection } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { decodeDomain, decodePrimary, domainPda, primaryPda } from '../src/lib/cookie/registry';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { openPayload } from '../src/lib/execution/crypto';
import { createExecutionHandlers } from '../src/lib/execution/http';
import { createSubmissionRuntime, createWorkerRuntime } from '../src/lib/execution/runtime';
import { executionIdentity } from '../src/lib/execution/runtime-identity';
import type { ExecutionChain, ExecutionObservation, FinalizedReceipt } from '../src/lib/execution/types';
import { createJourneyApi } from '../src/lib/onboarding/api';
import { JourneyController } from '../src/lib/onboarding/controller';
import { COOKIE_GENESIS, verifiedResult } from '../src/lib/onboarding/model';
import { createOperationalProbes } from '../src/lib/operations/probes';
import { createLogger } from '../src/server/logger';
import { account, balance, localRegistry } from './helpers/local-registry';

const databaseUrl = process.env.DATABASE_TEST_URL;
const origin = 'https://localhost:3000';

describe.skipIf(!databaseUrl)('application HTTP, PostgreSQL and execution runtime integration', () => {
  const schema = `first_bite_application_${randomBytes(8).toString('hex')}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  let scopedUrl: string;
  beforeAll(async () => {
    assertLocalFixtureUrl(databaseUrl!, 'test');
    const url = parseDatabaseUrl(databaseUrl);
    if (url.pathname !== '/first_bite_test') throw new Error('Dedicated test database required');
    admin = createDatabase(databaseUrl!);
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.toString();
    await migrateDatabase(scopedUrl, { migrationsSchema: `${schema}_migrations` });
    db = createDatabase(scopedUrl);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}_migrations" CASCADE`);
      await admin.pool.end();
    }
  });

  async function fixture() {
    const proof = localRegistry();
    const { svm, sponsor, user, snapshot } = proof;
    const wrappingKey = randomBytes(32).toString('base64');
    const config = parseConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, DATABASE_URL: scopedUrl,
      PREPARATION_ENABLED: 'true', RELAY_ENABLED: 'true', WORKER_ENABLED: 'true',
      ATTEMPT_ENCRYPTION_KEY: wrappingKey, SPONSOR_PUBLIC_KEY: sponsor.publicKey.toBase58() });

    // The deployed ELF executes only inside LiteSVM. Even registry/health reads
    // use an injected connection, so an accidental real RPC call fails the test.
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external network request'));
    const elf = readFileSync('.cache/registry.so');
    const programData = Buffer.alloc(45 + elf.length);
    programData.writeUInt32LE(3); programData.writeBigUInt64LE(policy.deploymentSlot, 4);
    programData[12] = 1; new PublicKey(policy.upgradeAuthority).toBuffer().copy(programData, 13); elf.copy(programData, 45);
    const saved = (value: typeof snapshot.program) => ({ data: Buffer.from(value.dataBase64, 'base64'),
      executable: value.executable, owner: new PublicKey(value.owner), lamports: Number(value.lamports) });
    const metadata = new Map([
      [snapshot.program.address, saved(snapshot.program)], [snapshot.rent.address, saved(snapshot.rent)],
      [policy.programDataAddress, { data: programData, executable: false, owner: new PublicKey(policy.loaderAddress), lamports: 1_000_000 }],
    ]);
    let slot = 100;
    const connection: RegistryReadConnection = {
      async getGenesisHash() { return policy.genesisHash; },
      async getMultipleAccountsInfoAndContext(keys) { return { context: { slot: slot++ }, value: keys.map((key) => metadata.get(key.toBase58()) ?? account(svm, key)) }; },
      async getMinimumBalanceForRentExemption(size) { return Number(size === 149 ? policy.domainRent : policy.primaryRent); },
      async getLatestBlockhashAndContext() { return { context: { slot: slot++ }, value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000 } }; },
      async getFeeForMessage() { return { context: { slot: slot++ }, value: 15_000 }; },
    };
    const registry = createRegistryClient('http://127.0.0.1:1', { connection });
    const identity = executionIdentity(config);
    const probes = createOperationalProbes(db.pool, { ...config, executionIdentity: identity });
    probes.chain = createRegistryHealthProbe('http://127.0.0.1:1', { connection });
    const receipts = new Map<string, FinalizedReceipt>();
    const broadcasts: string[] = [];
    const controls = { lostSendResponse: false };
    const chain: ExecutionChain = {
      preflight: vi.fn(async () => ({ checkedAtMs: Date.now(), slot: 400, blockHeight: 900, fee: 15_000n, sponsorBalance: balance(svm, sponsor.publicKey) })),
      broadcast: vi.fn(async (bytes) => {
        const tx = Transaction.from(Buffer.from(bytes, 'base64'));
        const hash = createHash('sha256').update(tx.serializeMessage()).digest('hex');
        const persisted = (await db.pool.query('SELECT id,signature,encrypted_signed_payload FROM execution_operations WHERE message_hash=$1', [hash])).rows[0];
        expect(persisted).toBeDefined();
        expect(openPayload(persisted.encrypted_signed_payload, wrappingKey, persisted.id, 'signed')).toBe(bytes);
        broadcasts.push(bytes);
        if (!receipts.has(persisted.signature)) {
          const keys = tx.compileMessage().accountKeys;
          const preBalances = keys.map((key) => balance(svm, key));
          const result = svm.sendTransaction(getTransactionDecoder().decode(Buffer.from(bytes, 'base64')));
          expect(result).not.toBeInstanceOf(FailedTransactionMetadata);
          receipts.set(persisted.signature, { signedBase64: bytes, slot: 500, fee: 15_000n, failed: result instanceof FailedTransactionMetadata,
            accountKeys: keys.map((key) => key.toBase58()), preBalances, postBalances: keys.map((key) => balance(svm, key)) });
        }
        if (controls.lostSendResponse) throw new Error('Synthetic lost send response');
        return persisted.signature;
      }),
      observe: vi.fn(async (operation, attempt) => {
        const receipt = operation.signature ? receipts.get(operation.signature) ?? null : null;
        const domain = account(svm, domainPda(attempt.name));
        const primary = account(svm, primaryPda(user.publicKey));
        return { finalizedBlockHeight: 900, status: receipt ? 'finalized' : 'missing', receipt, accountSlot: 501,
          payerBalance: balance(svm, new PublicKey(attempt.payerPublicKey)),
          domainOwner: domain ? decodeDomain(domain, attempt.name).owner.toBase58() : null,
          primaryOwner: primary ? decodePrimary(primary, user.publicKey).owner.toBase58() : null,
          primaryName: primary ? decodePrimary(primary, user.publicKey).name : null } satisfies ExecutionObservation;
      }),
      prepareRecovery: vi.fn(async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000, observedSlot: 501, fee: 10_000n, preparedAtMs: Date.now() })),
    };
    const ports = { chain, registry, probes };
    const submission = createSubmissionRuntime(db.pool, config, ports);
    const signer = { publicKey: sponsor.publicKey.toBase58(), secret: vi.fn(() => sponsor.secretKey) };
    const worker = () => createWorkerRuntime(db.pool, config, signer, ports);
    const campaign = await submission.campaigns.createCampaign({ slug: `app-${randomBytes(6).toString('hex')}`, name: 'Application integration',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), maxUsers: 1,
      capNative: BigInt(snapshot.quote.totalPerPass), sponsorPublicKey: sponsor.publicKey.toBase58(),
      limits: { maxRegistrationPrice: BigInt(snapshot.quote.price), maxTransactionFee: 15_000n, recoveryAllowance: 15_000n,
        maxReservation: BigInt(snapshot.quote.totalPerPass) } });
    await submission.campaigns.setCampaignStatus(campaign.id, 'active');
    const invitation = await submission.campaigns.issueInvite({ campaignId: campaign.id, wallet: user.publicKey.toBase58(), expiresAt: new Date(Date.now() + 600_000) });
    const log = createLogger(() => undefined);
    const handlers = createCampaignHandlers({ preparationEnabled: config.preparationEnabled, appOrigin: origin,
      attemptEncryptionKey: wrappingKey, trustedIpHeader: 'none', getStore: () => submission.campaigns, getRegistry: () => registry,
      admission: submission.admission, log });
    const execution = createExecutionHandlers({ enabled: config.relayEnabled, appOrigin: origin,
      trustedIpHeader: 'none', getCampaignStore: () => submission.campaigns, getService: () => submission.service, log });
    let cookie = '';
    const fetcher: typeof fetch = async (path, options) => {
      const url = new URL(String(path), origin);
      const request = new Request(url, { ...options, headers: { origin, cookie, 'content-type': 'application/json' } });
      let response: Response;
      const operation = /^\/api\/attempts\/([a-f0-9-]+)(?:\/(submit|retry))?$/.exec(url.pathname);
      if (url.pathname === '/api/session') response = await handlers.session(request);
      else if (url.pathname === '/api/invites/exchange') response = await handlers.exchange(request);
      else if (url.pathname === '/api/quotes') response = await handlers.quote(request);
      else if (url.pathname === '/api/attempts') response = await handlers.reserve(request);
      else if (operation?.[1]) response = operation[2] === 'submit' ? await execution.submit(request, operation[1])
        : operation[2] === 'retry' ? await execution.retry(request, operation[1]) : await handlers.attempt(request, operation[1]);
      else throw new Error('Unexpected application route');
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      return response;
    };
    const api = createJourneyApi(fetcher);
    const walletSnapshot = { installed: true, address: user.publicKey.toBase58(), genesisHash: COOKIE_GENESIS, canSign: true };
    let userSigned = '';
    const wallet = { snapshot: () => walletSnapshot, connect: async () => walletSnapshot, switchToCookie: async () => walletSnapshot,
      disconnect: async () => undefined, subscribe: () => () => undefined,
      sign: vi.fn(async (input: { unsignedTransactionBase64: string }) => {
        const tx = Transaction.from(Buffer.from(input.unsignedTransactionBase64, 'base64')); tx.partialSign(user);
        userSigned = unsignedBytes(tx).toString('base64'); return userSigned;
      }) };
    const controller = new JourneyController(api, wallet, config.relayEnabled);
    const workerId = randomUUID();
    async function heartbeat(value = identity) { await upsertExecutionHeartbeat(db.db, { workerId, startedAt: new Date(), identity: value }); }
    async function prepare() {
      await controller.restore(); await controller.exchange(invitation.token); controller.continueFromWallet();
      controller.editName(`app${randomBytes(6).toString('hex')}`); await controller.checkName(); await controller.reserve();
      expect(controller.getSnapshot().error).toBeNull();
      expect(controller.getSnapshot().step).toBe('review');
      return controller.getSnapshot().attempt!.id;
    }
    async function tick(runtime: ReturnType<typeof worker>, id: string) {
      await db.pool.query('UPDATE execution_jobs SET next_run_at=clock_timestamp() WHERE operation_id IN (SELECT id FROM execution_operations WHERE attempt_id=$1)', [id]);
      return runtime.service.processOne((await runtime.store.load(id)).operation!.id);
    }
    return { ...proof, config, submission, signer, worker, probes, registry, chain, api, wallet, controller, campaign, invitation,
      network, broadcasts, controls, heartbeat, prepare, tick, ports, userSigned: () => userSigned };
  }

  it('runs a complete invited journey and restores finalized ownership after a lost send response and worker restart', async () => {
    const f = await fixture(); await f.heartbeat();
    const id = await f.prepare();
    expect(f.signer.secret).not.toHaveBeenCalled(); expect(f.broadcasts).toHaveLength(0);
    await f.controller.approve();
    expect(f.controller.getSnapshot()).toMatchObject({ error: null, step: 'progress', attempt: { status: 'signing' } });
    await f.api.submit(id, f.userSigned());
    expect(f.signer.secret).not.toHaveBeenCalled(); expect(f.broadcasts).toHaveLength(0);
    const firstWorker = f.worker(); f.controls.lostSendResponse = true;
    expect(await f.tick(firstWorker, id)).toBe(true);
    expect((await f.api.attempt(id)).status).toBe('broadcast_unknown');
    expect(f.broadcasts).toHaveLength(1);
    const restarted = f.worker(); expect(await f.tick(restarted, id)).toBe(true);
    const restored = new JourneyController(f.api, f.wallet, true); await restored.restore();
    expect(restored.getSnapshot()).toMatchObject({ error: null, step: 'progress', attempt: { id, status: 'complete', wallet: f.user.publicKey.toBase58(), actualCostNative: '15000003369720', residualNative: '0' } });
    expect(verifiedResult(restored.getSnapshot().attempt)).toBe(true);
    expect(f.wallet.sign).toHaveBeenCalledOnce(); expect(f.signer.secret).toHaveBeenCalledOnce();
    await f.api.submit(id, f.userSigned()); expect(await f.tick(restarted, id)).toBe(false);
    expect(f.broadcasts).toHaveLength(1);
    expect((await f.submission.store.load(id)).encryptedPayerKey).toBeNull();
    expect(await f.submission.campaigns.inspectCampaign(f.campaign.id)).toMatchObject({ reservedNative: '0', spentNative: '15000003369720', consumedUsers: 1 });
    expect(balance(f.svm, f.user.publicKey)).toBe(0n);
    expect(JSON.stringify(restored.getSnapshot())).not.toContain(f.userSigned());
    expect(f.network).not.toHaveBeenCalled();
  });

  it.each(['worker_stale', 'worker_identity_mismatch', 'signer_disabled', 'signer_mismatch'] as const)('blocks new submission with %s and keeps the same preparation reviewable', async (failure) => {
    const f = await fixture();
    await f.heartbeat();
    const id = await f.prepare();
    await db.pool.query('DELETE FROM service_heartbeats');
    if (failure === 'worker_identity_mismatch') await f.heartbeat('a'.repeat(64));
    else if (failure !== 'worker_stale') await f.heartbeat();
    if (failure === 'signer_disabled') f.probes.signer.enabled = false;
    if (failure === 'signer_mismatch') f.probes.signer.publicKey = f.user.publicKey.toBase58();
    const readiness = await f.submission.admission(f.campaign.id);
    expect(readiness.newSignaturesAllowed).toBe(false); expect(readiness.failures).toContain(failure === 'worker_identity_mismatch' ? 'worker_stale' : failure);
    await f.controller.approve();
    expect((await f.submission.store.load(id)).operation).toBeNull();
    expect(f.broadcasts).toHaveLength(0); expect(f.signer.secret).not.toHaveBeenCalled();
    await f.controller.refresh(); expect(f.controller.getSnapshot().attempt?.status).toBe('prepared');
    expect((await f.submission.campaigns.inspectCampaign(f.campaign.id)).reservedNative).toBe(f.snapshot.quote.totalPerPass);
    expect(f.network).not.toHaveBeenCalled();
  });

  it('rejects mismatched custody before a second worker can claim or change queued work', async () => {
    const f = await fixture(); await f.heartbeat();
    const id = await f.prepare(); await f.controller.approve();
    const wrongConfig = { ...f.config, attemptEncryptionKey: randomBytes(32).toString('base64') };
    const wrongWorker = createWorkerRuntime(db.pool, wrongConfig, f.signer, f.ports);
    await expect(wrongWorker.service.processOne()).rejects.toMatchObject({ code: 'policy_changed' });
    expect((await f.submission.store.load(id)).operation?.status).toBe('signing');
    expect(f.signer.secret).not.toHaveBeenCalled();
    await f.tick(f.worker(), id); await f.tick(f.worker(), id);
    expect((await f.api.attempt(id)).status).toBe('complete');
    expect(f.broadcasts).toHaveLength(1);
  });

  it('blocks quote preparation when no matching execution worker is available', async () => {
    const f = await fixture();
    await f.controller.restore(); await f.controller.exchange(f.invitation.token); f.controller.continueFromWallet();
    f.controller.editName('notready'); await f.controller.checkName();
    expect(f.controller.getSnapshot().quote).toBeNull();
    expect(f.controller.getSnapshot().error).not.toBeNull();
    expect((await db.pool.query('SELECT id FROM quotes WHERE campaign_id=$1', [f.campaign.id])).rows).toHaveLength(0);
    expect(f.broadcasts).toHaveLength(0);
  });

  it('refuses to adopt unknown custody for existing encrypted preparations', async () => {
    const f = await fixture(); await f.heartbeat();
    const id = await f.prepare();
    await db.pool.query('DELETE FROM app_metadata WHERE key=$1', [`execution_identity:${f.config.sponsorPublicKey}`]);
    await expect(f.submission.assertRuntime()).rejects.toMatchObject({ code: 'policy_changed' });
    expect((await f.submission.store.load(id)).operation).toBeNull();
  });
});
