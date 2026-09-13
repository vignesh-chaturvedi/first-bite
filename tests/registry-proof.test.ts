import { address, getTransactionDecoder, lamports } from '@solana/kit';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { describe, expect, it } from 'vitest';
import { PROGRAM_ID, configPda, decodeDomain, decodePrimary, domainPda, primaryPda, registrationPrice, setPrimaryDomainIx, transferDomainIx } from '../src/lib/cookie/registry.js';
import { buildSponsoredTransaction, unsignedBytes } from '../src/lib/cookie/transaction.js';
import { account, balance, localRegistry, replaceData, requireSuccess } from './helpers/local-registry.js';

describe('actual deployed registry in a local VM', () => {
  it.each([4, 32])('completes registration, transfer and primary for a zero-balance user (%i-byte name)', (length) => {
    const proof = localRegistry();
    const { svm, user, sponsor, attempt, config, snapshot } = proof;
    const name = 'a'.repeat(length);
    const sponsorBefore = balance(svm, sponsor.publicKey);
    const receiverBefore = balance(svm, config.feeReceiver);
    expect(account(svm, attempt.publicKey)).toBeNull();
    expect(account(svm, primaryPda(attempt.publicKey))).toBeNull();
    expect(balance(svm, user.publicKey)).toBe(0n);
    const result = requireSuccess(proof.send(proof.build(name)));
    expect(result.computeUnitsConsumed()).toBeLessThan(200_000n);
    expect(decodeDomain(account(svm, domainPda(name))!, name).owner.equals(user.publicKey)).toBe(true);
    expect(decodePrimary(account(svm, primaryPda(user.publicKey))!, user.publicKey).name).toBe(name);
    expect(balance(svm, attempt.publicKey)).toBe(0n);
    expect(balance(svm, user.publicKey)).toBe(0n);
    expect(balance(svm, config.feeReceiver) - receiverBefore).toBe(BigInt(snapshot.quote.price));
    expect(sponsorBefore - balance(svm, sponsor.publicKey)).toBe(BigInt(snapshot.quote.totalPerPass) - BigInt(snapshot.quote.recoveryAllowance));
  });

  it('a price increase cannot consume the user\'s pre-existing funds; rollback retains only sponsor fee', () => {
    const proof = localRegistry();
    const { svm, sponsor, attempt, user, snapshot } = proof;
    const userFunds = 5_000_000_000n;
    svm.setAccount({ address: address(user.publicKey.toBase58()), programAddress: address(SystemProgram.programId.toBase58()), executable: false, data: new Uint8Array(), space: 0n, lamports: lamports(userFunds) });
    const tx = proof.build();
    const data = Buffer.from(account(svm, configPda())!.data);
    data.writeBigUInt64LE(proof.config.longNameUsdCents + 1n, 88);
    replaceData(svm, configPda(), data);
    const before = balance(svm, sponsor.publicKey);
    expect(proof.send(tx)).toBeInstanceOf(FailedTransactionMetadata);
    expect(balance(svm, user.publicKey)).toBe(userFunds);
    expect(balance(svm, attempt.publicKey)).toBe(0n);
    expect(account(svm, domainPda('firstbite-proof'))).toBeNull();
    expect(account(svm, primaryPda(user.publicKey))).toBeNull();
    expect(before - balance(svm, sponsor.publicKey)).toBe(BigInt(snapshot.quote.messageFee));
  });

  it('a lower execution price leaves an explicit sponsor-owned residual in A', () => {
    const proof = localRegistry();
    const tx = proof.build();
    const data = Buffer.from(account(proof.svm, configPda())!.data);
    data.writeBigUInt64LE(proof.config.longNameUsdCents - 1n, 88);
    replaceData(proof.svm, configPda(), data);
    requireSuccess(proof.send(tx));
    expect(balance(proof.svm, proof.attempt.publicKey)).toBe(100_000_000_000n);
    expect(balance(proof.svm, proof.user.publicKey)).toBe(0n);
    expect(decodeDomain(account(proof.svm, domainPda('firstbite-proof'))!, 'firstbite-proof').owner.equals(proof.user.publicKey)).toBe(true);
  });

  it('the deployed program agrees with floor division for a non-divisible quote', () => {
    const proof = localRegistry();
    const data = Buffer.from(account(proof.svm, configPda())!.data);
    data.writeBigUInt64LE(101n, 72);
    replaceData(proof.svm, configPda(), data);
    proof.config.cookUsdPriceMicro = 101n;
    const before = balance(proof.svm, proof.config.feeReceiver);
    requireSuccess(proof.send(proof.build()));
    expect(balance(proof.svm, proof.attempt.publicKey)).toBe(0n);
    expect(balance(proof.svm, proof.config.feeReceiver) - before).toBe(registrationPrice(proof.config, 'firstbite-proof'));
  });

  it('an already-taken name fails atomically and preserves its original owner', () => {
    const proof = localRegistry();
    requireSuccess(proof.send(proof.build()));
    const otherAttempt = Keypair.generate();
    const otherUser = Keypair.generate();
    const before = balance(proof.svm, proof.sponsor.publicKey);
    const tx = buildSponsoredTransaction({ label: 'firstbite-proof', sponsor: proof.sponsor.publicKey, attemptPayer: otherAttempt.publicKey, user: otherUser.publicKey, feeReceiver: proof.config.feeReceiver, registrationPrice: BigInt(proof.snapshot.quote.price), domainRent: BigInt(proof.snapshot.quote.domainRent), primaryRent: BigInt(proof.snapshot.quote.primaryRent), blockhash: proof.svm.latestBlockhash() });
    tx.partialSign(proof.sponsor, otherAttempt, otherUser);
    expect(proof.svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()))).toBeInstanceOf(FailedTransactionMetadata);
    expect(balance(proof.svm, otherAttempt.publicKey)).toBe(0n);
    expect(balance(proof.svm, otherUser.publicKey)).toBe(0n);
    expect(before - balance(proof.svm, proof.sponsor.publicKey)).toBe(BigInt(proof.snapshot.quote.messageFee));
    expect(decodeDomain(account(proof.svm, domainPda('firstbite-proof'))!, 'firstbite-proof').owner.equals(proof.user.publicKey)).toBe(true);
  });

  it.each(['transfer', 'primary'] as const)('rejects an incorrect %s owner and rolls back registration', (part) => {
    const proof = localRegistry();
    const tx = proof.build();
    if (part === 'transfer') tx.instructions[3] = transferDomainIx({ label: 'firstbite-proof', currentOwner: proof.sponsor.publicKey, newOwner: proof.user.publicKey });
    else tx.instructions[5] = setPrimaryDomainIx({ label: 'firstbite-proof', owner: proof.sponsor.publicKey });
    // Recompute signer slots after deliberately replacing an instruction.
    tx.signatures = [];
    // U ceases to be a required signer in the altered primary variant.
    tx.partialSign(proof.sponsor, proof.attempt);
    if (part === 'transfer') tx.partialSign(proof.user);
    expect(proof.svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()))).toBeInstanceOf(FailedTransactionMetadata);
    expect(account(proof.svm, domainPda('firstbite-proof'))).toBeNull();
    expect(balance(proof.svm, proof.user.publicKey)).toBe(0n);
  });

  it('signature verification rejects a forged user signature before registration', () => {
    const proof = localRegistry();
    const tx = proof.build();
    tx.partialSign(proof.sponsor, proof.attempt, proof.user);
    tx.signatures.find(({ publicKey }) => publicKey.equals(proof.user.publicKey))!.signature = Buffer.alloc(64, 1);
    const result = proof.svm.sendTransaction(getTransactionDecoder().decode(unsignedBytes(tx)));
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect(account(proof.svm, domainPda('firstbite-proof'))).toBeNull();
    expect(balance(proof.svm, proof.user.publicKey)).toBe(0n);
  });

  it('reuses a valid cleared primary record without transferring extra rent to U', () => {
    const proof = localRegistry();
    const primary = primaryPda(proof.user.publicKey);
    const data = Buffer.alloc(77);
    Buffer.from([231, 255, 61, 63, 142, 184, 254, 42]).copy(data);
    proof.user.publicKey.toBuffer().copy(data, 8);
    data[44] = PublicKey.findProgramAddressSync([Buffer.from('primary'), proof.user.publicKey.toBuffer()], PROGRAM_ID)[1];
    proof.svm.setAccount({ address: address(primary.toBase58()), programAddress: address(PROGRAM_ID.toBase58()), executable: false, lamports: lamports(BigInt(proof.snapshot.quote.primaryRent)), space: 77n, data });
    const tx = proof.build();
    tx.instructions.splice(4, 1);
    tx.signatures = [];
    requireSuccess(proof.send(tx));
    expect(decodePrimary(account(proof.svm, primary)!, proof.user.publicKey).name).toBe('firstbite-proof');
    expect(balance(proof.svm, proof.user.publicKey)).toBe(0n);
  });

  it('the deployed program rejects a malformed name even if client validation is bypassed', () => {
    const proof = localRegistry();
    const tx = proof.build('aaaa');
    const invalidPda = PublicKey.findProgramAddressSync([Buffer.from('domain'), Buffer.from('-aaa')], PROGRAM_ID)[0];
    tx.instructions[2]!.data.write('-aaa', 12, 'ascii');
    tx.instructions[2]!.keys[1]!.pubkey = invalidPda;
    tx.instructions[3]!.keys[0]!.pubkey = invalidPda;
    tx.instructions[5]!.keys[1]!.pubkey = invalidPda;
    tx.signatures = [];
    expect(proof.send(tx)).toBeInstanceOf(FailedTransactionMetadata);
    expect(account(proof.svm, invalidPda)).toBeNull();
    expect(balance(proof.svm, proof.attempt.publicKey)).toBe(0n);
    expect(balance(proof.svm, proof.user.publicKey)).toBe(0n);
  });
});
