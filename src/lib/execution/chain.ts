import { createHash } from 'node:crypto';
import {
  Connection, Message, PublicKey, SystemProgram, Transaction, VersionedTransaction,
  type AccountInfo, type FetchFn, type VersionedTransactionResponse,
} from '@solana/web3.js';
import { createRegistryClient, type RegistryClient } from '../chain/client';
import { COOKIE_REGISTRY_POLICY as policy } from '../chain/policy';
import { decodeDomain, decodePrimary, domainPda, primaryPda } from '../cookie/registry';
import { MAX_TRANSACTION_BYTES, nativeAmount } from '../cookie/transaction';
import { validateSponsoredMessage } from '../transactions/policy';
import { assertUnsignedQuoteFresh, type SponsoredQuote } from '../transactions/quote';
import { buildRecoveryTransaction, validateUserPayload } from './crypto';
import { ExecutionError, type ExecutionAttempt, type ExecutionChain, type ExecutionObservation, type ExecutionOperation, type FinalizedReceipt } from './types';

/** Trusted server/test port; it must never be populated from an HTTP request. */
export type ExecutionRpcConnection = Pick<Connection,
  'getGenesisHash' | 'getBlockHeight' | 'getSignatureStatuses' | 'getTransaction' |
  'getMultipleAccountsInfoAndContext' | 'getLatestBlockhashAndContext' | 'getFeeForMessage' |
  'simulateTransaction' | 'sendRawTransaction'>;
