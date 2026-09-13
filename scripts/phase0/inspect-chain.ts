import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, type AccountInfo } from '@solana/web3.js';
import { CONFIG_SIZE, DOMAIN_SIZE, PRIMARY_SIZE, PROGRAM_ID, configPda, decodeConfig, registrationPrice } from '../../src/lib/cookie/registry.js';
import { buildSponsoredTransaction, maximumReservation, unsignedBytes } from '../../src/lib/cookie/transaction.js';

export const DEFAULT_RPC = 'https://rpc.cookiescan.io';
export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export interface SavedAccount {
  address: string;
  owner: string;
  executable: boolean;
  lamports: string;
  dataBase64: string;
}
export interface ChainSnapshot {
  observedAt: string;
  endpoint: string;
  genesisHash: string;
  apiVersion: unknown;
  slots: { programAndConfig: number; programDataAndRent: number };
  program: SavedAccount;
  config: SavedAccount;
  feeReceiver: SavedAccount;
  rent: SavedAccount;
  programData: { address: string; deploymentSlot: string; upgradeAuthority: string | null; elfSha256: string; elfBytes: number };
  quote: { price: string; domainRent: string; primaryRent: string; messageFee: string; recoveryAllowance: string; totalPerPass: string; tenPassEstimate: string; transactionBytes: number; sampleName: string; blockhash: string; lastValidBlockHeight: number };
}

function exactNumber(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('RPC amount is not a safe integer');
  return BigInt(value);
}
function saveAccount(address: PublicKey, account: AccountInfo<Buffer>): SavedAccount {
  return { address: address.toBase58(), owner: account.owner.toBase58(), executable: account.executable, lamports: exactNumber(account.lamports).toString(), dataBase64: account.data.toString('base64') };
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

async function main(): Promise<void> {
  const endpoint = process.env.COOKIE_RPC_URL ?? DEFAULT_RPC;
  const connection = new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true });
  const [genesisHash, version, first, domainRentNumber, primaryRentNumber, block] = await Promise.all([
    connection.getGenesisHash(), connection.getVersion(),
    connection.getMultipleAccountsInfoAndContext([PROGRAM_ID, configPda()], { commitment: 'finalized' }),
    connection.getMinimumBalanceForRentExemption(DOMAIN_SIZE, 'finalized'),
    connection.getMinimumBalanceForRentExemption(PRIMARY_SIZE, 'finalized'),
    connection.getLatestBlockhash('finalized'),
  ]);
  let pinned: ChainSnapshot | undefined;
  try { pinned = JSON.parse(await readFile('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (pinned && pinned.genesisHash !== genesisHash) throw new Error('Chain genesis differs from recorded Cookie evidence');
  if (process.env.EXPECTED_GENESIS_HASH && process.env.EXPECTED_GENESIS_HASH !== genesisHash) throw new Error('Unexpected chain genesis');
  const program = required(first.value[0], 'registry program');
  if (!program.executable || !program.owner.equals(UPGRADEABLE_LOADER) || program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) {
    throw new Error('Unsupported registry program loader/layout');
  }
  const configAccount = required(first.value[1], 'config');
  const config = decodeConfig(configAccount);
  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const second = await connection.getMultipleAccountsInfoAndContext(
    [programDataAddress, SYSVAR_RENT_PUBKEY, config.feeReceiver],
    { commitment: 'finalized', minContextSlot: first.context.slot },
  );
  const programData = required(second.value[0], 'program data');
  if (!programData.owner.equals(UPGRADEABLE_LOADER) || programData.executable || programData.data.length <= 45 || programData.data.readUInt32LE(0) !== 3) {
    throw new Error('Unsupported program data layout');
  }
  const authorityOption = programData.data[12];
  if (authorityOption !== 0 && authorityOption !== 1) throw new Error('Invalid upgrade authority option');
  const elf = programData.data.subarray(45);
  if (!elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Program data is not ELF');
  const elfSha256 = createHash('sha256').update(elf).digest('hex');
  if (pinned && pinned.programData.elfSha256 !== elfSha256) throw new Error('Registry executable changed; review and record a new baseline before running proof');
  const sampleName = 'firstbiteproof'.padEnd(32, 'x');
  const actors = Array.from({ length: 3 }, () => Keypair.generate());
  const price = registrationPrice(config, sampleName);
  const domainRent = exactNumber(domainRentNumber);
  const primaryRent = exactNumber(primaryRentNumber);
  const tx = buildSponsoredTransaction({ label: sampleName, sponsor: actors[0]!.publicKey, attemptPayer: actors[1]!.publicKey, user: actors[2]!.publicKey, feeReceiver: config.feeReceiver, registrationPrice: price, domainRent, primaryRent, blockhash: block.blockhash });
  const fee = exactNumber(required((await connection.getFeeForMessage(tx.compileMessage(), 'finalized')).value, 'message fee'));
  // Conservative planning allowance for a separate recovery operation, not a live authorization.
  const recoveryAllowance = fee;
  const perPass = maximumReservation({ price, domainRent, primaryRent, transactionFee: fee, recoveryAllowance });
  const snapshot: ChainSnapshot = {
    observedAt: new Date().toISOString(), endpoint: new URL(endpoint).origin, genesisHash, apiVersion: version,
    slots: { programAndConfig: first.context.slot, programDataAndRent: second.context.slot },
    program: saveAccount(PROGRAM_ID, program), config: saveAccount(configPda(), configAccount),
    feeReceiver: saveAccount(config.feeReceiver, required(second.value[2], 'fee receiver')),
    rent: saveAccount(SYSVAR_RENT_PUBKEY, required(second.value[1], 'rent sysvar')),
    programData: { address: programDataAddress.toBase58(), deploymentSlot: programData.data.readBigUInt64LE(4).toString(), upgradeAuthority: authorityOption === 1 ? new PublicKey(programData.data.subarray(13, 45)).toBase58() : null, elfSha256, elfBytes: elf.length },
    quote: { price: price.toString(), domainRent: domainRent.toString(), primaryRent: primaryRent.toString(), messageFee: fee.toString(), recoveryAllowance: recoveryAllowance.toString(), totalPerPass: perPass.toString(), tenPassEstimate: (perPass * 10n).toString(), transactionBytes: unsignedBytes(tx).length, sampleName, ...block },
  };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/registry.so', elf);
  await writeFile('.cache/chain-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ observedAt: snapshot.observedAt, genesisHash, elfSha256, configBytes: CONFIG_SIZE, quote: snapshot.quote, output: '.cache/chain-snapshot.json', networkWrites: 0 }, null, 2));
}

if (process.argv[1]?.endsWith('inspect-chain.ts')) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Chain inspection failed'); process.exitCode = 1; });
}
