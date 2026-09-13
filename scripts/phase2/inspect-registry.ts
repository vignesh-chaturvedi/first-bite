import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { ConfigError, parseConfig } from '../../src/config/schema';
import { createRegistryClient, RegistryClientError } from '../../src/lib/chain/client';
import { COOKIE_REGISTRY_POLICY } from '../../src/lib/chain/policy';
import { normalizeName } from '../../src/lib/cookie/registry';
import { buildSponsoredTransaction, unsignedBytes } from '../../src/lib/cookie/transaction';
import { validateSponsoredMessage } from '../../src/lib/transactions/policy';

try {
  const config = parseConfig();
  if (config.expectedGenesisHash !== COOKIE_REGISTRY_POLICY.genesisHash) throw new ConfigError(['EXPECTED_GENESIS_HASH']);
  const client = createRegistryClient(config.cookieRpcUrl);
  const label = normalizeName(process.argv[2] ?? `firstbite-check-${randomBytes(5).toString('hex')}`);
  // Public identities only. No signer is retained, funded or used to sign.
  const sponsor = Keypair.generate().publicKey;
  const attemptPayer = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const observed = await client.observe({ label, sponsor, attemptPayer, user });
  const input = { ...observed };
  const transaction = buildSponsoredTransaction(input);
  validateSponsoredMessage(transaction.serializeMessage(), input);
  const fee = await client.getMessageFee(transaction.compileMessage(), observed.blockhashContextSlot);
  const output = {
    observedAt: new Date(observed.observedAtMs).toISOString(), policyId: observed.policyId,
    genesisHash: observed.genesisHash, programSha256: observed.programSha256, configSha256: observed.configSha256,
    observedSlot: observed.observedSlot, blockhashContextSlot: observed.blockhashContextSlot, name: label, availableAtObservation: true,
    registrationPrice: observed.registrationPrice.toString(), domainRent: observed.domainRent.toString(),
    primaryRent: observed.primaryRent.toString(), transactionFee: fee.toString(),
    estimatedExecutionDebit: (observed.registrationPrice + observed.domainRent + observed.primaryRent + fee).toString(),
    transactionBytes: unsignedBytes(transaction).length, lastValidBlockHeight: observed.lastValidBlockHeight,
    funded: false, networkWrites: 0,
  };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/phase2-observation.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'registry.inspection_failed',
    code: error instanceof RegistryClientError ? error.code : error instanceof ConfigError ? 'CONFIGURATION' : 'INVALID_INPUT_OR_MESSAGE' }));
  process.exitCode = 1;
}
