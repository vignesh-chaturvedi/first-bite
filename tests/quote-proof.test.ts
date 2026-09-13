import { createHash } from 'node:crypto';
import { address, getTransactionDecoder, lamports } from '@solana/kit';
import { SystemProgram, Transaction } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { describe, expect, it } from 'vitest';
import type { RegistryClient } from '../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY } from '../src/lib/chain/policy';
import {
  DOMAIN_SIZE, PRIMARY_SIZE, configPda, decodeConfig, decodeDomain, decodePrimary,
  domainPda, primaryPda, registrationPrice,
} from '../src/lib/cookie/registry';
import { unsignedBytes, validateUserSignature } from '../src/lib/cookie/transaction';
import { prepareSponsoredQuote, type SponsoredQuote } from '../src/lib/transactions/quote';
import { account, balance, localRegistry, replaceData, requireSuccess } from './helpers/local-registry';

type LocalProof = ReturnType<typeof localRegistry>;

/** An in-process observation adapter: no RPC, wallet, chain finality or broadcast. */
async function prepareLocalQuote(proof: LocalProof, name: string): Promise<SponsoredQuote> {
  const { svm, snapshot, sponsor, user, attempt } = proof;
  const observedAtMs = Number(svm.getClock().unixTimestamp) * 1_000;
  const observedSlot = Number(svm.getClock().slot);
  const client: RegistryClient = {
    async observe(input) {
      expect(input.sponsor.equals(sponsor.publicKey)).toBe(true);
      expect(input.user.equals(user.publicKey)).toBe(true);
      expect(input.attemptPayer.equals(attempt.publicKey)).toBe(true);
      expect(account(svm, domainPda(input.label))).toBeNull();
      expect(account(svm, primaryPda(user.publicKey))).toBeNull();
      expect(account(svm, attempt.publicKey)).toBeNull();
      const configAccount = account(svm, configPda())!;
      const config = decodeConfig(configAccount);
      const configSha256 = createHash('sha256').update(configAccount.data).digest('hex');
      expect(configSha256).toBe(COOKIE_REGISTRY_POLICY.configSha256);
      expect(snapshot.programData.elfSha256).toBe(COOKIE_REGISTRY_POLICY.programSha256);
      expect(snapshot.genesisHash).toBe(COOKIE_REGISTRY_POLICY.genesisHash);
      return {
        ...input, feeReceiver: config.feeReceiver,
        registrationPrice: registrationPrice(config, input.label),
        domainRent: svm.minimumBalanceForRentExemption(BigInt(DOMAIN_SIZE)),
        primaryRent: svm.minimumBalanceForRentExemption(BigInt(PRIMARY_SIZE)),
        sponsorBalance: balance(svm, sponsor.publicKey), blockhash: svm.latestBlockhash(),
        // A fixture lease only; this proof does not establish live block-height expiry.
        lastValidBlockHeight: snapshot.quote.lastValidBlockHeight,
        observedSlot, blockhashContextSlot: observedSlot, observedAtMs,
        genesisHash: snapshot.genesisHash, configSha256,
        programSha256: snapshot.programData.elfSha256, policyId: COOKIE_REGISTRY_POLICY.id,
      };
    },
    async getMessageFee(message, minContextSlot) {
      expect(minContextSlot).toBe(observedSlot);
      expect(message.header.numRequiredSignatures).toBe(3);
      return BigInt(snapshot.quote.messageFee);
    },
  };
  return prepareSponsoredQuote({ name, sponsor: sponsor.publicKey, user: user.publicKey, attemptPayer: attempt.publicKey }, client, {
    maxRegistrationPrice: BigInt(snapshot.quote.price), maxTransactionFee: BigInt(snapshot.quote.messageFee),
    recoveryAllowance: BigInt(snapshot.quote.recoveryAllowance), maxReservation: BigInt(snapshot.quote.totalPerPass), ttlMs: 30_000,
  }, () => observedAtMs);
}

function signQuote(proof: LocalProof, quote: SponsoredQuote): Transaction {
  const prepared = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
  expect(prepared.signatures).toHaveLength(3);
  expect(prepared.signatures.every(({ signature }) => signature === null)).toBe(true);
  const transaction = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
  transaction.partialSign(proof.user);
  const signed = validateUserSignature(prepared, unsignedBytes(transaction), proof.user.publicKey);
  const userSignature = Buffer.from(signed.signatures.find(({ publicKey }) => publicKey.equals(proof.user.publicKey))!.signature!);
  signed.partialSign(proof.sponsor, proof.attempt);
  expect(signed.verifySignatures()).toBe(true);
  expect(signed.signatures.find(({ publicKey }) => publicKey.equals(proof.user.publicKey))!.signature).toEqual(userSignature);
  expect(signed.serializeMessage().toString('base64')).toBe(quote.messageBase64);
  expect(createHash('sha256').update(signed.serializeMessage()).digest('hex')).toBe(quote.messageSha256);
  return signed;
}

