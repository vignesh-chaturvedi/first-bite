import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { address, getTransactionDecoder, lamports } from '@solana/kit';
import { Keypair, PublicKey, SystemProgram, type AccountInfo, Transaction } from '@solana/web3.js';
import { FailedTransactionMetadata, LiteSVM, Rent, type TransactionMetadata } from 'litesvm';
import type { ChainSnapshot, SavedAccount } from '../../scripts/phase0/inspect-chain.js';
import { DOMAIN_SIZE, PRIMARY_SIZE, PROGRAM_ID, configPda, decodeConfig, registrationPrice } from '../../src/lib/cookie/registry.js';
import { buildSponsoredTransaction } from '../../src/lib/cookie/transaction.js';

export function loadSnapshot(): ChainSnapshot {
  return JSON.parse(readFileSync('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot;
}

function setSavedAccount(svm: LiteSVM, saved: SavedAccount): void {
  svm.setAccount({ address: address(saved.address), programAddress: address(saved.owner), executable: saved.executable, lamports: lamports(BigInt(saved.lamports)), data: Buffer.from(saved.dataBase64, 'base64'), space: BigInt(Buffer.from(saved.dataBase64, 'base64').length) });
}

export function account(svm: LiteSVM, key: PublicKey): AccountInfo<Buffer> | null {
  const value = svm.getAccount(address(key.toBase58()));
  if (!value.exists) return null;
  if (value.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Fixture balance exceeds web3 decoder boundary');
  return { data: Buffer.from(value.data), executable: value.executable, lamports: Number(value.lamports), owner: new PublicKey(value.programAddress) };
}

export function balance(svm: LiteSVM, key: PublicKey): bigint {
  return svm.getBalance(address(key.toBase58())) ?? 0n;
}

export function replaceData(svm: LiteSVM, key: PublicKey, data: Buffer): void {
  const old = svm.getAccount(address(key.toBase58()));
  if (!old.exists) throw new Error('Missing fixture account');
  svm.setAccount({ ...old, data, space: BigInt(data.length) });
}

/** Loads the real downloaded executable. All funding and config edits exist only in this VM. */
export function localRegistry() {
  const snapshot = loadSnapshot();
  let elf: Buffer;
  try { elf = readFileSync('.cache/registry.so'); }
  catch { throw new Error('Run pnpm phase0:inspect to download the pinned deployed registry before proof tests'); }
  if (createHash('sha256').update(elf).digest('hex') !== snapshot.programData.elfSha256) {
    throw new Error('Registry ELF hash does not match committed evidence');
  }
  const svm = new LiteSVM();
  const rentData = Buffer.from(snapshot.rent.dataBase64, 'base64');
  if (rentData.length !== 17) throw new Error('Unsupported rent sysvar layout');
  svm.setRent(new Rent(rentData.readBigUInt64LE(0), rentData.readDoubleLE(8), rentData[16]!));
  if (svm.minimumBalanceForRentExemption(BigInt(DOMAIN_SIZE)) !== BigInt(snapshot.quote.domainRent)
    || svm.minimumBalanceForRentExemption(BigInt(PRIMARY_SIZE)) !== BigInt(snapshot.quote.primaryRent)) {
    throw new Error('Emulator rent differs from the observed Cookie RPC quote');
  }
  svm.addProgramWithLoader(address(PROGRAM_ID.toBase58()), elf, address(snapshot.program.owner));
  const clock = svm.getClock();
  clock.slot = BigInt(snapshot.slots.programDataAndRent);
  clock.unixTimestamp = BigInt(Math.floor(Date.parse(snapshot.observedAt) / 1000));
  svm.setClock(clock);
  setSavedAccount(svm, snapshot.config);
  setSavedAccount(svm, snapshot.feeReceiver);
  const config = decodeConfig(account(svm, configPda())!);
  const sponsor = Keypair.generate();
  const attempt = Keypair.generate();
  const user = Keypair.generate();
  // This is a local account fixture. No faucet or live transaction is involved.
  svm.setAccount({ address: address(sponsor.publicKey.toBase58()), programAddress: address(SystemProgram.programId.toBase58()), executable: false, lamports: lamports(1_000_000_000_000_000n), data: new Uint8Array(), space: 0n });
  const build = (label = 'firstbite-proof') => buildSponsoredTransaction({ label, sponsor: sponsor.publicKey, attemptPayer: attempt.publicKey, user: user.publicKey, feeReceiver: config.feeReceiver, registrationPrice: registrationPrice(config, label), domainRent: BigInt(snapshot.quote.domainRent), primaryRent: BigInt(snapshot.quote.primaryRent), blockhash: svm.latestBlockhash() });
  const send = (tx: Transaction): TransactionMetadata | FailedTransactionMetadata => {
    tx.partialSign(sponsor, attempt, user);
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  };
  return { svm, snapshot, config, sponsor, attempt, user, build, send };
}

export function requireSuccess(result: TransactionMetadata | FailedTransactionMetadata): TransactionMetadata {
  if (result instanceof FailedTransactionMetadata) throw new Error(result.toString());
  return result;
}
