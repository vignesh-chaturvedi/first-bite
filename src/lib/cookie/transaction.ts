import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  PROGRAM_ID,
  configPda,
  domainPda,
  normalizeName,
  primaryPda,
  registerDomainIx,
  setPrimaryDomainIx,
  transferDomainIx,
} from './registry';

export const MAX_TRANSACTION_BYTES = 1_232;
export const COMPUTE_UNIT_LIMIT = 200_000;
export const U64_MAX = (1n << 64n) - 1n;

export interface SponsoredTransactionInput {
  label: string;
  sponsor: PublicKey;
  attemptPayer: PublicKey;
  user: PublicKey;
  feeReceiver: PublicKey;
  registrationPrice: bigint;
  domainRent: bigint;
  primaryRent: bigint;
  blockhash: string;
}

export function nativeAmount(value: bigint, label = 'amount'): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new Error(`${label} must be an unsigned 64-bit bigint`);
  }
  return value;
}

export function maximumReservation(cost: {
  price: bigint;
  domainRent: bigint;
  primaryRent: bigint;
  transactionFee: bigint;
  recoveryAllowance: bigint;
}): bigint {
  return Object.values(cost).reduce((sum, amount) => sum + nativeAmount(amount), 0n);
}

/** Pure construction only. Eligibility, fresh-A checks and live quotes belong to the caller. */
export function buildSponsoredTransaction(input: SponsoredTransactionInput): Transaction {
  const label = normalizeName(input.label);
  if (label !== input.label) throw new Error('Transaction label must already be normalized');
  const actors = [input.sponsor, input.attemptPayer, input.user];
  if (new Set(actors.map((key) => key.toBase58())).size !== actors.length) {
    throw new Error('Sponsor, attempt payer and user must be distinct');
  }
  if (actors.some((key) => !PublicKey.isOnCurve(key.toBytes()))) {
    throw new Error('Every signer must be an on-curve public key');
  }
  const protectedKeys = [
    PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId,
    configPda(), domainPda(label), primaryPda(input.user), primaryPda(input.attemptPayer),
  ];
  if ([...actors, input.feeReceiver].some((key) => protectedKeys.some((p) => p.equals(key)))) {
    throw new Error('An actor or fee receiver aliases a protected account');
  }
  if (actors.some((key) => key.equals(input.feeReceiver))) {
    throw new Error('Fee receiver must not alias a transaction signer');
  }
  nativeAmount(input.registrationPrice, 'registrationPrice');
  nativeAmount(input.domainRent, 'domainRent');
  nativeAmount(input.primaryRent, 'primaryRent');
  if (input.registrationPrice === 0n || input.domainRent === 0n) {
    throw new Error('Registration price and domain rent must be positive');
  }
  const allocation = nativeAmount(input.registrationPrice + input.domainRent, 'attempt allocation');
  // Parsing validates a 32-byte blockhash without assuming any particular network.
  new PublicKey(input.blockhash);
  const transaction = new Transaction({
    feePayer: input.sponsor,
    recentBlockhash: input.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    SystemProgram.transfer({ fromPubkey: input.sponsor, toPubkey: input.attemptPayer, lamports: allocation }),
    registerDomainIx({ label, payer: input.attemptPayer, feeReceiver: input.feeReceiver }),
    transferDomainIx({ label, currentOwner: input.attemptPayer, newOwner: input.user }),
  );
  if (input.primaryRent > 0n) {
    transaction.add(SystemProgram.transfer({
      fromPubkey: input.sponsor, toPubkey: input.user, lamports: input.primaryRent,
    }));
  }
  transaction.add(setPrimaryDomainIx({ label, owner: input.user }));
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 3) throw new Error('Expected exactly three signers');
  if (unsignedBytes(transaction).length > MAX_TRANSACTION_BYTES) throw new Error('Transaction exceeds packet limit');
  return transaction;
}

export function unsignedBytes(transaction: Transaction): Buffer {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/** Accept the user's signature only on the exact prepared message. Never broadcasts. */
export function validateUserSignature(
  prepared: Transaction,
  signedBytes: Uint8Array,
  expectedUser: PublicKey,
): Transaction {
  if (signedBytes.byteLength > MAX_TRANSACTION_BYTES) throw new Error('Oversized signed transaction');
  const signed = Transaction.from(signedBytes);
  if (!signed.serializeMessage().equals(prepared.serializeMessage())) throw new Error('Wallet changed the prepared message');
  const userSignature = signed.signatures.find(({ publicKey }) => publicKey.equals(expectedUser));
  if (!userSignature?.signature) throw new Error('Expected user signature is missing');
  if (signed.signatures.some(({ publicKey, signature }) => signature && !publicKey.equals(expectedUser))) {
    throw new Error('Unexpected signature: this endpoint accepts only the user signature');
  }
  if (!signed.verifySignatures(false)) throw new Error('User signature is invalid');
  return signed;
}