function setUserFunds(proof: LocalProof, amount: bigint): void {
  if (amount === 0n) return;
  proof.svm.setAccount({ address: address(proof.user.publicKey.toBase58()), programAddress: address(SystemProgram.programId.toBase58()),
    executable: false, data: new Uint8Array(), space: 0n, lamports: lamports(amount) });
}

describe('prepared quote execution against the pinned registry in a local VM', () => {
  it.each([0n, 5_000_000_000n])('executes the exact quoted message and preserves user funds (%s base units)', async (userFunds) => {
    const proof = localRegistry();
    const { svm, sponsor, user, attempt, config } = proof;
    setUserFunds(proof, userFunds);
    const sponsorBefore = balance(svm, sponsor.publicKey);
    const receiverBefore = balance(svm, config.feeReceiver);
    const quote = await prepareLocalQuote(proof, 'firstbite-quote');
    // Preparation itself has no account or balance side effects.
    expect(balance(svm, sponsor.publicKey)).toBe(sponsorBefore);
    expect(balance(svm, user.publicKey)).toBe(userFunds);
    const signed = signQuote(proof, quote);
    const result = requireSuccess(svm.sendTransaction(getTransactionDecoder().decode(signed.serialize())));
    expect(Buffer.from(result.signature())).toEqual(signed.signature);
    expect(result.computeUnitsConsumed()).toBeLessThan(200_000n);
    expect(decodeDomain(account(svm, domainPda(quote.name))!, quote.name).owner.toBase58()).toBe(quote.expected.owner);
    expect(decodePrimary(account(svm, primaryPda(user.publicKey))!, user.publicKey).name).toBe(quote.expected.primaryName);
    expect(balance(svm, domainPda(quote.name))).toBe(BigInt(quote.cost.domainRent));
    expect(balance(svm, primaryPda(user.publicKey))).toBe(BigInt(quote.cost.primaryRent));
    expect(balance(svm, user.publicKey)).toBe(userFunds);
    expect(balance(svm, attempt.publicKey)).toBe(0n);
    expect(balance(svm, config.feeReceiver) - receiverBefore).toBe(BigInt(quote.cost.registrationPrice));
    expect(sponsorBefore - balance(svm, sponsor.publicKey)).toBe(BigInt(quote.cost.maxSponsorDebit));
    expect(BigInt(quote.cost.maximumReservation) - BigInt(quote.cost.maxSponsorDebit)).toBe(BigInt(quote.cost.recoveryAllowance));
  });

  it('rolls back a price increase after preparation and charges only the sponsor fee', async () => {
    const proof = localRegistry();
    const { svm, sponsor, user, attempt, config } = proof;
    const userFunds = 5_000_000_000n;
    setUserFunds(proof, userFunds);
    const quote = await prepareLocalQuote(proof, 'firstbite-price-change');
    const signed = signQuote(proof, quote);
    const changedConfig = Buffer.from(account(svm, configPda())!.data);
    changedConfig.writeBigUInt64LE(config.longNameUsdCents + 1n, 88);
    replaceData(svm, configPda(), changedConfig);
    const sponsorBefore = balance(svm, sponsor.publicKey);
    const receiverBefore = balance(svm, config.feeReceiver);
    const result = svm.sendTransaction(getTransactionDecoder().decode(signed.serialize()));
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    if (!(result instanceof FailedTransactionMetadata)) throw new Error('Expected atomic registry failure');
    expect(Buffer.from(result.meta().signature())).toEqual(signed.signature);
    expect(account(svm, domainPda(quote.name))).toBeNull();
    expect(account(svm, primaryPda(user.publicKey))).toBeNull();
    expect(account(svm, primaryPda(attempt.publicKey))).toBeNull();
    expect(balance(svm, attempt.publicKey)).toBe(0n);
    expect(balance(svm, user.publicKey)).toBe(userFunds);
    expect(balance(svm, config.feeReceiver)).toBe(receiverBefore);
    expect(sponsorBefore - balance(svm, sponsor.publicKey)).toBe(BigInt(quote.cost.transactionFee));
    expect(account(svm, configPda())!.data).toEqual(changedConfig);
  });
});
