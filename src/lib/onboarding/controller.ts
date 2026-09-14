import { COOKIE_GENESIS, JourneyError, errorCopy, normalizeLabel, verifiedResult, type JourneyApi, type JourneyAttempt, type JourneyQuote, type JourneySession } from './model';
import type { createNightlyWallet, WalletSnapshot } from './wallet';

type Wallet = ReturnType<typeof createNightlyWallet>;
export interface JourneyState {
  step: 'invite' | 'wallet' | 'name' | 'review' | 'progress';
  session: JourneySession | null; wallet: WalletSnapshot; name: string;
  quote: JourneyQuote | null; attempt: JourneyAttempt | null;
  busy: string | null; checking: boolean; restoring: boolean; offline: boolean;
  error: string | null; uncertain: boolean;
}
export class JourneyController {
  private state: JourneyState = { step: 'invite', session: null, wallet: { installed: false, address: null, genesisHash: null, canSign: false },
    name: '', quote: null, attempt: null, busy: null, checking: false, restoring: true, offline: false, error: null, uncertain: false };
  private listeners = new Set<() => void>();
  private quoteGeneration = 0;
  private reservation: { quoteId: string; key: string } | null = null;
  private pendingRestore = false;
  constructor(private readonly api: JourneyApi, private readonly wallet: Wallet, readonly executionEnabled: boolean, private readonly now = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<JourneyState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((f) => f()); }
  private async run(label: string, work: () => Promise<void>) {
    if (this.state.busy || this.state.restoring) return;
    if (this.state.offline) { this.set({ error: errorCopy(new JourneyError('OFFLINE')) }); return; }
    this.set({ busy: label, error: null });
    try { await work(); } catch (error) { this.set({ error: errorCopy(error) }); }
    finally { this.set({ busy: null }); }
  }
  private walletMatches(): boolean {
    return !!this.state.session && this.state.wallet.address === this.state.session.wallet && this.state.wallet.genesisHash === COOKIE_GENESIS && this.state.wallet.canSign;
  }
  refreshWallet = () => {
    const next = this.wallet.snapshot();
    const previous = this.state.wallet;
    const changed = previous.address !== next.address || previous.genesisHash !== next.genesisHash;
    if (changed) this.quoteGeneration++;
    this.set({ wallet: next, ...(changed ? { quote: null, checking: false } : {}) });
  };
  setOffline(offline: boolean) { if (offline) this.quoteGeneration++; this.set({ offline, ...(offline ? { quote: null, checking: false } : {}) }); }
  async restore() {
    if (this.pendingRestore || this.state.busy) return;
    this.pendingRestore = true;
    this.set({ restoring: true });
    try { await this.restoreSession(); }
    catch (error) {
      if (!(error instanceof JourneyError && error.code === 'SESSION_REQUIRED')) this.set({ error: errorCopy(error) });
    } finally { this.pendingRestore = false; this.set({ restoring: false }); }
  }
  private async restoreSession() {
    const session = await this.api.session();
    this.set({ session });
    if (session.attemptId) {
      try { this.acceptAttempt(await this.api.attempt(session.attemptId)); }
      catch { this.set({ uncertain: true }); throw new JourneyError('RESTORE_FAILED'); }
    } else this.set({ step: 'wallet', uncertain: false });
  }
  exchange(token: string) {
    return this.run('Checking invitation…', async () => {
      this.quoteGeneration++;
      this.set({ quote: null, checking: false });
      if (!/^[A-Za-z0-9_-]{43}$/.test(token.trim())) throw new JourneyError('INVITE_UNAVAILABLE');
      await this.api.exchange(token.trim());
      this.set({ attempt: null, quote: null, session: null, uncertain: true });
      await this.restoreSession();
    });
  }
  connect() { return this.run('Waiting for Nightly…', async () => { await this.wallet.connect(); this.refreshWallet(); }); }
  switchNetwork() { return this.run('Select Cookie in Nightly…', async () => { await this.wallet.switchToCookie(); this.refreshWallet(); }); }
  disconnect() { return this.run('Disconnecting…', async () => { await this.wallet.disconnect(); this.refreshWallet(); }); }
  continueFromWallet() {
    this.refreshWallet();
    if (!this.walletMatches()) { this.set({ error: errorCopy(new JourneyError(this.state.wallet.address !== this.state.session?.wallet ? 'wrong_wallet' : 'wrong_network')) }); return; }
    this.set({ step: this.state.attempt ? 'review' : 'name', error: null });
  }
  editName(value: string) {
    if (this.state.busy || this.state.attempt) return;
    this.quoteGeneration++;
    this.set({ name: value, quote: null, checking: false, error: null });
  }
  async checkName() {
    const name = normalizeLabel(this.state.name);
    if (!name || !this.walletMatches() || this.state.attempt || this.state.offline || this.state.busy) return;
    const generation = ++this.quoteGeneration;
    const wallet = this.state.session!.wallet;
    this.set({ checking: true, error: null, quote: null });
    try {
      const quote = await this.api.quote(name, wallet);
      if (generation !== this.quoteGeneration) return;
      if (quote.name !== name || quote.expected.owner !== wallet || quote.expected.primaryName !== name || Date.parse(quote.expiresAt) <= this.now()) throw new JourneyError('QUOTE_CHANGED');
      this.set({ quote });
    } catch (error) { if (generation === this.quoteGeneration) this.set({ error: errorCopy(error) }); }
    finally { if (generation === this.quoteGeneration) this.set({ checking: false }); }
  }
  reserve() {
    return this.run('Preparing your review…', async () => {
      this.refreshWallet();
      const quote = this.state.quote;
      if (!this.walletMatches() || !quote || Date.parse(quote.expiresAt) <= this.now()) throw new JourneyError('QUOTE_CHANGED');
      if (this.reservation?.quoteId !== quote.quoteId) this.reservation = { quoteId: quote.quoteId, key: crypto.randomUUID() };
      try { this.acceptAttempt(await this.api.reserve(quote.quoteId, this.reservation.key)); }
      catch (error) {
        // A lost reservation response may have committed. Recover through the
        // session before allowing another preparation; retain the idempotency key.
        this.set({ uncertain: true });
        try { await this.restoreSession(); } catch { throw new JourneyError('RESTORE_FAILED'); }
        if (!this.state.attempt) throw error;
      }
    });
  }
  private acceptAttempt(attempt: JourneyAttempt) {
    if (attempt.wallet !== this.state.session?.wallet || (this.state.session.attemptId && attempt.id !== this.state.session.attemptId)) throw new JourneyError('RESTORE_FAILED');
    if (['finalized', 'complete'].includes(attempt.status) && !verifiedResult(attempt)) throw new JourneyError('RESTORE_FAILED');
    const step = attempt.status === 'prepared' ? 'review' : 'progress';
    this.set({ attempt, name: attempt.name, step, uncertain: false });
  }
  approve() {
    return this.run('Review the approval in Nightly…', async () => {
      if (!this.executionEnabled) throw new JourneyError('EXECUTION_DISABLED');
      if (this.state.uncertain) throw new JourneyError('SUBMIT_UNKNOWN');
      this.refreshWallet();
      const attempt = this.state.attempt;
      if (!attempt || attempt.status !== 'prepared' || !attempt.cost || Date.parse(attempt.expiresAt) <= this.now()) throw new JourneyError('QUOTE_EXPIRED');
      if (!this.walletMatches()) throw new JourneyError('wrong_wallet');
      const signed = await this.wallet.sign({ wallet: attempt.wallet, unsignedTransactionBase64: attempt.unsignedTransactionBase64, messageHash: attempt.messageHash });
      this.set({ step: 'progress', uncertain: true, busy: 'Sending your approval…' });
      try { await this.api.submit(attempt.id, signed); }
      catch { throw new JourneyError('SUBMIT_UNKNOWN'); }
      // Keep the existing attempt on a lost status response. No signature or
      // bearer payload is persisted in the browser or exposed through state.
      this.acceptAttempt(await this.api.attempt(attempt.id));
    });
  }
  refresh() {
    return this.run('Checking your progress…', async () => {
      if (this.state.attempt) this.acceptAttempt(await this.api.attempt(this.state.attempt.id));
      else await this.restoreSession();
    });
  }
  retry() {
    return this.run('Requesting another check…', async () => {
      if (!this.executionEnabled) throw new JourneyError('EXECUTION_DISABLED');
      if (!this.state.attempt) return;
      await this.api.retry(this.state.attempt.id);
      this.acceptAttempt(await this.api.attempt(this.state.attempt.id));
    });
  }
  freshName() {
    if (!this.state.attempt || !['failed', 'expired'].includes(this.state.attempt.status) || this.state.busy) return;
    this.quoteGeneration++; this.reservation = null;
    this.set({ attempt: null, quote: null, step: 'wallet', uncertain: false, error: null,
      session: this.state.session ? { ...this.state.session, attemptId: null } : null });
  }
  walletStep() { if (!this.state.busy) this.set({ step: 'wallet', error: null }); }
  invitationStep() { if (!this.state.busy) this.set({ step: 'invite', error: null }); }
}
