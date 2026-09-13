import { createHash } from 'node:crypto';
import {
  Connection, Message, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram,
  type AccountInfo, type FetchFn,
} from '@solana/web3.js';
import {
  DOMAIN_SIZE, PRIMARY_SIZE, PROGRAM_ID, configPda, decodeConfig,
  decodePrimary, domainPda, normalizeName, primaryPda, registrationPrice,
} from '../cookie/registry';
import { COOKIE_REGISTRY_POLICY, type RegistryPolicy } from './policy';

export interface RegistryObservation {
  readonly label: string;
  readonly sponsor: PublicKey;
  readonly attemptPayer: PublicKey;
  readonly user: PublicKey;
  readonly feeReceiver: PublicKey;
  readonly registrationPrice: bigint;
  readonly domainRent: bigint;
  /** Zero only when an existing, valid cleared primary is already rent exempt. */
  readonly primaryRent: bigint;
  readonly sponsorBalance: bigint;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** Account evidence slot, kept separate from the later blockhash read. */
  readonly observedSlot: number;
  readonly blockhashContextSlot: number;
  readonly observedAtMs: number;
  readonly genesisHash: string;
  readonly configSha256: string;
  readonly programSha256: string;
  readonly policyId: string;
}

export interface RegistryInput {
  label: string;
  sponsor: PublicKey;
  attemptPayer: PublicKey;
  user: PublicKey;
}

export interface RegistryClient {
  observe(input: RegistryInput): Promise<RegistryObservation>;
  getMessageFee(message: Message, minContextSlot: number): Promise<bigint>;
}

/** This port deliberately has no signing, simulation, subscription or send method. */
export type RegistryReadConnection = Pick<Connection,
  'getGenesisHash' | 'getMultipleAccountsInfoAndContext' |
  'getMinimumBalanceForRentExemption' | 'getLatestBlockhashAndContext' | 'getFeeForMessage'>;

export type RegistryFailureCode =
  | 'INVALID_NAME' | 'INVALID_ACCOUNTS' | 'RPC_FAILED' | 'RPC_TIMEOUT'
  | 'WRONG_CHAIN' | 'POLICY_CHANGED' | 'UNSAFE_RPC_VALUE' | 'STALE_CONTEXT'
  | 'NAME_UNAVAILABLE' | 'ATTEMPT_NOT_FRESH' | 'USER_INELIGIBLE'
  | 'SPONSOR_INVALID' | 'FEE_UNAVAILABLE';

/** Fixed text only: never retain an RPC error, endpoint, response body or cause. */
export class RegistryClientError extends Error {
  constructor(readonly code: RegistryFailureCode) {
    super(`Registry observation failed: ${code}`);
    this.name = 'RegistryClientError';
  }
}

export interface RegistryClientOptions {
  /** Trusted server/test injection only. Never construct options from request data. */
  connection?: RegistryReadConnection;
  clock?: () => number;
  policy?: RegistryPolicy;
  requestTimeoutMs?: number;
}

function fail(code: RegistryFailureCode): never { throw new RegistryClientError(code); }
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');

function exact(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) fail('UNSAFE_RPC_VALUE');
  return BigInt(value);
}

function checkedSlot(value: number, minimum = 0): number {
  exact(value);
  if (value < minimum) fail('STALE_CONTEXT');
  return value;
}

function emptySystem(account: AccountInfo<Buffer> | null, code: RegistryFailureCode): void {
  if (account && (account.executable || !account.owner.equals(SystemProgram.programId) || account.data.length !== 0)) fail(code);
}

