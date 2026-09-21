import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTransactionDecoder } from '@solana/kit';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { describe, expect, it } from 'vitest';
import type { RegistryClient } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../src/lib/chain/policy';
import { configPda, decodeConfig, decodeDomain, decodePrimary, domainPda, primaryPda, registrationPrice } from '../src/lib/cookie/registry';
import { unsignedBytes, validateUserSignature } from '../src/lib/cookie/transaction';
import type { ExecutionChain, FinalizedReceipt } from '../src/lib/execution/types';
import type { SponsorProbeSimulationConnection } from '../src/lib/operations/sponsor-probe';
import { openSmokeJournal, type SmokeJournal } from '../src/lib/smoke/journal';
import { createSmokeRunner, type SmokeRunnerState } from '../src/lib/smoke/runner';
import { account, balance, localRegistry, requireSuccess } from './helpers/local-registry';

/** The executable and balances are real local-VM evidence. Slots/finality are test adapters, not live chain evidence. */
describe('durable one-registration runner against the pinned local registry executable', () => {
  it.each([false, true])('settles one exact three-signer transaction across a journal restart (lost response: %s)', async (loseSendResponse) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'first-bite-runner-proof-')));
    const directory = join(root, 'journal'), key = randomBytes(32).toString('hex');
    let journal: SmokeJournal<SmokeRunnerState> | undefined;
    try {
      const proof = localRegistry(), { svm, sponsor, user, config, snapshot } = proof;
      const at = Number(svm.getClock().unixTimestamp) * 1_000, slot = Number(svm.getClock().slot);
      const height = snapshot.quote.lastValidBlockHeight - 10;
      const sponsorBefore = balance(svm, sponsor.publicKey), receiverBefore = balance(svm, config.feeReceiver);
      const receipts = new Map<string, FinalizedReceipt>(), walletSignatures = new Map<string, Buffer>();
      const sent: string[] = [], simulated: string[] = [];
      const registry: RegistryClient = {
        async observe(input) {
          expect(input.sponsor.equals(sponsor.publicKey)).toBe(true);
          expect(input.user.equals(user.publicKey)).toBe(true);
          expect(account(svm, input.attemptPayer)).toBeNull();
          expect(account(svm, domainPda(input.label))).toBeNull();
          expect(account(svm, primaryPda(input.user))).toBeNull();
          const rawConfig = account(svm, configPda())!, current = decodeConfig(rawConfig);
          const configSha256 = createHash('sha256').update(rawConfig.data).digest('hex');
          expect(configSha256).toBe(policy.configSha256);
          expect(snapshot.programData.elfSha256).toBe(policy.programSha256);
          return { ...input, feeReceiver: current.feeReceiver, registrationPrice: registrationPrice(current, input.label),
            domainRent: policy.domainRent, primaryRent: policy.primaryRent,
            sponsorBalance: balance(svm, sponsor.publicKey), userBalance: balance(svm, user.publicKey),
            blockhash: svm.latestBlockhash(), lastValidBlockHeight: snapshot.quote.lastValidBlockHeight,
            observedSlot: slot, blockhashContextSlot: slot, observedAtMs: at, genesisHash: snapshot.genesisHash,
            configSha256, programSha256: snapshot.programData.elfSha256, policyId: policy.id };
        },
        async getMessageFee(message, minContextSlot) {
          expect(message.header.numRequiredSignatures).toBe(3); expect(minContextSlot).toBe(slot);
          return BigInt(snapshot.quote.messageFee);
        },
      };
      function simulate(bytes: Uint8Array) {
        const packet = Buffer.from(bytes);
        simulated.push(packet.toString('base64'));
        expect(Transaction.from(packet).signatures.every((entry) => entry.signature === null)).toBe(true);
        svm.withSigverify(false);
        try {
          const result = svm.simulateTransaction(getTransactionDecoder().decode(packet));
          if (result instanceof FailedTransactionMetadata) throw new Error(result.toString());
          expect(balance(svm, sponsor.publicKey)).toBe(sponsorBefore);
          expect(balance(svm, config.feeReceiver)).toBe(receiverBefore);
          expect(balance(svm, user.publicKey)).toBe(0n);
          return { context: { slot }, value: { err: null, logs: result.meta().logs(), unitsConsumed: Number(result.meta().computeUnitsConsumed()) } };
        } finally { svm.withSigverify(true); }
      }
      const simulation: SponsorProbeSimulationConnection = {
        async getGenesisHash() { return snapshot.genesisHash; }, async getBlockHeight() { return height; },
        async simulateTransaction(transaction, options) {
          expect(options).toEqual({ commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: slot });
          return simulate(transaction.serialize());
        },
      };
      const chain: ExecutionChain = {
        async preflight(quote, userSigned) {
          const unsigned = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
          validateUserSignature(unsigned, Buffer.from(userSigned, 'base64'), user.publicKey);
          simulate(VersionedTransaction.deserialize(Buffer.from(quote.unsignedTransactionBase64, 'base64')).serialize());
          return { checkedAtMs: at, slot, blockHeight: height, fee: BigInt(snapshot.quote.messageFee), sponsorBalance: balance(svm, sponsor.publicKey) };
        },
        async broadcast(signedBase64) {
          // The real encrypted journal must contain the exact packet before the VM sees it.
          const durable = (await journal!.read())!;
          expect(durable.status).toBe('broadcasting');
          expect(durable.signedBase64).toBe(signedBase64);
          const transaction = Transaction.from(Buffer.from(signedBase64, 'base64'));
          expect(transaction.verifySignatures(true)).toBe(true);
          expect(transaction.signatures).toHaveLength(3);
          for (const signer of [user, sponsor]) expect(transaction.signatures.find((entry) => entry.publicKey.equals(signer.publicKey))!.signature)
            .toEqual(walletSignatures.get(signer.publicKey.toBase58()));
          expect(transaction.serializeMessage().toString('base64')).toBe(durable.candidate!.quote.messageBase64);
          const accountKeys = transaction.compileMessage().accountKeys, preBalances = accountKeys.map((entry) => balance(svm, entry));
          sent.push(signedBase64);
          const result = requireSuccess(svm.sendTransaction(getTransactionDecoder().decode(transaction.serialize())));
          expect(Buffer.from(result.signature())).toEqual(transaction.signature);
          expect(result.computeUnitsConsumed()).toBeLessThan(200_000n);
          receipts.set(durable.transactionSignature!, { signedBase64, slot: slot + 1, failed: false,
            fee: BigInt(snapshot.quote.messageFee), accountKeys: accountKeys.map((entry) => entry.toBase58()),
            preBalances, postBalances: accountKeys.map((entry) => balance(svm, entry)) });
          if (loseSendResponse) throw new Error('Synthetic lost VM response after execution');
          return durable.transactionSignature!;
        },
        async observe(operation, attempt) {
          const receipt = receipts.get(operation.signature!) ?? null;
          const domain = account(svm, domainPda(attempt.name)), primary = account(svm, primaryPda(user.publicKey));
          return { status: receipt ? 'finalized' : 'missing', finalizedBlockHeight: height + 1, accountSlot: slot + 2, receipt,
            payerBalance: balance(svm, new PublicKey(attempt.payerPublicKey)),
            domainOwner: domain ? decodeDomain(domain, attempt.name).owner.toBase58() : null,
            primaryOwner: primary ? decodePrimary(primary, user.publicKey).owner.toBase58() : null,
            primaryName: primary ? decodePrimary(primary, user.publicKey).name : null };
        },
        async prepareRecovery() { throw new Error('No recovery transaction is supported by this proof'); },
      };
      const input = { name: 'firstbite-runner-proof', sponsor: sponsor.publicKey.toBase58(), user: user.publicKey.toBase58(),
        limits: { maxRegistrationPrice: snapshot.quote.price, maxTransactionFee: '100000', recoveryAllowance: '100000', maxTotalSpend: '15001000000000' } };
      journal = await openSmokeJournal<SmokeRunnerState>(directory, key);
      const create = () => createSmokeRunner({ journal: journal!, registry, simulation, chain, now: () => at, allowLive: true });
      let runner = await create();
      const initial = await runner.initialize(input), attemptPayer = new PublicKey(initial.attemptPayer!);
      expect(account(svm, attemptPayer)).toBeNull();
      const prepared = await runner.prepare(), secret = (await journal.read())!.attemptSecretBase64!;
      let requestPacket: string | undefined;
      for (const role of ['user', 'sponsor'] as const) {
        const request = await runner.walletRequest(role);
        if (requestPacket !== undefined) expect(request.transactionBase64).toBe(requestPacket);
        requestPacket = request.transactionBase64;
        const transaction = Transaction.from(Buffer.from(request.transactionBase64, 'base64'));
        expect(transaction.signatures.every((entry) => entry.signature === null)).toBe(true);
        const signer = role === 'user' ? user : sponsor;
        transaction.partialSign(signer);
        walletSignatures.set(signer.publicKey.toBase58(), Buffer.from(transaction.signatures.find((entry) => entry.publicKey.equals(signer.publicKey))!.signature!));
        await runner.acceptSignature(role, request.id, unsignedBytes(transaction).toString('base64'));
      }
      const ack = { messageSha256: prepared.quote!.messageSha256, maxTotalSpend: input.limits.maxTotalSpend, confirmSpend: true };
      expect((await runner.submit(ack)).status).toBe(loseSendResponse ? 'broadcast_unknown' : 'submitted');
      expect(sent).toHaveLength(1);
      expect(simulated).toHaveLength(2);
      expect(simulated.every((packet) => packet === requestPacket)).toBe(true);
      for (const file of (await readdir(directory)).filter((entry) => entry.startsWith('snapshot-'))) {
        const encrypted = await readFile(join(directory, file), 'utf8');
        expect(encrypted).not.toContain(secret); expect(encrypted).not.toContain(sent[0]!);
      }
      // A clean restart authenticates disk records and retains the original transaction identity.
      await journal.close(); journal = await openSmokeJournal<SmokeRunnerState>(directory, key); runner = await create();
      expect((await runner.status()).attemptPayer).toBe(attemptPayer.toBase58());
      await runner.submit(ack); expect(sent).toHaveLength(1);
      const settled = await runner.reconcile();
      expect(settled).toMatchObject({ status: 'complete', phase0GateComplete: false, settlement: {
        success: true, fee: snapshot.quote.messageFee, debit: prepared.quote!.cost.maxSponsorDebit, residual: '0' } });
      expect(balance(svm, sponsor.publicKey)).toBe(sponsorBefore - BigInt(prepared.quote!.cost.maxSponsorDebit));
      expect(balance(svm, config.feeReceiver) - receiverBefore).toBe(BigInt(prepared.quote!.cost.registrationPrice));
      expect(balance(svm, user.publicKey)).toBe(0n); expect(balance(svm, attemptPayer)).toBe(0n);
      expect(decodeDomain(account(svm, domainPda(input.name))!, input.name).owner.equals(user.publicKey)).toBe(true);
      expect(decodePrimary(account(svm, primaryPda(user.publicKey))!, user.publicKey).name).toBe(input.name);
      expect((await journal.read())!.attemptSecretBase64).toBeNull();
      await journal.close(); journal = await openSmokeJournal<SmokeRunnerState>(directory, key); runner = await create();
      expect(await runner.reconcile()).toEqual(settled);
      expect(await runner.submit(ack)).toEqual(settled); expect(sent).toHaveLength(1);
      await expect(runner.prepare()).rejects.toMatchObject({ code: 'wrong_stage' });
    } finally { await journal?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
