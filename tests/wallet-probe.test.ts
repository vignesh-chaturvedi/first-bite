import { readFileSync } from 'node:fs';
import { Keypair, Transaction } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWalletProbe } from '../scripts/phase0/wallet-probe.js';
import type { ChainSnapshot } from '../scripts/phase0/inspect-chain.js';
import { unsignedBytes } from '../src/lib/cookie/transaction.js';

describe('loopback wallet diagnostic with synthetic signatures', () => {
  let probe: Awaited<ReturnType<typeof startWalletProbe>>;
  let token: string;
  const wallet = Keypair.generate();
  const snapshot = JSON.parse(readFileSync('docs/evidence/chain-snapshot.json', 'utf8')) as ChainSnapshot;

  beforeAll(async () => {
    probe = await startWalletProbe({ snapshot, port: 0, rpc: {
      getGenesisHash: async () => snapshot.genesisHash,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    } });
    const response = await fetch(probe.url);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await response.text();
    const bootstrap = html.match(/const config = (\{[^\n]+\});/);
    expect(bootstrap).not.toBeNull();
    token = (JSON.parse(bootstrap![1]!) as { token: string }).token;
  });
  afterAll(async () => { if (probe) await probe.close(); });

  async function post(path: string, body: unknown, origin = probe.url, session = token) {
    return fetch(`${probe.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Probe-Token': session }, body: JSON.stringify(body) });
  }

  it.each(['user-first', 'preserve-attempt-signature'])('verifies %s without creating a sponsor signature or broadcasting', async (mode) => {
    const prepare = await post('/prepare', { wallet: wallet.publicKey.toBase58(), mode });
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json() as { id: string; transactionBase64: string };
    const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
    tx.partialSign(wallet);
    const verify = await post('/verify', { id: prepared.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ userSignatureValid: true, messageUnchanged: true, sponsorSignaturePresent: false, broadcast: false, registrationCompleted: false, phase0GateComplete: false });
    const replay = await post('/verify', { id: prepared.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') });
    expect(replay.status).toBe(410);
  });

  it('rejects cross-origin requests, missing session tokens and arbitrary fields', async () => {
    const body = { wallet: wallet.publicKey.toBase58(), mode: 'user-first' };
    expect((await post('/prepare', body, 'https://unrelated.example')).status).toBe(403);
    expect((await post('/prepare', body, probe.url, '')).status).toBe(403);
    expect((await post('/prepare', { ...body, arbitraryInstructions: [] })).status).toBe(400);
    expect((await post('/broadcast', body)).status).toBe(404);
    expect((await post('/prepare', { wallet: 'a'.repeat(9000), mode: 'user-first' })).status).toBe(413);
  });

  it('rejects a changed signed message', async () => {
    const response = await post('/prepare', { wallet: wallet.publicKey.toBase58(), mode: 'user-first' });
    const prepared = await response.json() as { id: string; transactionBase64: string };
    const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.partialSign(wallet);
    expect((await post('/verify', { id: prepared.id, signedTransactionBase64: unsignedBytes(tx).toString('base64') })).status).toBe(400);
  });
});
