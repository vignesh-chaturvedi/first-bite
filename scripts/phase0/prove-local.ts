import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { address, lamports } from '@solana/kit';
import { SystemProgram } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { configPda, decodeDomain, decodePrimary, domainPda, primaryPda, registrationPrice } from '../../src/lib/cookie/registry.js';
import { unsignedBytes } from '../../src/lib/cookie/transaction.js';
import { account, balance, localRegistry, replaceData } from '../../tests/helpers/local-registry.js';

async function main(): Promise<void> {
  const scenarios = ['unchanged-price', 'price-increased', 'price-decreased', 'non-divisible-price'] as const;
  const results = scenarios.map((scenario) => {
    const proof = localRegistry();
    const { svm, snapshot, sponsor, attempt, user } = proof;
    const initialUserBalance = scenario === 'price-increased' ? 5_000_000_000n : 0n;
    if (initialUserBalance) {
      svm.setAccount({ address: address(user.publicKey.toBase58()), programAddress: address(SystemProgram.programId.toBase58()), executable: false, data: new Uint8Array(), space: 0n, lamports: lamports(initialUserBalance) });
    }
    if (scenario === 'non-divisible-price') {
      const data = Buffer.from(account(svm, configPda())!.data);
      data.writeBigUInt64LE(101n, 72);
      replaceData(svm, configPda(), data);
      proof.config.cookUsdPriceMicro = 101n;
    }
    const name = snapshot.quote.sampleName;
    const quotedPrice = registrationPrice(proof.config, name);
    const tx = proof.build(name);
    const bytes = unsignedBytes(tx).length;
    if (scenario === 'price-increased' || scenario === 'price-decreased') {
      const data = Buffer.from(account(svm, configPda())!.data);
      data.writeBigUInt64LE(proof.config.longNameUsdCents + (scenario === 'price-increased' ? 1n : -1n), 88);
      replaceData(svm, configPda(), data);
    }
    const before = balance(svm, sponsor.publicKey);
    const result = proof.send(tx);
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    const domain = account(svm, domainPda(name));
    const primary = account(svm, primaryPda(user.publicKey));
    const sponsorDebit = before - balance(svm, sponsor.publicKey);
    const attemptResidual = balance(svm, attempt.publicKey);
    const userBalance = balance(svm, user.publicKey);
    const domainOwnedByUser = domain ? decodeDomain(domain, name).owner.equals(user.publicKey) : false;
    const primaryMatches = primary ? decodePrimary(primary, user.publicKey).name === name : false;
    assert.equal(failed, scenario === 'price-increased', `${scenario}: unexpected execution result`);
    assert.equal(userBalance, initialUserBalance, `${scenario}: user balance changed`);
    assert.equal(attemptResidual, scenario === 'price-decreased' ? 100_000_000_000n : 0n, `${scenario}: unexpected attempt residual`);
    assert.equal(domainOwnedByUser, !failed, `${scenario}: domain ownership mismatch`);
    assert.equal(primaryMatches, !failed, `${scenario}: primary mismatch`);
    assert.equal(sponsorDebit, failed ? BigInt(snapshot.quote.messageFee) : quotedPrice + BigInt(snapshot.quote.domainRent) + BigInt(snapshot.quote.primaryRent) + BigInt(snapshot.quote.messageFee), `${scenario}: sponsor debit mismatch`);
    assert.ok(meta.computeUnitsConsumed() <= 200_000n && bytes <= 1_232);
    return { scenario, execution: failed ? 'failed' : 'succeeded', transactionBytes: bytes, computeUnits: meta.computeUnitsConsumed().toString(), sponsorDebit: sponsorDebit.toString(), attemptResidual: attemptResidual.toString(), initialUserBalance: initialUserBalance.toString(), userBalance: userBalance.toString(), domainOwnedByUser, primaryMatches, error: failed ? result.toString() : null, logs: meta.logs() };
  });
  const output = { observedAt: new Date().toISOString(), environment: 'Local LiteSVM execution of pinned deployed ELF; no chain writes or Nightly interaction', liveWalletGate: 'pending', scenarios: results };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/local-proof.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ output: '.cache/local-proof.json', scenarios: results.map(({ logs: _logs, error: _error, ...summary }) => summary) }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Local proof failed'); process.exitCode = 1; });
