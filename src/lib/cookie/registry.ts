import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA');
export const CONFIG_SIZE = 98;
export const DOMAIN_SIZE = 149;
export const PRIMARY_SIZE = 77;

const U64_MAX = (1n << 64n) - 1n;
const DISC = {
  config: Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]),
  domain: Buffer.from([35, 146, 98, 112, 13, 230, 231, 153]),
  primary: Buffer.from([231, 255, 61, 63, 142, 184, 254, 42]),
  register: Buffer.from([236, 7, 208, 151, 173, 149, 73, 104]),
  transfer: Buffer.from([129, 115, 193, 43, 174, 5, 241, 52]),
  primaryInstruction: Buffer.from([18, 2, 170, 172, 190, 140, 242, 27]),
};

export interface RegistryConfig {
  admin: PublicKey;
  feeReceiver: PublicKey;
  cookUsdPriceMicro: bigint;
  shortNameUsdCents: bigint;
  longNameUsdCents: bigint;
  nativeDecimals: number;
  bump: number;
}

export interface RegistryDomain {
  name: string;
  owner: PublicKey;
  resolver: PublicKey | null;
  metadata: PublicKey | null;
  createdAt: bigint;
  bump: number;
}

export interface RegistryPrimary {
  owner: PublicKey;
  /** A cleared primary record remains allocated with an empty name. */
  name: string | null;
  bump: number;
}

function validRegistryLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label);
}

/** Normalize user input, then enforce the campaign's 4–32 ASCII character tier. */
export function normalizeName(input: string): string {
  let label = input.trim().toLowerCase();
  if (label.endsWith('.cook')) label = label.slice(0, -5);
  if (label.length < 4 || !validRegistryLabel(label)) {
    throw new Error('Name must contain 4–32 ASCII letters, digits or hyphens, without edge hyphens');
  }
  return label;
}

function requireLabel(label: string): void {
  if (normalizeName(label) !== label) throw new Error('Expected a normalized bare name');
}

function configAddress(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
}

function domainAddress(label: string): [PublicKey, number] {
  requireLabel(label);
  return PublicKey.findProgramAddressSync([Buffer.from('domain'), Buffer.from(label, 'ascii')], PROGRAM_ID);
}

function primaryAddress(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('primary'), owner.toBuffer()], PROGRAM_ID);
}

export function configPda(): PublicKey { return configAddress()[0]; }
export function domainPda(label: string): PublicKey { return domainAddress(label)[0]; }
export function primaryPda(owner: PublicKey): PublicKey { return primaryAddress(owner)[0]; }

function checkAccount(account: AccountInfo<Buffer>, size: number, discriminator: Buffer): Buffer {
  if (!account.owner.equals(PROGRAM_ID) || account.executable) {
    throw new Error('Account must be a non-executable registry-owned account');
  }
  if (account.data.length !== size) throw new Error(`Unsupported registry account allocation: expected ${size}`);
  if (!account.data.subarray(0, 8).equals(discriminator)) throw new Error('Wrong registry account discriminator');
  return account.data;
}

function positiveU64(value: bigint, field: string): void {
  if (value <= 0n || value > U64_MAX) throw new Error(`${field} must be a positive u64`);
}

function checkPricing(config: RegistryConfig): void {
  if (config.nativeDecimals !== 9) throw new Error('Only nine native decimals are supported');
  positiveU64(config.cookUsdPriceMicro, 'COOK reference price');
  positiveU64(config.shortNameUsdCents, 'Short-name cents');
  positiveU64(config.longNameUsdCents, 'Long-name cents');
}

/** Fetch configPda() before calling: AccountInfo does not include its own address. */
export function decodeConfig(account: AccountInfo<Buffer>): RegistryConfig {
  const data = checkAccount(account, CONFIG_SIZE, DISC.config);
  const config: RegistryConfig = {
    admin: new PublicKey(data.subarray(8, 40)),
    feeReceiver: new PublicKey(data.subarray(40, 72)),
    cookUsdPriceMicro: data.readBigUInt64LE(72),
    shortNameUsdCents: data.readBigUInt64LE(80),
    longNameUsdCents: data.readBigUInt64LE(88),
    nativeDecimals: data.readUInt8(96),
    bump: data.readUInt8(97),
  };
  if (config.bump !== configAddress()[1]) throw new Error('Invalid config PDA bump');
  checkPricing(config);
  return config;
}

