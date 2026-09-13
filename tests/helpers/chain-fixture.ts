import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { vi } from 'vitest';
import { createRegistryClient, type RegistryClientOptions, type RegistryReadConnection } from '../../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY } from '../../src/lib/chain/policy';
import { PRIMARY_SIZE, PROGRAM_ID } from '../../src/lib/cookie/registry';
import type { ChainSnapshot, SavedAccount } from '../../scripts/phase0/inspect-chain';

export const chainSnapshot = JSON.parse(readFileSync('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot;
const key = (byte: number) => Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey;

export function systemAccount(lamports = 0): AccountInfo<Buffer> {
  return { owner: SystemProgram.programId, executable: false, data: Buffer.alloc(0), lamports };
}

export function primaryAccount(owner: PublicKey, name = '', lamports = Number(COOKIE_REGISTRY_POLICY.primaryRent)): AccountInfo<Buffer> {
  const data = Buffer.alloc(PRIMARY_SIZE);
  Buffer.from('e7ff3d3f8eb8fe2a', 'hex').copy(data);
  owner.toBuffer().copy(data, 8);
  data.writeUInt32LE(name.length, 40);
  Buffer.from(name).copy(data, 44);
  data[44 + name.length] = PublicKey.findProgramAddressSync([Buffer.from('primary'), owner.toBuffer()], PROGRAM_ID)[1];
  return { data, owner: PROGRAM_ID, executable: false, lamports };
}

function restore(account: SavedAccount): AccountInfo<Buffer> {
  return { data: Buffer.from(account.dataBase64, 'base64'), owner: new PublicKey(account.owner), executable: account.executable, lamports: Number(account.lamports) };
}

/** Synthetic ELF only; production pin values are checked independently against evidence. */
export function chainFixture(options: Omit<RegistryClientOptions, 'connection' | 'policy'> = {}) {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 7)]);
  const policy = { ...COOKIE_REGISTRY_POLICY, programBytes: elf.length, programSha256: createHash('sha256').update(elf).digest('hex') };
  const programData = Buffer.alloc(45 + elf.length);
  programData.writeUInt32LE(3);
  programData.writeBigUInt64LE(policy.deploymentSlot, 4);
  programData[12] = 1;
  new PublicKey(policy.upgradeAuthority).toBuffer().copy(programData, 13);
  elf.copy(programData, 45);
  const input = { label: 'firstbite', sponsor: key(1), attemptPayer: key(2), user: key(3) };
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [chainSnapshot.program.address, restore(chainSnapshot.program)],
    [chainSnapshot.config.address, restore(chainSnapshot.config)],
    [chainSnapshot.rent.address, restore(chainSnapshot.rent)],
    [chainSnapshot.feeReceiver.address, restore(chainSnapshot.feeReceiver)],
    [policy.programDataAddress, { owner: new PublicKey(policy.loaderAddress), data: programData, executable: false, lamports: 1_000_000 }],
    [input.sponsor.toBase58(), systemAccount(1_000_000_000_000_000)],
  ]);
  let slot = 100;
  const connection = {
    getGenesisHash: vi.fn(async () => policy.genesisHash),
    getMultipleAccountsInfoAndContext: vi.fn<RegistryReadConnection['getMultipleAccountsInfoAndContext']>(async (keys) => ({
      context: { slot: slot++ }, value: keys.map((address) => accounts.get(address.toBase58()) ?? null),
    })),
    getMinimumBalanceForRentExemption: vi.fn<RegistryReadConnection['getMinimumBalanceForRentExemption']>(async (size) =>
      Number(size === 149 ? policy.domainRent : policy.primaryRent)),
    getLatestBlockhashAndContext: vi.fn<RegistryReadConnection['getLatestBlockhashAndContext']>(async () => ({
      context: { slot: Math.max(101, slot++) }, value: { blockhash: key(4).toBase58(), lastValidBlockHeight: 200 },
    })),
    getFeeForMessage: vi.fn<RegistryReadConnection['getFeeForMessage']>(async () => ({ context: { slot: 102 }, value: 15000 })),
  };
  const client = createRegistryClient('https://rpc.invalid/secret-token', {
    connection, policy, clock: () => 1_800_000_000_000, ...options,
  });
  return { client, connection, policy, input, accounts };
}
