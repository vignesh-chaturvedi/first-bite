import { COOKIE_GENESIS, JourneyError, type JourneyApi, type JourneyAttempt, type JourneyQuote, type JourneySession } from './model';
import type { createNightlyWallet, WalletSnapshot } from './wallet';

export const DEMO_TOKEN = 'A'.repeat(43);
const demoWallet = '8iDTdKNJoN7tVsxcUcAQEowLFoGfVLcFm2X3DvGXuv6D';
const id = '11111111-1111-4111-8111-111111111111';
const costs = { registrationPrice: '15000000000000', domainRent: '1927920', primaryRent: '1426800', transactionFee: '15000',
  recoveryAllowance: '15000', maxSponsorDebit: '15000003369720', maximumReservation: '15000003384720' };
/** Explicit walkthrough fixtures. No fetch, RPC, injected wallet, storage or keys. */
export function createDemoJourney(): { api: JourneyApi; wallet: ReturnType<typeof createNightlyWallet> } {
  let joined = false; let connected = false; let candidate: JourneyQuote | null = null; let current: JourneyAttempt | null = null; let reads = 0;
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 450));
  const snapshot = (): WalletSnapshot => ({ installed: true, address: connected ? demoWallet : null, genesisHash: connected ? COOKIE_GENESIS : null, canSign: true });
  const session = (): JourneySession => ({ wallet: demoWallet, expiresAt: new Date(Date.now() + 900_000).toISOString(),
    campaign: { name: 'The first round · Example sponsor', slug: 'walkthrough', status: 'active' }, attemptId: current?.id ?? null });
  return {
    wallet: { snapshot, async connect() { await pause(); connected = true; return snapshot(); },
      async switchToCookie() { return snapshot(); }, async disconnect() { connected = false; },
      async sign() { await pause(); return 'walkthrough-only'; }, subscribe() { return () => {}; } },
    api: {
      async session() { if (!joined) throw new JourneyError('SESSION_REQUIRED'); return session(); },
      async exchange() { await pause(); joined = true; },
      async quote(name) {
        await pause();
        if (['taken', 'cookie', 'admin'].includes(name)) throw new JourneyError('NAME_UNAVAILABLE');
        candidate = { quoteId: id, name, cost: costs, expiresAt: new Date(Date.now() + 45_000).toISOString(),
          expected: { domain: demoWallet, owner: demoWallet, primary: demoWallet, primaryName: name } };
        return candidate;
      },
      async reserve() {
        await pause(); if (!candidate) throw new JourneyError('QUOTE_CHANGED');
        current = { id, quoteId: id, name: candidate.name, wallet: demoWallet, expiresAt: candidate.expiresAt, status: 'prepared',
          reservationNative: costs.maximumReservation, messageHash: 'a'.repeat(64), unsignedTransactionBase64: '',
          signature: null, verifiedSlot: null, actualCostNative: '0', residualNative: null, cost: costs };
        return current;
      },
      async submit() { await pause(); if (current) current = { ...current, status: 'submitted' }; },
      async attempt() {
        await pause(); if (!current) throw new JourneyError('ATTEMPT_NOT_FOUND');
        if (['submitted', 'confirmed'].includes(current.status)) {
          reads++;
          current = { ...current, status: reads >= 3 ? 'complete' : reads === 2 ? 'confirmed' : 'submitted',
            ...(reads >= 3 ? { signature: '2'.repeat(88), verifiedSlot: 123456, actualCostNative: costs.maxSponsorDebit, residualNative: '0' } : {}) };
        }
        return current;
      },
      async retry() { await pause(); },
    },
  };
}