export interface ExecutionChainOptions {
  connection?: ExecutionRpcConnection;
  registry?: RegistryClient;
  /** Off by default. Enabling this belongs to a separately reviewed runtime gate. */
  allowBroadcast?: boolean;
  clock?: () => number;
  requestTimeoutMs?: number;
}

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fail(code: ConstructorParameters<typeof ExecutionError>[0] = 'evidence_invalid'): never { throw new ExecutionError(code); }
function counter(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}
function amount(value: number): bigint { return BigInt(counter(value)); }
function quoteAmount(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) fail();
  return nativeAmount(BigInt(value));
}
function key(value: string, signer = false): PublicKey {
  const result = new PublicKey(value);
  if (result.toBase58() !== value || (signer && !PublicKey.isOnCurve(result.toBytes()))) fail();
  return result;
}
function plainBalance(account: AccountInfo<Buffer> | null): bigint {
  if (account === null) return 0n;
  if (account.executable || !account.owner.equals(SystemProgram.programId) || account.data.length !== 0) fail();
  return amount(account.lamports);
}
function transactionError(value: unknown): void {
  if (value !== null && !(typeof value === 'string' && value.length > 0)
    && !(typeof value === 'object' && value !== null && !Array.isArray(value))) fail();
}
function canonicalBytes(value: string): Buffer {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1644) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_TRANSACTION_BYTES || bytes.toString('base64') !== value) fail();
  return bytes;
}
function signature58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${bytes.toString('hex')}`), encoded = '', zeroes = 0;
  while (value) { encoded = alphabet[Number(value % 58n)]! + encoded; value /= 58n; }
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + encoded;
}
function finalizedReceipt(raw: VersionedTransactionResponse, operation: ExecutionOperation): FinalizedReceipt {
  if (!raw.meta || (raw.version !== undefined && raw.version !== 'legacy') || raw.transaction.message.version !== 'legacy'
    || raw.meta.err === undefined || raw.transaction.signatures[0] !== operation.signature) fail();
  transactionError(raw.meta.err);
  const slot = counter(raw.slot);
  const bytes = raw.transaction.message.serialize();
  if (hash(bytes) !== operation.messageHash || Buffer.from(bytes).toString('base64') !== operation.messageBase64) fail();
  const message = Message.from(bytes);
  if (message.recentBlockhash !== operation.blockhash || raw.transaction.signatures.length !== message.header.numRequiredSignatures
    || ![2, 3].includes(message.header.numRequiredSignatures)) fail();
  const tx = Transaction.populate(message, raw.transaction.signatures);
  const signedBytes = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  if (signedBytes.length > MAX_TRANSACTION_BYTES || raw.meta.preBalances.length !== message.accountKeys.length
    || raw.meta.postBalances.length !== message.accountKeys.length
    || (raw.meta.loadedAddresses && (raw.meta.loadedAddresses.readonly.length || raw.meta.loadedAddresses.writable.length))) fail();
  return { signedBase64: signedBytes.toString('base64'), slot, fee: amount(raw.meta.fee), failed: raw.meta.err !== null,
    accountKeys: message.accountKeys.map((publicKey) => publicKey.toBase58()),
    preBalances: raw.meta.preBalances.map(amount), postBalances: raw.meta.postBalances.map(amount) };
}

/** No keys are loaded here. Simulation is read-only; only persisted bytes reach broadcast. */
export function createExecutionChain(endpoint: string, options: ExecutionChainOptions = {}): ExecutionChain {
  const timeout = options.requestTimeoutMs ?? 4000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 4000) fail('invalid_input');
  const clock = options.clock ?? Date.now;
  const allowBroadcast = options.allowBroadcast === true;
  const boundedFetch: FetchFn = (input, init) => globalThis.fetch(input as string, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  let connection: ExecutionRpcConnection;
  let registry: RegistryClient;
  try {
    connection = options.connection ?? new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: boundedFetch });
    registry = options.registry ?? createRegistryClient(endpoint, { requestTimeoutMs: timeout, clock });
  } catch { fail('unavailable'); }
  let minimumSlot = 0;
  // Signature-status context is the node's current bank, which can be ahead of
  // its finalized bank. Keep that cursor separate from finalized account reads.
  let minimumStatusSlot = 0;
  let minimumHeight = 0;
  async function rpc<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExecutionError('unavailable')), timeout);
      })]);
    } catch (error) { if (error instanceof ExecutionError) throw error; fail('unavailable'); }
    finally { clearTimeout(timer); }
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof ExecutionError) throw error; fail(); }
  }
  async function checkGenesis(): Promise<void> {
    if (await rpc(() => connection.getGenesisHash()) !== policy.genesisHash) fail('policy_changed');
  }
  async function height(): Promise<number> {
    const result = counter(await rpc(() => connection.getBlockHeight({ commitment: 'finalized', minContextSlot: minimumSlot })), minimumHeight);
    minimumHeight = result;
    return result;
  }
  function slot(value: number, requested = minimumSlot): number {
    const result = counter(value, Math.max(minimumSlot, requested));
    minimumSlot = result;
    return result;
  }

  return Object.freeze({
    async preflight(input: SponsoredQuote, userSignedBase64: string) {
      return guarded(async () => {
        // Own all caller-provided quote fields before yielding to an adapter.
        const q = structuredClone(input);
        try { validateUserPayload(q.unsignedTransactionBase64, userSignedBase64, q.user); }
        catch { fail('signature_invalid'); }
        const messageBytes = canonicalBytes(q.messageBase64);
        if (hash(messageBytes) !== q.messageSha256 || q.policyId !== policy.id || q.genesisHash !== policy.genesisHash
          || q.configSha256 !== policy.configSha256 || q.programSha256 !== policy.programSha256 || q.feeReceiver !== policy.feeReceiverAddress) fail('policy_changed');
        const sponsor = key(q.sponsor, true), payer = key(q.attemptPayer, true), user = key(q.user, true);
        const price = quoteAmount(q.cost.registrationPrice), domainRent = quoteAmount(q.cost.domainRent), primaryRent = quoteAmount(q.cost.primaryRent);
        validateSponsoredMessage(messageBytes, { label: q.name, sponsor, attemptPayer: payer, user, feeReceiver: key(q.feeReceiver),
          registrationPrice: price, domainRent, primaryRent, blockhash: q.blockhash });
        if (!Transaction.from(canonicalBytes(userSignedBase64)).serializeMessage().equals(messageBytes)) fail();
        const feeCap = quoteAmount(q.cost.transactionFee), reservation = quoteAmount(q.cost.maximumReservation);
        if (feeCap === 0n || reservation !== price + domainRent + primaryRent + feeCap + quoteAmount(q.cost.recoveryAllowance)) fail();
        counter(q.observedSlot); counter(q.blockhashContextSlot, q.observedSlot);
        await checkGenesis();
        const observed = await rpc(() => registry.observe({ label: q.name, sponsor, attemptPayer: payer, user }));
        const observedSlot = slot(observed.observedSlot, q.blockhashContextSlot);
        slot(observed.blockhashContextSlot, observedSlot);
        if (observed.label !== q.name || observed.sponsor.toBase58() !== q.sponsor || observed.attemptPayer.toBase58() !== q.attemptPayer
          || observed.user.toBase58() !== q.user || observed.feeReceiver.toBase58() !== q.feeReceiver || observed.policyId !== q.policyId
          || observed.genesisHash !== q.genesisHash || observed.configSha256 !== q.configSha256 || observed.programSha256 !== q.programSha256
          || observed.registrationPrice !== price || observed.domainRent !== domainRent || observed.primaryRent !== primaryRent) fail('policy_changed');
        const sponsorBalance = nativeAmount(observed.sponsorBalance);
        if (sponsorBalance < reservation) fail('budget_exhausted');
        const blockHeight = await height();
        try { assertUnsignedQuoteFresh(q, counter(clock()), blockHeight); } catch { fail('quote_expired'); }
        const feeResult = await rpc(() => connection.getFeeForMessage(Message.from(messageBytes), 'finalized'));
        slot(feeResult.context.slot, observedSlot);
        if (feeResult.value === null) fail('quote_expired');
        const fee = amount(feeResult.value);
        if (fee === 0n || fee > feeCap) fail('policy_changed');
        const simulation = await rpc(() => connection.simulateTransaction(VersionedTransaction.deserialize(canonicalBytes(userSignedBase64)), {
          commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: minimumSlot,
        }));
        const simulatedSlot = slot(simulation.context.slot);
        if (simulation.value.err !== null || ('replacementBlockhash' in simulation.value && simulation.value.replacementBlockhash)) fail('evidence_invalid');
        const checkedAtMs = counter(clock());
        try { assertUnsignedQuoteFresh(q, checkedAtMs, blockHeight); } catch { fail('quote_expired'); }
        return { checkedAtMs, slot: simulatedSlot, blockHeight, fee, sponsorBalance };
      });
    },
    async broadcast(signedBase64: string) {
      if (!allowBroadcast) fail('disabled');
      return guarded(async () => {
        const bytes = canonicalBytes(signedBase64);
        const tx = Transaction.from(bytes);
        if (![2, 3].includes(tx.signatures.length) || !tx.serialize({ requireAllSignatures: true, verifySignatures: true }).equals(bytes) || !tx.signature) fail();
        const expectedSignature = signature58(tx.signature);
        await checkGenesis();
        const signature = await rpc(() => connection.sendRawTransaction(Buffer.from(bytes), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 }));
        if (signature !== expectedSignature) fail();
        return signature;
      });
    },
    async observe(inputOperation: ExecutionOperation, inputAttempt: ExecutionAttempt): Promise<ExecutionObservation> {
      return guarded(async () => {
        const operation = structuredClone(inputOperation), attempt = structuredClone(inputAttempt);
        if (!operation.signature || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(operation.signature)
          || operation.attemptId !== attempt.id) fail();
        const payer = key(attempt.payerPublicKey, true), user = key(attempt.wallet, true);
        const domain = domainPda(attempt.name), primary = primaryPda(user);
        await checkGenesis();
        const statuses = await rpc(() => connection.getSignatureStatuses([operation.signature!], { searchTransactionHistory: true }));
        minimumStatusSlot = counter(statuses.context.slot, Math.max(minimumStatusSlot, minimumSlot));
        if (statuses.value.length !== 1) fail();
        const value = statuses.value[0];
        if (value === undefined) fail();
        let status: ExecutionObservation['status'] = 'missing';
        let receipt: FinalizedReceipt | null = null;
        if (value) {
          counter(value.slot);
          if (value.slot > statuses.context.slot || value.err === undefined || !['processed', 'confirmed', 'finalized'].includes(value.confirmationStatus ?? '')) fail();
          transactionError(value.err);
          if (value.confirmations !== null) counter(value.confirmations);
          status = value.confirmationStatus!;
          if (status === 'finalized') {
            const raw = await rpc(() => connection.getTransaction(operation.signature!, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }));
            if (raw) {
              receipt = finalizedReceipt(raw, operation);
              if (receipt.slot !== value.slot || receipt.failed !== (value.err !== null)) fail();
            }
          }
        }
        const accountMinimum = Math.max(minimumSlot, receipt?.slot ?? 0);
        const accounts = await rpc(() => connection.getMultipleAccountsInfoAndContext([payer, domain, primary], { commitment: 'finalized', minContextSlot: accountMinimum }));
        const accountSlot = slot(accounts.context.slot, accountMinimum);
        if (accounts.value.length !== 3 || accounts.value.some((account) => account === undefined)) fail();
        const [payerAccount, domainAccount, primaryAccount] = accounts.value;
        const payerBalance = plainBalance(payerAccount!);
        let domainOwner: string | null = null, primaryOwner: string | null = null, primaryName: string | null = null;
        if (domainAccount) { amount(domainAccount.lamports); domainOwner = decodeDomain(domainAccount, attempt.name).owner.toBase58(); }
        if (primaryAccount) {
          amount(primaryAccount.lamports);
          const decoded = decodePrimary(primaryAccount, user);
          primaryOwner = decoded.owner.toBase58(); primaryName = decoded.name;
        }
        // Even after expiry, missing history is not proof that this signature never landed.
        return { finalizedBlockHeight: await height(), status, receipt, accountSlot, payerBalance, domainOwner, primaryOwner, primaryName };
      });
    },
    async prepareRecovery(input: Parameters<ExecutionChain['prepareRecovery']>[0]) {
      return guarded(async () => {
        const captured = structuredClone(input);
        const sponsor = key(captured.sponsor, true), payer = key(captured.payer, true);
        if (sponsor.equals(payer) || nativeAmount(captured.amount) === 0n || nativeAmount(captured.maxFee) === 0n) fail('invalid_input');
        if (captured.validity) {
          key(captured.validity.blockhash);
          counter(captured.validity.lastValidBlockHeight);
        }
        await checkGenesis();
        const accounts = await rpc(() => connection.getMultipleAccountsInfoAndContext([sponsor, payer], { commitment: 'finalized', minContextSlot: minimumSlot }));
        const observedSlot = slot(accounts.context.slot);
        if (accounts.value.length !== 2 || accounts.value.some((account) => account === undefined)) fail();
        const sponsorBalance = plainBalance(accounts.value[0]!);
        if (plainBalance(accounts.value[1]!) !== captured.amount) fail('conflict');
        let blockhash: string, lastValidBlockHeight: number;
        if (captured.validity) {
          // A persisted operation must be rechecked against its original blockhash.
          // Replacing it would silently authorize a different recovery message.
          ({ blockhash, lastValidBlockHeight } = captured.validity);
        } else {
          const block = await rpc(() => connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: observedSlot }));
          slot(block.context.slot, observedSlot);
          blockhash = key(block.value.blockhash).toBase58();
          lastValidBlockHeight = counter(block.value.lastValidBlockHeight);
        }
        if (await height() > lastValidBlockHeight) fail('quote_expired');
        const template = buildRecoveryTransaction({ sponsor: captured.sponsor, payer: captured.payer, amount: captured.amount, blockhash });
        const result = await rpc(() => connection.getFeeForMessage(Message.from(canonicalBytes(template.messageBase64)), 'finalized'));
        slot(result.context.slot);
        if (result.value === null) fail('quote_expired');
        const fee = amount(result.value);
        if (fee === 0n || fee > captured.maxFee || sponsorBalance < fee) fail('budget_exhausted');
        const simulation = await rpc(() => connection.simulateTransaction(VersionedTransaction.deserialize(canonicalBytes(template.unsignedBase64)), {
          commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: minimumSlot,
        }));
        slot(simulation.context.slot);
        if (simulation.value.err !== null || ('replacementBlockhash' in simulation.value && simulation.value.replacementBlockhash)) fail('evidence_invalid');
        if (await height() > lastValidBlockHeight) fail('quote_expired');
        return { blockhash, lastValidBlockHeight, observedSlot, fee, preparedAtMs: counter(clock()) };
      });
    },
  });
}
