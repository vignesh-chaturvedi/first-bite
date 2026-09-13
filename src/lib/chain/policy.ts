/** Reviewed against docs/evidence/chain-snapshot.json. Changes require a new proof. */
export interface RegistryPolicy {
  readonly id: string;
  readonly genesisHash: string;
  readonly programAddress: string;
  readonly loaderAddress: string;
  readonly configAddress: string;
  readonly configSha256: string;
  readonly feeReceiverAddress: string;
  readonly programDataAddress: string;
  readonly deploymentSlot: bigint;
  readonly upgradeAuthority: string;
  readonly programSha256: string;
  readonly programBytes: number;
  readonly rentSha256: string;
  readonly domainRent: bigint;
  readonly primaryRent: bigint;
}

export const COOKIE_REGISTRY_POLICY: RegistryPolicy = Object.freeze({
  id: 'cookie-registry-2026-09-13-v1',
  genesisHash: '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2',
  programAddress: 'H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA',
  loaderAddress: 'BPFLoaderUpgradeab1e11111111111111111111111',
  configAddress: '4s4DK5eMahyNXe8UarT3q3WPC95Q2wqRfEP19JWXmMGg',
  configSha256: 'cdd8c6d98014ff50f70004c41f3c81975ef47234b4c2e34ee3562531798a763d',
  feeReceiverAddress: 'HrbhP5Q9ohsY63Ah6abkUJG8jjuYf1esazsAWvKVg1X7',
  programDataAddress: '8RkUR6ksTVomXiyH8pNpoq7X35a5gQJjZnCX4sESHuoM',
  deploymentSlot: 1741187n,
  upgradeAuthority: '2ABpDq4qwMdk8kgpGyZQbmVsJdd1SbxjEH84xcgK9Dzg',
  programSha256: 'c61dadce0ddbe48f2c74d973deefe8e1af79aacfbb12b8edd891162a18ead254',
  programBytes: 322280,
  rentSha256: '90dfa0c787553fcd84ca093a258dd3bc781915b0636309e8eecb0187b8613c98',
  domainRent: 1927920n,
  primaryRent: 1426800n,
});