function checkProgram(program: AccountInfo<Buffer> | null, data: AccountInfo<Buffer> | null, policy: RegistryPolicy): void {
  const loader = new PublicKey(policy.loaderAddress);
  if (!program || !program.executable || !program.owner.equals(loader) || program.data.length !== 36
    || program.data.readUInt32LE(0) !== 2
    || !new PublicKey(program.data.subarray(4, 36)).equals(new PublicKey(policy.programDataAddress))) fail('POLICY_CHANGED');
  if (!data || data.executable || !data.owner.equals(loader) || data.data.length !== 45 + policy.programBytes
    || data.data.readUInt32LE(0) !== 3 || data.data.readBigUInt64LE(4) !== policy.deploymentSlot
    || data.data[12] !== 1
    || !new PublicKey(data.data.subarray(13, 45)).equals(new PublicKey(policy.upgradeAuthority))) fail('POLICY_CHANGED');
  const elf = data.data.subarray(45);
  if (!elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || sha256(elf) !== policy.programSha256) fail('POLICY_CHANGED');
}

/** Read-only, finalized observations. All account evidence comes from one RPC context. */
export function createRegistryClient(endpoint: string, options: RegistryClientOptions = {}): RegistryClient {
  const policy = Object.freeze({ ...(options.policy ?? COOKIE_REGISTRY_POLICY) });
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? 4000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('INVALID_ACCOUNTS');
  // An HTTP deadline remains active while web3.js consumes the response body.
  const boundedFetch: FetchFn = (input, init) => globalThis.fetch(input as string, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  let connection: RegistryReadConnection;
  try {
    connection = options.connection ?? new Connection(endpoint, {
      commitment: 'finalized', disableRetryOnRateLimit: true, fetch: boundedFetch,
    });
  } catch { fail('RPC_FAILED'); }
  let latestContextSlot = 0;

  async function rpc<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RegistryClientError('RPC_TIMEOUT')), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof RegistryClientError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) fail('RPC_TIMEOUT');
      fail('RPC_FAILED');
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async observe(input: RegistryInput): Promise<RegistryObservation> {
      const label = input.label;
      try { if (normalizeName(label) !== label) fail('INVALID_NAME'); }
      catch { fail('INVALID_NAME'); }
      // PublicKey objects can be mutated internally; capture keys before the first await.
      let sponsor: PublicKey;
      let attemptPayer: PublicKey;
      let user: PublicKey;
      try {
        sponsor = new PublicKey(input.sponsor.toBytes());
        attemptPayer = new PublicKey(input.attemptPayer.toBytes());
        user = new PublicKey(input.user.toBytes());
      } catch { fail('INVALID_ACCOUNTS'); }
      const receiver = new PublicKey(policy.feeReceiverAddress);
      const domain = domainPda(label);
      const userPrimary = primaryPda(user);
      const attemptPrimary = primaryPda(attemptPayer);
      const addresses = [PROGRAM_ID, configPda(), new PublicKey(policy.programDataAddress), SYSVAR_RENT_PUBKEY,
        receiver, domain, userPrimary, attemptPrimary, sponsor, attemptPayer, user];
      if (!PROGRAM_ID.equals(new PublicKey(policy.programAddress)) || !configPda().equals(new PublicKey(policy.configAddress))) fail('POLICY_CHANGED');
      if (new Set(addresses.map((key) => key.toBase58())).size !== addresses.length
        || [sponsor, attemptPayer, user].some((key) => key.equals(SystemProgram.programId)
          || !PublicKey.isOnCurve(key.toBytes()))) fail('INVALID_ACCOUNTS');

      const genesisHash = await rpc(() => connection.getGenesisHash());
      if (genesisHash !== policy.genesisHash) fail('WRONG_CHAIN');
      const [snapshot, domainRentNumber, primaryRentNumber] = await Promise.all([
        rpc(() => connection.getMultipleAccountsInfoAndContext(addresses.map((key) => new PublicKey(key.toBytes())), {
          commitment: 'finalized', minContextSlot: latestContextSlot,
        })),
        rpc(() => connection.getMinimumBalanceForRentExemption(DOMAIN_SIZE, 'finalized')),
        rpc(() => connection.getMinimumBalanceForRentExemption(PRIMARY_SIZE, 'finalized')),
      ]);
      const observedSlot = checkedSlot(snapshot.context.slot, latestContextSlot);
      if (snapshot.value.length !== addresses.length) fail('POLICY_CHANGED');
      for (const account of snapshot.value) if (account) exact(account.lamports);
      const [program, configAccount, programData, rent, feeReceiver, domainAccount,
        primary, attemptPrimaryAccount, sponsorAccount, attemptAccount, userAccount] = snapshot.value as Array<AccountInfo<Buffer> | null>;
      checkProgram(program!, programData!, policy);
      if (!configAccount || sha256(configAccount.data) !== policy.configSha256) fail('POLICY_CHANGED');
      let config;
      try { config = decodeConfig(configAccount); }
      catch { fail('POLICY_CHANGED'); }
      if (!config.feeReceiver.equals(receiver)) fail('POLICY_CHANGED');
      if (!rent || rent.executable || !rent.owner.equals(SYSVAR_OWNER) || sha256(rent.data) !== policy.rentSha256) fail('POLICY_CHANGED');
      const domainRent = exact(domainRentNumber);
      const primaryAllocationRent = exact(primaryRentNumber);
      if (domainRent !== policy.domainRent || primaryAllocationRent !== policy.primaryRent) fail('POLICY_CHANGED');
      if (!feeReceiver) fail('POLICY_CHANGED');
      emptySystem(feeReceiver, 'POLICY_CHANGED');
      // Any allocation is unavailable, including malformed or legacy domain records.
      if (domainAccount) fail('NAME_UNAVAILABLE');
      // Strictly absent A avoids stranded balances and accidental reuse of an old attempt.
      if (attemptAccount || attemptPrimaryAccount) fail('ATTEMPT_NOT_FRESH');
      emptySystem(sponsorAccount!, 'SPONSOR_INVALID');
      emptySystem(userAccount!, 'USER_INELIGIBLE');
      if (primary) {
        try { if (decodePrimary(primary, user).name !== null) fail('USER_INELIGIBLE'); }
        catch { fail('USER_INELIGIBLE'); }
        if (exact(primary.lamports) < primaryAllocationRent) fail('USER_INELIGIBLE');
      }
      // Snapshot the validated values before the next await. A read adapter may
      // retain and mutate AccountInfo buffers; those changes cannot alter a quote.
      const price = registrationPrice(config, label);
      const sponsorBalance = sponsorAccount ? exact(sponsorAccount.lamports) : 0n;
      const primaryRent = primary ? 0n : primaryAllocationRent;
      const block = await rpc(() => connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: observedSlot }));
      checkedSlot(block.context.slot, Math.max(observedSlot, latestContextSlot));
      exact(block.value.lastValidBlockHeight);
      try { if (new PublicKey(block.value.blockhash).toBase58() !== block.value.blockhash) fail('UNSAFE_RPC_VALUE'); }
      catch { fail('UNSAFE_RPC_VALUE'); }
      const observedAtMs = clock();
      exact(observedAtMs);
      latestContextSlot = block.context.slot;
      return Object.freeze({ label, sponsor, attemptPayer, user, feeReceiver: receiver,
        registrationPrice: price, domainRent, primaryRent, sponsorBalance,
        blockhash: block.value.blockhash, lastValidBlockHeight: block.value.lastValidBlockHeight,
        observedSlot, blockhashContextSlot: block.context.slot, observedAtMs, genesisHash,
        configSha256: policy.configSha256, programSha256: policy.programSha256, policyId: policy.id,
      });
    },
    async getMessageFee(message: Message, minContextSlot: number): Promise<bigint> {
      checkedSlot(minContextSlot);
      let privateMessage: Message;
      try { privateMessage = Message.from(message.serialize()); }
      catch { fail('INVALID_ACCOUNTS'); }
      // This web3.js API only accepts commitment; independently enforce the returned context.
      const result = await rpc(() => connection.getFeeForMessage(privateMessage, 'finalized'));
      checkedSlot(result.context.slot, Math.max(minContextSlot, latestContextSlot));
      if (result.value === null) fail('FEE_UNAVAILABLE');
      const fee = exact(result.value);
      latestContextSlot = result.context.slot;
      return fee;
    },
  });
}
