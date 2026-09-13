import { createHash } from 'node:crypto';
import { Keypair, type Message, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { RegistryClient, RegistryInput } from '../src/lib/chain/client';
import { domainPda, primaryPda } from '../src/lib/cookie/registry';
import { validateSponsoredMessage } from '../src/lib/transactions/policy';
import { prepareSponsoredQuote, type QuoteLimits } from '../src/lib/transactions/quote';

const epoch = 1_789_344_000_000;
const key = (seed: number) => Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
const limits: QuoteLimits = {
  maxRegistrationPrice: 15_000_000_000_000n, maxTransactionFee: 15_000n,
  recoveryAllowance: 15_000n, maxReservation: 15_000_003_384_720n, ttlMs: 30_000,
};

// PublicKey is a mutable class; readonly properties or Object.freeze on a parent
// record do not isolate its BN. Exercise that actual alias rather than replacing
// a local reference that the consumer would never see.
function mutableKey(value: PublicKey): { _bn: unknown } {
  return value as unknown as { _bn: unknown };
}

function clientWithMutation(mutate?: (captured: RegistryInput, feeMessage: Message) => void): RegistryClient {
  let captured: RegistryInput | undefined;
  return {
    async observe(input) {
      captured = input;
      return Object.freeze({
        ...input, feeReceiver: key(4), registrationPrice: 15_000_000_000_000n,
        domainRent: 1_927_920n, primaryRent: 1_426_800n, sponsorBalance: 100_000_000_000_000n,
        blockhash: key(5).toBase58(), lastValidBlockHeight: 20_000, observedSlot: 21_000, blockhashContextSlot: 21_001,
        observedAtMs: epoch, genesisHash: key(6).toBase58(), configSha256: 'a'.repeat(64),
        programSha256: 'b'.repeat(64), policyId: 'first-bite-registry-v1',
      });
    },
    async getMessageFee(message) {
      if (!captured) throw new Error('Expected observation before fee lookup');
      mutate?.(captured, message);
      return 15_000n;
    },
  };
}

describe('quote adapter mutation isolation', () => {
  it.each(['observation keys', 'fee message', 'both'] as const)('isolates mutable %s while retaining identical bytes and metadata', async (target) => {
    const request = { name: 'firstbite', sponsor: key(1), user: key(2), attemptPayer: key(3) };
    const baseline = await prepareSponsoredQuote(request, clientWithMutation(), limits, () => epoch);
    const client = clientWithMutation((captured, feeMessage) => {
      if (target !== 'fee message') {
        const user = mutableKey(captured.user);
        const attempt = mutableKey(captured.attemptPayer);
        [user._bn, attempt._bn] = [attempt._bn, user._bn];
      }
      if (target !== 'observation keys') {
        mutableKey(feeMessage.accountKeys[0]!)._bn = mutableKey(key(9))._bn;
        feeMessage.accountKeys.reverse();
        feeMessage.instructions[0]!.data = '111';
        feeMessage.recentBlockhash = key(8).toBase58();
      }
    });
    const quote = await prepareSponsoredQuote(request, client, limits, () => epoch);
    expect(quote).toEqual(baseline);
    expect(quote.user).toBe(request.user.toBase58());
    expect(quote.attemptPayer).toBe(request.attemptPayer.toBase58());
    expect(quote.expected).toEqual({
      domain: domainPda('firstbite').toBase58(), owner: request.user.toBase58(),
      primary: primaryPda(request.user).toBase58(), primaryName: 'firstbite',
    });
    const transaction = Transaction.from(Buffer.from(quote.unsignedTransactionBase64, 'base64'));
    const message = transaction.serializeMessage();
    expect(message.toString('base64')).toBe(quote.messageBase64);
    expect(createHash('sha256').update(message).digest('hex')).toBe(quote.messageSha256);
    expect(transaction.signatures.every(({ signature }) => signature === null)).toBe(true);
    expect(() => validateSponsoredMessage(message, {
      label: request.name, sponsor: request.sponsor, user: request.user, attemptPayer: request.attemptPayer,
      feeReceiver: key(4), registrationPrice: 15_000_000_000_000n, domainRent: 1_927_920n,
      primaryRent: 1_426_800n, blockhash: key(5).toBase58(),
    })).not.toThrow();
  });
});
