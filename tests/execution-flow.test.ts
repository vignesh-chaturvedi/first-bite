import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getTransactionDecoder } from '@solana/kit';
import { Transaction } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../src/db/url';
import { CampaignStore } from '../src/lib/campaigns/store';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { configPda, decodeDomain, decodePrimary, domainPda, primaryPda } from '../src/lib/cookie/registry';
import { unsignedBytes } from '../src/lib/cookie/transaction';
import { openPayload } from '../src/lib/execution/crypto';
import { ExecutionService } from '../src/lib/execution/service';
import { ExecutionStore } from '../src/lib/execution/store';
import type { ExecutionChain, ExecutionObservation, FinalizedReceipt } from '../src/lib/execution/types';
import { sealAttemptKey } from '../src/lib/security/attempt-key';
import { prepareSponsoredQuote } from '../src/lib/transactions/quote';
import { account, balance, localRegistry, replaceData } from './helpers/local-registry';

const databaseUrl = process.env.DATABASE_TEST_URL;
describe.skipIf(!databaseUrl)('durable execution with PostgreSQL and the reviewed registry ELF', () => {
  const schema = `first_bite_flow_${randomBytes(8).toString('hex')}`;
  let admin: ReturnType<typeof createDatabase>;
  let db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    assertLocalFixtureUrl(databaseUrl!, 'test');
    const url = parseDatabaseUrl(databaseUrl);
    if (url.pathname !== '/first_bite_test') throw new Error('Dedicated test database required');
    admin = createDatabase(databaseUrl!); await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options',`-c search_path=${schema}`);
    await migrateDatabase(url.toString(),{ migrationsSchema:`${schema}_migrations` }); db=createDatabase(url.toString());
  });
  afterAll(async () => {
    await db?.pool.end();
    if (admin) { await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}_migrations" CASCADE`); await admin.pool.end(); }
  });

  async function fixture() {
    const proof=localRegistry(); const { svm,sponsor,user,attempt,snapshot }=proof;
    const wrappingKey=randomBytes(32).toString('base64');
    const campaigns=new CampaignStore(db.pool); const store=new ExecutionStore(db.pool);
    const c=await campaigns.createCampaign({ slug:`flow-${randomBytes(6).toString('hex')}`,name:'Local durable execution',startsAt:new Date(Date.now()-60_000),endsAt:new Date(Date.now()+3_600_000),maxUsers:1,
      capNative:BigInt(snapshot.quote.totalPerPass),sponsorPublicKey:sponsor.publicKey.toBase58(),
      limits:{ maxRegistrationPrice:BigInt(snapshot.quote.price),maxTransactionFee:15_000n,recoveryAllowance:15_000n,maxReservation:BigInt(snapshot.quote.totalPerPass) } });
    await campaigns.setCampaignStatus(c.id,'active');
    const invite=await campaigns.issueInvite({ campaignId:c.id,wallet:user.publicKey.toBase58(),expiresAt:new Date(Date.now()+1_800_000) });
    const session=await campaigns.exchangeInvite(invite.token);
    const id=randomUUID(); const quote=await prepareSponsoredQuote({ name:`flow${randomBytes(5).toString('hex')}`,sponsor:sponsor.publicKey,user:user.publicKey,attemptPayer:attempt.publicKey },{
      observe:async (input)=>({ ...input,feeReceiver:proof.config.feeReceiver,registrationPrice:BigInt(snapshot.quote.price),domainRent:policy.domainRent,primaryRent:policy.primaryRent,
        sponsorBalance:balance(svm,sponsor.publicKey),userBalance:balance(svm,user.publicKey),blockhash:svm.latestBlockhash(),lastValidBlockHeight:1000,observedSlot:100,blockhashContextSlot:100,observedAtMs:Date.now(),
        genesisHash:policy.genesisHash,configSha256:policy.configSha256,programSha256:policy.programSha256,policyId:policy.id }),getMessageFee:async()=>15_000n,
    },c.limits);
    await campaigns.saveQuote(session.sessionToken,{ id,quote,encryptedPayerKey:sealAttemptKey(attempt.secretKey,wrappingKey,id,attempt.publicKey.toBase58()) });
    await campaigns.reserveAttempt(session.sessionToken,{ quoteId:id,idempotencyKey:randomUUID() });
    const walletTx=Transaction.from(Buffer.from(quote.unsignedTransactionBase64,'base64')); walletTx.partialSign(user);
    const userSigned=unsignedBytes(walletTx).toString('base64');
    const receipts=new Map<string,FinalizedReceipt>(); const broadcasts:string[]=[];
    const controls={ timeout:false, missing:false, confirmed:false, height:900, priceChange:0n, corruption:false };
    const chain:ExecutionChain={
      preflight:vi.fn(async()=>({ checkedAtMs:Date.now(),slot:100,blockHeight:900,fee:15_000n,sponsorBalance:balance(svm,sponsor.publicKey) })),
      broadcast:vi.fn(async (bytes)=>{
        const tx=Transaction.from(Buffer.from(bytes,'base64')); const hash=createHash('sha256').update(tx.serializeMessage()).digest('hex');
        const persisted=(await db.pool.query('SELECT id,signature,encrypted_signed_payload FROM execution_operations WHERE message_hash=$1',[hash])).rows[0];
        expect(persisted).toBeDefined();
        expect(openPayload(persisted.encrypted_signed_payload,wrappingKey,persisted.id,'signed')).toBe(bytes);
        broadcasts.push(bytes);
        if (!receipts.has(persisted.signature)) {
          if (controls.priceChange!==0n && tx.signatures.length===3) {
            const data=Buffer.from(account(svm,configPda())!.data); data.writeBigUInt64LE(proof.config.longNameUsdCents+controls.priceChange,88); replaceData(svm,configPda(),data);
          }
          const keys=tx.compileMessage().accountKeys; const pre=keys.map((key)=>balance(svm,key));
          const result=svm.sendTransaction(getTransactionDecoder().decode(Buffer.from(bytes,'base64')));
          receipts.set(persisted.signature,{ signedBase64:bytes,slot:110,fee:BigInt(tx.signatures.length)*5000n,failed:result instanceof FailedTransactionMetadata,
            accountKeys:keys.map((key)=>key.toBase58()),preBalances:pre,postBalances:keys.map((key)=>balance(svm,key)) });
        }
        if (controls.timeout) throw new Error('Synthetic lost send response');
        return persisted.signature;
      }),
      observe:vi.fn(async (op)=>{
        let receipt=op.signature ? receipts.get(op.signature) ?? null : null;
        if (controls.missing || controls.confirmed) receipt=null;
        if (receipt && controls.corruption) receipt={...receipt,fee:receipt.fee+1n};
        const domain=account(svm,domainPda(quote.name)); const primary=account(svm,primaryPda(user.publicKey));
        return { finalizedBlockHeight:controls.height,status:controls.confirmed && receipts.size ? 'confirmed' : receipt ? 'finalized' : 'missing',receipt,accountSlot:111,payerBalance:balance(svm,attempt.publicKey),
          domainOwner:domain?decodeDomain(domain,quote.name).owner.toBase58():null,primaryOwner:primary?decodePrimary(primary,user.publicKey).owner.toBase58():null,
          primaryName:primary?decodePrimary(primary,user.publicKey).name:null } satisfies ExecutionObservation;
      }),
      prepareRecovery:vi.fn(async()=>({ blockhash:svm.latestBlockhash(),lastValidBlockHeight:1000,observedSlot:111,fee:10_000n,preparedAtMs:Date.now() })),
    };
    const admission = vi.fn(async () => ({ scope: 'sponsorship' as const, campaignId: c.id, checkedAtMs: Date.now(), newSignaturesAllowed: true, canPrepare: false, failures: [] }));
    const deps={ store,campaigns,chain,admission,signer:{ publicKey:sponsor.publicKey.toBase58(),secret:()=>sponsor.secretKey },wrappingKey };
    const service=new ExecutionService(deps);
    async function ready() { await db.pool.query('UPDATE execution_jobs SET next_run_at=clock_timestamp() WHERE operation_id IN (SELECT id FROM execution_operations WHERE attempt_id=$1)',[id]); }
    async function process() { await ready(); await service.processOne((await store.load(id)).operation?.id); }
    return { ...proof,id,c,quote,token:session.sessionToken,invite,store,campaigns,service,deps,userSigned,controls,broadcasts,chain,receipts,ready,process };
  }

  it('blocks authorization when operations are unhealthy and resumes the same prepared attempt', async () => {
    const f = await fixture();
    f.deps.admission.mockResolvedValueOnce({ scope: 'sponsorship', campaignId: f.c.id, checkedAtMs: Date.now(), newSignaturesAllowed: false, canPrepare: false, failures: [] });
    await expect(f.service.submit(f.token, f.id, f.userSigned)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await f.store.load(f.id)).operation).toBeNull();
    expect(f.broadcasts).toHaveLength(0);
    expect((await f.campaigns.inspectCampaign(f.c.id)).reservedNative).toBe(f.quote.cost.maximumReservation);
    await f.service.submit(f.token, f.id, f.userSigned);
    expect((await f.store.load(f.id)).operation?.status).toBe('signing');
  });
  it.each(['missing', 'rejected', 'stale', 'future', 'wrong-campaign'] as const)('rejects %s operational admission evidence', async (mode) => {
    const f = await fixture();
    if (mode === 'missing') Object.assign(f.deps, { admission: undefined });
    else if (mode === 'rejected') f.deps.admission.mockRejectedValueOnce(new Error('private probe failure'));
    else f.deps.admission.mockResolvedValueOnce({ scope: 'sponsorship', campaignId: mode === 'wrong-campaign' ? randomUUID() : f.c.id,
      checkedAtMs: Date.now() + (mode === 'future' ? 60_000 : -6_000), newSignaturesAllowed: true, canPrepare: false, failures: [] });
    await expect(f.service.submit(f.token, f.id, f.userSigned)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await f.store.load(f.id)).operation).toBeNull(); expect(f.broadcasts).toHaveLength(0);
  });
  it('keeps authorized reconciliation running after admission health fails', async () => {
    const f = await fixture(); await f.service.submit(f.token, f.id, f.userSigned);
    f.deps.admission.mockRejectedValue(new Error('Synthetic readiness outage'));
    await f.service.submit(f.token, f.id, f.userSigned);
    await f.process(); await f.process();
    expect(f.deps.admission).toHaveBeenCalledTimes(1);
    expect((await f.store.status(f.id)).status).toBe('complete');
    expect(f.broadcasts).toHaveLength(1);
  });

  it('commits before sending, survives lost response and restart, and settles once after finality',async()=>{
    const f=await fixture(); f.controls.timeout=true;
    expect((await f.service.submit(f.token,f.id,f.userSigned)).status).toBe('signing');
    expect(f.broadcasts).toHaveLength(0);
    await f.process(); expect((await f.store.status(f.id)).status).toBe('broadcast_unknown');
    expect(f.broadcasts).toHaveLength(1);
    const restarted=new ExecutionService(f.deps); await f.ready(); await restarted.processOne((await f.store.load(f.id)).operation!.id);
    expect(await f.store.status(f.id)).toMatchObject({ status:'complete',actualCostNative:f.quote.cost.maxSponsorDebit,residualNative:'0' });
    expect((await f.campaigns.inspectCampaign(f.c.id))).toMatchObject({ reservedNative:'0',spentNative:f.quote.cost.maxSponsorDebit,reservedUsers:0,consumedUsers:1 });
    expect((await f.store.load(f.id)).encryptedPayerKey).toBeNull();
    await f.service.submit(f.token,f.id,f.userSigned); expect(await restarted.processOne((await f.store.load(f.id)).operation!.id)).toBe(false);
    expect(f.broadcasts).toHaveLength(1);
  });
  it('does not broadcast when signed-payload persistence fails',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned);
    const original=f.store.persistSigned.bind(f.store);
    const fail=vi.spyOn(f.store,'persistSigned').mockRejectedValueOnce(new Error('Synthetic database loss'));
    await f.process(); expect(f.broadcasts).toHaveLength(0); expect((await f.store.status(f.id)).status).toBe('signing');
    fail.mockImplementation(original); await f.process(); expect(f.broadcasts).toHaveLength(1);
  });
  it('rejects a changed or forged wallet message before preflight and authorization',async()=>{
    const f=await fixture();
    const changed=Buffer.from(f.userSigned,'base64'); changed[1]=changed[1]!^1;
    await expect(f.service.submit(f.token,f.id,changed.toString('base64'))).rejects.toMatchObject({code:'signature_invalid'});
    expect(f.chain.preflight).not.toHaveBeenCalled();
    expect((await f.store.load(f.id)).operation).toBeNull();
    expect(f.broadcasts).toHaveLength(0);
  });
  it('serializes overlapping workers so only one can sign and broadcast the operation',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned);
    const op=(await f.store.load(f.id)).operation!;
    const outcomes=await Promise.all([f.service.processOne(op.id),new ExecutionService(f.deps).processOne(op.id)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1); expect(f.broadcasts).toHaveLength(1);
  });
  it('keeps an expired signing authorization in review instead of expiring its reservation',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned);
    const delayed=new ExecutionService({...f.deps,now:()=>f.quote.expiresAtMs+1});
    await delayed.processOne((await f.store.load(f.id)).operation!.id);
    expect((await f.store.status(f.id)).status).toBe('manual_review'); expect(f.broadcasts).toHaveLength(0);
    expect((await f.campaigns.inspectCampaign(f.c.id)).reservedNative).toBe(f.quote.cost.maximumReservation);
  });
  it('recovers after a lost commit acknowledgement without creating another signature',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned);
    const original=f.store.persistSigned.bind(f.store);
    const fail=vi.spyOn(f.store,'persistSigned').mockImplementationOnce(async(...args)=>{ await original(...args); throw new Error('Lost commit acknowledgement'); });
    await f.process(); expect(f.broadcasts).toHaveLength(0); expect((await f.store.status(f.id)).status).toBe('signed');
    fail.mockRestore(); await f.process(); expect(f.broadcasts).toHaveLength(1);
  });
  it('rebroadcasts identical persisted bytes while history is absent, then holds after expiry',async()=>{
    const f=await fixture(); f.controls.missing=true; await f.service.submit(f.token,f.id,f.userSigned);
    await f.process(); await f.process(); expect(f.broadcasts).toHaveLength(2); expect(f.broadcasts[0]).toBe(f.broadcasts[1]);
    f.controls.height=1001; await f.process(); expect((await f.store.status(f.id)).status).toBe('manual_review');
    expect((await f.campaigns.inspectCampaign(f.c.id)).reservedNative).toBe(f.quote.cost.maximumReservation);
    expect(await f.campaigns.expireUnsigned(f.id)).toBe(false);
    f.controls.missing=false; await f.service.retry(f.token,f.id); await f.process(); expect((await f.store.status(f.id)).status).toBe('complete');
  });
  it('allows an authorized signing job to finish after campaign pause',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned); await f.campaigns.setCampaignStatus(f.c.id,'paused');
    await f.process(); await f.process(); expect((await f.store.status(f.id)).status).toBe('complete');
  });
  it('does not settle a confirmed error and charges only its finalized failed fee',async()=>{
    const f=await fixture(); f.controls.priceChange=1n; f.controls.confirmed=true;
    await f.service.submit(f.token,f.id,f.userSigned); await f.process(); await f.process();
    expect((await f.store.status(f.id)).status).toBe('confirmed');
    expect((await f.campaigns.inspectCampaign(f.c.id)).spentNative).toBe('0');
    f.controls.confirmed=false; await f.process();
    expect((await f.store.status(f.id))).toMatchObject({ status:'failed',actualCostNative:'15000' });
    expect((await f.campaigns.inspectCampaign(f.c.id))).toMatchObject({ reservedNative:'0',spentNative:'15000',consumedUsers:0 });
    expect(balance(f.svm,f.user.publicKey)).toBe(0n);
  });
  it('reserves recovery, persists its separate signed sweep and credits only the finalized refund',async()=>{
    const f=await fixture(); f.controls.priceChange=-1n;
    const before=balance(f.svm,f.sponsor.publicKey);
    await f.service.submit(f.token,f.id,f.userSigned); await f.process(); await f.process();
    const residual=balance(f.svm,f.attempt.publicKey); expect(residual).toBeGreaterThan(0n);
    expect((await f.store.status(f.id)).status).toBe('finalized');
    expect((await f.campaigns.inspectCampaign(f.c.id)).reservedNative).toBe('15000');
    // Simulate a restart in the settlement→recovery gap: scanning durable attempts recovers it.
    expect(await f.store.pendingRecoveries()).toContain(f.id); await f.service.recover(f.id);
    const recovery=(await db.pool.query("SELECT id FROM execution_operations WHERE attempt_id=$1 AND kind='recovery'",[f.id])).rows[0].id;
    await f.service.processOne(recovery); expect((await f.campaigns.inspectCampaign(f.c.id)).spentNative).toBe(f.quote.cost.maxSponsorDebit);
    await f.ready(); await f.service.processOne(recovery);
    const cost=BigInt(f.quote.cost.maxSponsorDebit)+10_000n-residual;
    expect((await f.store.status(f.id))).toMatchObject({ status:'complete',actualCostNative:cost.toString(),residualNative:'0' });
    expect((await f.campaigns.inspectCampaign(f.c.id))).toMatchObject({ reservedNative:'0',spentNative:cost.toString(),consumedUsers:1 });
    expect(before-balance(f.svm,f.sponsor.publicKey)).toBe(cost); expect(balance(f.svm,f.attempt.publicKey)).toBe(0n);
    expect((await f.store.load(f.id)).encryptedPayerKey).toBeNull();
  });
  it('holds budget when a finalized receipt has inconsistent fee/account evidence',async()=>{
    const f=await fixture(); await f.service.submit(f.token,f.id,f.userSigned); await f.process(); f.controls.corruption=true; await f.process();
    expect((await f.store.status(f.id)).status).toBe('manual_review');
    expect((await f.campaigns.inspectCampaign(f.c.id))).toMatchObject({ spentNative:'0',reservedNative:f.quote.cost.maximumReservation });
  });
});
