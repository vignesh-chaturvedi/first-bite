# One-registration runner

This separate local tool prepares one fixed `.cook` registration. The newcomer
and sponsor each approve the same message in Nightly. The runner adds its own
attempt-payer signature only after an explicit send confirmation, then checks
the finalized transaction, sponsor debit, domain owner and primary-name record.
It does not activate the application relay or issue campaign invitations.

The [successful diagnostic](evidence/nightly-signature-pass.md) establishes the
newcomer signature path. It does not establish this runner's sponsor approval or
live execution. The manual sponsor approval is specific to this smoke test;
the intended campaign experience remains one approval for each newcomer.

## Initialize once

Use Node 24 and the project's pinned dependencies. Put a config file in the
ignored `artifacts/private/registration-smoke/` directory, with these fields:

```json
{
  "name": "firstbitecheck0001",
  "sponsor": "SPONSOR_PUBLIC_ADDRESS",
  "user": "NEWCOMER_PUBLIC_ADDRESS",
  "limits": {
    "maxRegistrationPrice": "15000000000000",
    "maxTransactionFee": "100000",
    "recoveryAllowance": "100000",
    "maxTotalSpend": "15001000000000"
  }
}
```

Replace the two placeholders with distinct Cookie public addresses. Amounts are
exact native units: 1 COOK = 1,000,000,000 units. These example ceilings mean
15,000 COOK registration, 0.0001 COOK transaction fee, 0.0001 COOK recovery
allowance, and 15,001 COOK total. A ceiling is not a fresh price or authorization
to spend. The runner reads the current chain and displays the actual quote.
The newcomer must have zero COOK and be eligible for the selected name/primary.

From the project root, after saving `config.json`:

```sh
pnpm phase0:registration init \
  --config artifacts/private/registration-smoke/config.json \
  --state-dir artifacts/private/registration-smoke/journal \
  --key-file artifacts/private/registration-smoke/master.key
```

The command creates a fresh attempt payer and an independent local encryption
key, then stores the fixed configuration and attempt key in an encrypted journal.
It never asks for either Nightly wallet's private key. Initialization refuses to
overwrite the master key or reinitialize an existing registration. Keep the
private parent directory at mode 700 and files at mode 600. The key and config
must be outside the journal directory. Do not commit or upload the private folder.

## Review before the live test

```sh
pnpm phase0:registration serve \
  --state-dir artifacts/private/registration-smoke/journal \
  --key-file artifacts/private/registration-smoke/master.key
```

Open `http://127.0.0.1:8788` in the browser with Nightly installed. Sending is
disabled by default. Preparing reads the pinned Cookie registry, checks the
actual durable attempt payer and zero-balance newcomer, obtains fresh price/rent/
fee data and simulates the exact unsigned transaction. It moves no funds.
The old diagnostic remains separate at `http://127.0.0.1:8787/sponsor`.

Review the name, full sponsor/newcomer addresses, actual attempt address, price,
fees, total and configured ceiling before approving a live test. Record the
exact Nightly/browser versions and prompt/warnings during the successful run.
The download does not invent these observations or read the extension's UI.

## Execute the reviewed test

After the concrete test is authorized, stop the preparation server with Ctrl+C
and restart the same command with `--allow-live`. Keep the same journal and key.
Starting the process never requests a signature or sends automatically.

1. Select the empty newcomer in Nightly on Cookie, then connect on the page.
2. Prepare a fresh registration. The local quote lasts at most 60 seconds and
   the chain's blockhash may expire earlier. Complete both approvals and the
   final send within its lifetime; preparation shows a countdown.
3. Click **Approve as newcomer in Nightly** and inspect the prompt before approval.
4. Switch to the funded sponsor account in Nightly, reconnect on the page, then
   click **Approve as sponsor in Nightly**. Both wallets independently sign the
   exact same unsigned message. Their approvals are saved separately.
5. Review the final amount/name/accounts, tick the spending confirmation and click
   **Send real registration**. The server checks the acknowledged message digest
   and ceiling, refreshes the chain checks, persists authorization, adds the
   attempt signature and durably saves the full transaction before sending.
6. Click **Check finality and ownership** until a finalized result is available.
   Download the metadata report. Independently resolve the name through an
   existing Cookie ecosystem tool and record that separate observation.

No click is retried automatically. A stale message before sending can be
reprepared, which discards both old approvals. Never prepare a second journal
to get past an uncertain send or an unresolved attempt balance.

## Restart and reconciliation

Use Ctrl+C for clean shutdown, then reopen the same journal with the same key.
Restarting does not sign or send. For `submitted`, `broadcast_unknown`,
`broadcasting`, or `confirmed`, use **Check finality and ownership**. The runner
only observes the original signature; it does not create or resend another
transaction. Finalized receipt verification checks all three signatures and
exact bytes, cost deltas, owner and primary-name state against the fixed quote.

If interrupted before broadcast at `authorized` or `signed`, the page permits
an explicit, newly confirmed send of the same still-fresh message. An expired
message in those states requires inspection. `manual_review` also means stop and
inspect: an expired missing result is not proof of failure. A residual attempt
balance retains custody and needs separate recovery; this first runner performs
no automatic sweep. A finalized failed transaction may have charged a fee.

Crashes or uncertain disk writes retain the exclusive `.lock`. The tool does
not automatically remove stale locks or discard interrupted snapshots. Confirm
the original process is stopped, preserve the directory, and inspect the latest
valid record and on-chain signature before any deliberate lock recovery.

## Storage and evidence limits

Snapshots use AES-256-GCM, authenticated sequence links, exclusive creation,
file/directory fsync and an exclusive process lock. Corrupt, interrupted, missing
intermediate or reordered records fail closed. An entire old backup or a removed
tail cannot be detected without an external anchor. Do not roll back or move the
journal; its absolute path is authenticated. Backups must preserve that path and
be reviewed against the chain before reuse.

The local master key is stored beside the encrypted journal. This protects
against accidental exposure of a snapshot alone; it is not a hardware signer or
protection against another process with access to both. Historical encrypted
snapshots retain attempt keys and signed payloads even after the current state
clears the attempt key. Protect the complete directory throughout retention.

HTTP binds only to loopback, accepts a fixed set of routes, checks Host/Origin
and a random session token, caps bodies and excludes raw errors/payloads from
metadata exports. Never expose this process through a tunnel. Only the dedicated
wallet-request response contains unsigned transaction bytes. Registration state
and candidate custody survive clean restarts; session tokens do not.

A runner result never sets `phase0GateComplete` to true. Live wallet/version
evidence, independent resolution and the finite pilot budget/distributor remain
separate requirements in [progress](progress.md).

## Local checks

```sh
pnpm test:smoke
pnpm test:smoke-proof
pnpm typecheck
pnpm lint
```

The proof suite requires the pinned `.cache/registry.so` from `pnpm phase0:inspect`.
It executes the actual saved registry program inside LiteSVM with synthetic funds,
then reopens the encrypted journal and verifies settlement. Its finality/slot
observations are test adapters, not live-chain evidence.

The other tests use synthetic wallets and chain observations, temporary private
journals and loopback servers. They cover signature integrity, spend and expiry
gates, persistence before broadcast, ambiguous sends/restarts, settlement,
browser controls and storage/HTTP boundaries. They do not spend real COOK.