function readName(data: Buffer, lengthOffset: number, allowEmpty: boolean): string {
  const length = data.readUInt32LE(lengthOffset);
  if (length > 32 || (!allowEmpty && length === 0)) throw new Error('Corrupt registry name length');
  const bytes = data.subarray(lengthOffset + 4, lengthOffset + 4 + length);
  // Check bytes before decoding: Buffer's ASCII decoding otherwise masks the high bit.
  if (bytes.some((byte) => byte > 127)) throw new Error('Registry name must be ASCII');
  const name = bytes.toString('ascii');
  if (name !== '' && !validRegistryLabel(name)) throw new Error('Corrupt registry name');
  return name;
}

function pointer(data: Buffer, offset: number): PublicKey | null {
  const value = new PublicKey(data.subarray(offset, offset + 32));
  return value.equals(PublicKey.default) ? null : value;
}

/** Fetch domainPda(expectedLabel) first; legacy/malformed accounts never mean availability. */
export function decodeDomain(account: AccountInfo<Buffer>, expectedLabel: string): RegistryDomain {
  const [, expectedBump] = domainAddress(expectedLabel);
  const data = checkAccount(account, DOMAIN_SIZE, DISC.domain);
  const name = readName(data, 8, false);
  if (name !== expectedLabel) throw new Error('Domain name does not match expected PDA');
  const offset = 12 + name.length;
  const bump = data.readUInt8(offset + 104);
  if (bump !== expectedBump) throw new Error('Invalid domain PDA bump');
  return {
    name,
    owner: new PublicKey(data.subarray(offset, offset + 32)),
    resolver: pointer(data, offset + 32),
    metadata: pointer(data, offset + 64),
    createdAt: data.readBigInt64LE(offset + 96),
    bump,
  };
}

/** Fetch primaryPda(expectedOwner) first. Existing short or cleared primaries are valid records. */
export function decodePrimary(account: AccountInfo<Buffer>, expectedOwner: PublicKey): RegistryPrimary {
  const data = checkAccount(account, PRIMARY_SIZE, DISC.primary);
  const owner = new PublicKey(data.subarray(8, 40));
  if (!owner.equals(expectedOwner)) throw new Error('Primary owner does not match expected PDA');
  const name = readName(data, 40, true);
  const bump = data.readUInt8(44 + name.length);
  if (bump !== primaryAddress(expectedOwner)[1]) throw new Error('Invalid primary PDA bump');
  return { owner, name: name || null, bump };
}

/** Mirrors the pinned integration's integer division (floor), not floating-point or ceiling. */
export function registrationPrice(config: RegistryConfig, label: string): bigint {
  requireLabel(label);
  checkPricing(config);
  const amount = config.longNameUsdCents * 10_000n * 10n ** BigInt(config.nativeDecimals) / config.cookUsdPriceMicro;
  positiveU64(amount, 'Registration price');
  return amount;
}

export function registerDomainIx(args: { label: string; payer: PublicKey; feeReceiver: PublicKey }): TransactionInstruction {
  requireLabel(args.label);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(args.label.length);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: domainPda(args.label), isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.feeReceiver, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.register, length, Buffer.from(args.label, 'ascii')]),
  });
}

export function transferDomainIx(args: { label: string; currentOwner: PublicKey; newOwner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: domainPda(args.label), isSigner: false, isWritable: true },
      { pubkey: args.currentOwner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([DISC.transfer, args.newOwner.toBuffer()]),
  });
}

export function setPrimaryDomainIx(args: { label: string; owner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: primaryPda(args.owner), isSigner: false, isWritable: true },
      { pubkey: domainPda(args.label), isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISC.primaryInstruction),
  });
}
