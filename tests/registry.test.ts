import { readFileSync } from 'node:fs';
import { PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  PROGRAM_ID, CONFIG_SIZE, DOMAIN_SIZE, PRIMARY_SIZE,
  normalizeName, configPda, domainPda, primaryPda,
  decodeConfig, decodeDomain, decodePrimary, registrationPrice,
  registerDomainIx, transferDomainIx, setPrimaryDomainIx,
  type RegistryConfig,
} from '../src/lib/cookie/registry.js';

const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
const payer = key(1);
const user = key(2);
const receiver = key(3);
const label = 'alice';
const derive = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);

function account(data: Buffer): AccountInfo<Buffer> {
  return { data, owner: PROGRAM_ID, executable: false, lamports: 1_000_000, rentEpoch: 0 };
}

function configAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(98);
  Buffer.from('9b0caae01efacc82', 'hex').copy(data);
  key(4).toBuffer().copy(data, 8);
  receiver.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(100n, 72);
  data.writeBigUInt64LE(350n, 80);
  data.writeBigUInt64LE(150n, 88);
  data.writeUInt8(9, 96);
  data.writeUInt8(derive(Buffer.from('config'))[1], 97);
  return account(data);
}

function domainAccount(name = label): AccountInfo<Buffer> {
  const data = Buffer.alloc(149);
  Buffer.from('239262700de6e799', 'hex').copy(data);
  data.writeUInt32LE(name.length, 8);
  Buffer.from(name).copy(data, 12);
  const end = 12 + name.length;
  user.toBuffer().copy(data, end);
  key(5).toBuffer().copy(data, end + 32);
  data.writeBigInt64LE(1_789_294_500n, end + 96);
  data.writeUInt8(derive(Buffer.from('domain'), Buffer.from(name))[1], end + 104);
  return account(data);
}

function primaryAccount(name = label): AccountInfo<Buffer> {
  const data = Buffer.alloc(77);
  Buffer.from('e7ff3d3f8eb8fe2a', 'hex').copy(data);
  user.toBuffer().copy(data, 8);
  data.writeUInt32LE(name.length, 40);
  Buffer.from(name).copy(data, 44);
  data.writeUInt8(derive(Buffer.from('primary'), user.toBuffer())[1], 44 + name.length);
  return account(data);
}

describe('campaign names', () => {
  it.each([
    [' Alice.COOK ', 'alice'], ['four', 'four'], ['foo-bar1.cook', 'foo-bar1'],
    ['a'.repeat(32), 'a'.repeat(32)],
  ])('normalizes %s', (input, expected) => expect(normalizeName(input)).toBe(expected));

  it.each(['', 'abc', 'abc.cook', '-four', 'four-', 'a'.repeat(33), 'four_name', 'four name', 'café', '😀name', 'alice.cook.cook', 'cook.', 'a/bc'])
    ('rejects ineligible input %s', (input) => expect(() => normalizeName(input)).toThrow());

  it('requires internal labels to already be normalized', () => {
    for (const input of ['ALICE', 'alice.cook', ' alice ']) expect(() => domainPda(input)).toThrow(/normalized/);
  });
});

describe('pinned instruction contract', () => {
  const idl = JSON.parse(readFileSync(new URL('../vendor/cookie-domains/idl.json', import.meta.url), 'utf8')) as {
    address: string;
    instructions: Array<{ name: string; discriminator: number[]; accounts: Array<{ name: string; signer?: boolean; writable?: boolean }>; args: Array<{ name: string; type: string }> }>;
  };

  it('pins the registry and observed config address', () => {
    expect(PROGRAM_ID.toBase58()).toBe(idl.address);
    expect(configPda().toBase58()).toBe('4s4DK5eMahyNXe8UarT3q3WPC95Q2wqRfEP19JWXmMGg');
    expect(domainPda(label).equals(derive(Buffer.from('domain'), Buffer.from(label))[0])).toBe(true);
    expect(primaryPda(user).equals(derive(Buffer.from('primary'), user.toBuffer())[0])).toBe(true);
  });

  it('matches the independently inspected IDL order, privileges and discriminator', () => {
    const cases = [
      { name: 'register_domain', ix: registerDomainIx({ label, payer, feeReceiver: receiver }), names: ['config', 'domain', 'payer', 'fee_receiver', 'system_program'], keys: [configPda(), domainPda(label), payer, receiver, SystemProgram.programId] },
      { name: 'transfer_domain', ix: transferDomainIx({ label, currentOwner: payer, newOwner: user }), names: ['domain', 'current_owner'], keys: [domainPda(label), payer] },
      { name: 'set_primary_domain', ix: setPrimaryDomainIx({ label, owner: user }), names: ['primary', 'domain', 'owner', 'system_program'], keys: [primaryPda(user), domainPda(label), user, SystemProgram.programId] },
    ];
    for (const test of cases) {
      const contract = idl.instructions.find((instruction) => instruction.name === test.name)!;
      expect(contract.accounts.map((meta) => meta.name)).toEqual(test.names);
      expect(test.ix.programId.equals(PROGRAM_ID)).toBe(true);
      expect([...test.ix.data.subarray(0, 8)]).toEqual(contract.discriminator);
      expect(test.ix.keys.map((meta) => [meta.isSigner, meta.isWritable]))
        .toEqual(contract.accounts.map((meta) => [meta.signer ?? false, meta.writable ?? false]));
      expect(test.ix.keys.map((meta) => meta.pubkey.toBase58())).toEqual(test.keys.map((pubkey) => pubkey.toBase58()));
    }
  });

  it('uses golden byte encodings including the argument-free primary instruction', () => {
    expect(registerDomainIx({ label, payer, feeReceiver: receiver }).data.toString('hex'))
      .toBe('ec07d097ad95496805000000616c696365');
    expect(transferDomainIx({ label, currentOwner: payer, newOwner: user }).data.toString('hex'))
      .toBe('8173c12bae05f134' + '02'.repeat(32));
    expect(setPrimaryDomainIx({ label, owner: user }).data.toString('hex')).toBe('1202aaacbe8cf21b');
    expect(idl.instructions.find((instruction) => instruction.name === 'set_primary_domain')!.args).toEqual([]);
  });
});

describe('strict registry account decoding', () => {
  it('decodes config and dynamic domain/primary offsets', () => {
    expect([CONFIG_SIZE, DOMAIN_SIZE, PRIMARY_SIZE]).toEqual([98, 149, 77]);
    const config = decodeConfig(configAccount());
    expect(config.admin.equals(key(4))).toBe(true);
    expect(config.feeReceiver.equals(receiver)).toBe(true);
    expect(config.cookUsdPriceMicro).toBe(100n);
    expect(config.shortNameUsdCents).toBe(350n);
    expect(config.longNameUsdCents).toBe(150n);
    for (const name of [label, 'a'.repeat(32)]) {
      const domain = decodeDomain(domainAccount(name), name);
      expect(domain.name).toBe(name);
      expect(domain.owner.equals(user)).toBe(true);
      expect(domain.resolver?.equals(key(5))).toBe(true);
      expect(domain.metadata).toBeNull();
      expect(domain.createdAt).toBe(1_789_294_500n);
      expect(decodePrimary(primaryAccount(name), user).name).toBe(name);
    }
  });

  it('recognizes legitimate existing short and cleared primary records', () => {
    expect(decodePrimary(primaryAccount('abc'), user).name).toBe('abc');
    expect(decodePrimary(primaryAccount(''), user).name).toBeNull();
  });

  it('rejects wrong owners, executable data, unsupported sizes and wrong discriminators', () => {
    const cases = [
      { make: configAccount, decode: (info: AccountInfo<Buffer>) => decodeConfig(info) },
      { make: domainAccount, decode: (info: AccountInfo<Buffer>) => decodeDomain(info, label) },
      { make: primaryAccount, decode: (info: AccountInfo<Buffer>) => decodePrimary(info, user) },
    ];
    for (const test of cases) {
      expect(() => test.decode({ ...test.make(), owner: SystemProgram.programId })).toThrow(/registry-owned/);
      expect(() => test.decode({ ...test.make(), executable: true })).toThrow(/registry-owned/);
      const original = test.make();
      expect(() => test.decode({ ...original, data: original.data.subarray(0, original.data.length - 1) })).toThrow(/allocation/);
      expect(() => test.decode({ ...original, data: Buffer.concat([original.data, Buffer.alloc(1)]) })).toThrow(/allocation/);
      original.data[0] = 0;
      expect(() => test.decode(original)).toThrow(/discriminator/);
    }
    const legacy = domainAccount();
    expect(() => decodeDomain({ ...legacy, data: legacy.data.subarray(0, 85) }, label)).toThrow(/allocation/);
  });

  it('rejects forged bumps and mismatched embedded identities', () => {
    const config = configAccount(); config.data[97] = config.data[97]! ^ 1;
    expect(() => decodeConfig(config)).toThrow(/bump/);
    const domain = domainAccount(); domain.data[116 + label.length] = domain.data[116 + label.length]! ^ 1;
    expect(() => decodeDomain(domain, label)).toThrow(/bump/);
    const primary = primaryAccount(); primary.data[44 + label.length] = primary.data[44 + label.length]! ^ 1;
    expect(() => decodePrimary(primary, user)).toThrow(/bump/);
    expect(() => decodeDomain(domainAccount(), 'other')).toThrow(/expected PDA/);
    expect(() => decodePrimary(primaryAccount(), payer)).toThrow(/expected PDA/);
  });

  it('rejects corrupt string lengths, non-ASCII bytes and invalid labels', () => {
    for (const length of [33, 0xffff_ffff]) {
      const domain = domainAccount(); domain.data.writeUInt32LE(length, 8);
      expect(() => decodeDomain(domain, label)).toThrow(/length/);
      const primary = primaryAccount(); primary.data.writeUInt32LE(length, 40);
      expect(() => decodePrimary(primary, user)).toThrow(/length/);
    }
    for (const byte of [0xe1, 0x41, 0x2f]) {
      const domain = domainAccount(); domain.data[12] = byte;
      expect(() => decodeDomain(domain, label)).toThrow(/ASCII|name/);
      const primary = primaryAccount(); primary.data[44] = byte;
      expect(() => decodePrimary(primary, user)).toThrow(/ASCII|name/);
    }
  });
});

describe('exact registration pricing', () => {
  it('reproduces the observed long-tier quote and floors non-divisible prices', () => {
    const config = decodeConfig(configAccount());
    expect(registrationPrice(config, label)).toBe(15_000_000_000_000n);
    expect(registrationPrice({ ...config, cookUsdPriceMicro: 7n, longNameUsdCents: 1n }, label)).toBe(1_428_571_428_571n);
  });

  it('rejects non-nine decimals, zero, negative and out-of-u64 configuration', () => {
    const config = decodeConfig(configAccount());
    for (const field of ['cookUsdPriceMicro', 'shortNameUsdCents', 'longNameUsdCents'] as const) {
      for (const value of [0n, -1n, 1n << 64n]) {
        expect(() => registrationPrice({ ...config, [field]: value }, label)).toThrow(/positive u64/);
      }
    }
    expect(() => registrationPrice({ ...config, nativeDecimals: 6 }, label)).toThrow(/nine/);
    const malformed = configAccount(); malformed.data[96] = 6;
    expect(() => decodeConfig(malformed)).toThrow(/nine/);
    malformed.data[96] = 9; malformed.data.writeBigUInt64LE(0n, 72);
    expect(() => decodeConfig(malformed)).toThrow(/positive u64/);
  });

  it('rejects zero or overflowing final native amounts', () => {
    const config: RegistryConfig = decodeConfig(configAccount());
    expect(() => registrationPrice({ ...config, cookUsdPriceMicro: 1n, longNameUsdCents: (1n << 64n) - 1n }, label)).toThrow(/positive u64/);
    expect(() => registrationPrice({ ...config, cookUsdPriceMicro: (1n << 64n) - 1n, longNameUsdCents: 1n }, label)).toThrow(/positive u64/);
  });
});
