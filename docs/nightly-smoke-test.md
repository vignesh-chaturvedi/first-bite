# Nightly compatibility and live smoke test

**The sponsor-backed user-first diagnostic passed.** The user's report records
a valid newcomer signature, unchanged 690-byte transaction, matching Cookie
genesis and passing unsigned simulation. Verification completed at
`2026-09-15T20:27:20.323Z`, 11.317 seconds after preparation. See the
[successful report evidence](evidence/nightly-signature-pass.md).

No transaction was broadcast and no name was registered. The exact version and
prompt/warnings for the successful attempt still need a manual record. The next
development checkpoint is a separate runner for one reviewed real registration,
followed by finality, ownership/primary and independent resolution checks. Do
not repeat the successful diagnostic just to proceed with that development.

The earlier unfunded attempt failed with `AccountNotFound` and a provider
rejection; retain the [failure observation](evidence/nightly-failure-observation.md)
as history rather than treating it as the current result.

Follow-up inspection found that installed Nightly 1.51.24 refuses signing after
a transaction simulation error. A read-only RPC reproduction confirmed
`AccountNotFound` for this probe's deliberately unfunded fee payer. See the
[diagnosis and next checkpoint](evidence/nightly-signing-diagnosis.md).
Repeating the same unfunded approval is not the next test for that version.
The [sponsor-backed diagnostic](sponsor-signature-check.md) uses an existing
funded sponsor's public address. The user funded one account, selected the other
empty account as newcomer and obtained the successful report above. Do not fund
the old probe's random sponsor identities, whose secrets were discarded.

## Reproduce the sponsor-backed check

Run `pnpm phase0:wallet` and follow the
[sponsor-backed operator steps](sponsor-signature-check.md) at
`http://127.0.0.1:8787/sponsor`. That page checks current balances, pinned chain
state, costs and exact unsigned simulation before accepting a newcomer-only
signature. It also requires fresh chain identity and block height during
verification. No sponsor/attempt signature or broadcast is performed.

## Original unfunded probe — retained for diagnostic comparison

The following instructions and RPC/timeout descriptions apply to the original
root page only. It remains unsuitable for the observed Nightly version because
its deliberately unfunded fee payer causes simulation failure.

1. Install the pinned dependencies and finish the read-only chain inspection in
   the project README. The reviewed snapshot must exist at
   `docs/evidence/chain-snapshot.json`.
2. Start the probe from the project root:

   ```sh
   pnpm phase0:wallet
   ```

3. Open `http://127.0.0.1:8787` in the browser where the Nightly extension is
   installed. Use a disposable account with zero COOK. An embedded app preview
   may not have the extension. Set `WALLET_PROBE_PORT` if that local port is busy.
4. Click **Connect Nightly** and check the displayed wallet address. Click
   **Request Cookie network**, approve the network change in Nightly if prompted,
   then **Refresh diagnostics**. The genesis values must match the saved Cookie
   snapshot before preparation becomes available.
5. Leave **User signs first** selected and click **Prepare unsigned test**. Review
   the generated `.cook` name, recipient, amounts, three required signer addresses,
   blockhash and message digest. Snapshot amounts are diagnostic inputs, not a
   current live quote or spend authorization.
6. Click **Sign test in Nightly**. Record the complete wallet prompt, its warnings,
   Nightly extension version and browser version. Approve only if the displayed
   action matches this diagnostic. If a signature returns, the server checks the
   exact message and the connected user's Ed25519 signature. Download the
   resulting success or failure report. A failed report preserves the diagnostic
   stage and outcome; it does not establish a valid signature or execution.
7. Only after reviewing a successful user-first result, optionally select
   **Preserve an existing attempt-payer signature**, prepare another test and
   repeat. This extra check records whether Nightly retains an existing partial
   signature. The intended application flow still has the user sign before the
   server co-signs. A failed attempt does not require repeated approvals or this
   optional test; retain its evidence and investigate first.
8. Stop the process with Ctrl+C. Review the evidence metadata before copying it
   into the repository, and fill in the manually observed extension version and
   warning text. Do not save raw signed transaction payloads or private keys.

Each new diagnostic attempt clears the previous result so a prior pass cannot
appear to belong to a later failure. Download evidence before starting another
attempt. Wallet prompts have a 120-second response limit, and local HTTP requests
have a 15-second limit. A timeout records an incomplete outcome and ignores late
results; it cannot close or cancel a Nightly popup. Close any stale wallet popup
before preparing another test. The page never automatically requests another
approval.

The original page generated a downloadable report only after successful signature
verification. That is why download remained disabled after the September 15
failure. The screenshots preserve that observation; the updated failure export
does not retroactively verify it. A provider message such as “User rejected
approval” is recorded as the provider's error, not proof that the person clicked
Cancel. Record wallet warnings separately because the page cannot read them from
the extension's UI.

Each preparation uses a new unfunded sponsor identity, a new attempt payer and a
random diagnostic name. The sponsor's secret is never used. The sponsor never
signs, even after the user's signature is verified; therefore this tool never
produces a fully signed executable transaction. In preservation mode only the
fresh attempt payer signs before the user. Prepared messages and returned bytes
are retained in process memory only. No private-key input, funding, simulation,
send, retry or registration endpoint exists.

The only RPC methods the original root-page preparation uses are `getGenesisHash`
and `getLatestBlockhash`. The sponsor-backed routes additionally read registry,
balance, fee and rent state, simulate and check block height. The shared server
binds to `127.0.0.1`, checks Host and Origin,
requires a random session token for its POST requests, caps request size and
pending preparations, and serves no third-party scripts. Do not expose it through
a tunnel or public reverse proxy.

## What the original unfunded probe's pass establishes

- The installed Nightly provider can connect and report the expected Cookie
  genesis through the integration below.
- It accepts the candidate legacy transaction with S, A and U as required
  signers and returns U's valid signature without altering the message.
- In the optional preservation test, it keeps A's existing signature intact.

A pass does **not** establish successful simulation, absence of live-wallet
warnings, sponsor funding, current registry prices, available names, on-chain
execution, ownership, primary-name state, independent name resolution or a
complete Phase 0 gate. An expired blockhash can still have a mathematically valid
signature; the report is a signing diagnostic, not evidence that a transaction
can now land.

Wallet rejection and inability to simulate an unfunded sponsor should be recorded
as observations, never relabeled as a passed live flow. The funded test below must
resolve the actual wallet experience before advancing the phase.

## Current Nightly integration and constraints

The official [detection documentation](https://docs.nightly.app/docs/solana/solana/detection/)
permits access through `window.nightly.solana`. The local diagnostic uses that
injected provider and its standard feature object without a bundler. Phase 5
implemented the app's explicit custom-network adapter in
`src/lib/onboarding/wallet.ts`, with synthetic signature/network tests. The
standalone sponsor diagnostic now has real extension evidence; the application's
adapter and full journey still need their own live verification.

[Connection](https://docs.nightly.app/docs/solana/solana/connect/) uses
`features['standard:connect'].connect()`, which returns connected accounts.
[Transaction signing](https://docs.nightly.app/docs/solana/solana/sign_transaction/)
accepts the connected account and serialized transaction bytes. The Nightly docs
currently show the feature key `standard:signTransaction`; the probe also detects
the Wallet Standard spelling `solana:signTransaction`, prefers it when present,
and records the exact feature used. It calls only `signTransaction`. It never
substitutes a combined sign-and-send function.

Nightly's official [network-change API](https://docs.nightly.app/docs/solana/solana/change_network/)
accepts `{ genesisHash, url }` and exposes a `genesisHash` getter on the injected
Solana provider. Cookie is a custom SVM network, so this probe selects it through
that genesis-based API and does not invent a standard `solana:mainnet` or
`solana:devnet` chain identifier. If the installed version does not expose the
required methods/getter, or keeps reporting a different genesis after a network
change, compatibility is unresolved. Record it and review the integration;
do not disable the network check to make the diagnostic pass.

The server checks its RPC against the saved genesis before preparing a message.
`COOKIE_RPC_URL` can override the server's read-only endpoint. Nightly receives
only the reviewed public, credential-free HTTPS endpoint from the snapshot;
private RPC credentials must never be passed to the browser. Browser-local
genesis reporting alone does not prove which endpoint the wallet's internal
simulation uses. That is an observation required during the live smoke test.

Documentation reviewed September 13, 2026. The unsuccessful and successful
September 15 UTC attempts are recorded separately. These references are an
implementation basis; the supplied report is the real diagnostic evidence.

## Separate funded live test — not implemented by this diagnostic

Before preparing that test, record a concrete spend worksheet and the approved
maximum amount, test name, sponsor address, fresh attempt-payer address and
zero-COOK Nightly recipient. Freshly read registry/config identity, name
availability, registration price, account rents and message fees. Include charged
failure fees and any recovery allowance in the maximum. Confirm who owns the
pilot budget and how the invitations will be distributed.

Use the [read-only spend worksheet](smoke-worksheet.md) to make this cost review
concrete. It takes explicit public accounts and native-unit limits, writes a
private planning record and reports blockers without funding or signing. Its
generated attempt payer is disposable; the future funded runner must refresh
the quote with its own actual durable payer. A successful worksheet is not spend
authorization and does not close the wallet or live-registration gate.

Use a separately reviewed runner with the project's fixed transaction builder,
exact user-message/signature verification and explicit finality/readback checks.
Do not add a broadcast button to this local diagnostic. Before sending, inspect
the real wallet warnings with funded sponsor state and require the expected
three-signer message. Broadcast at most the approved test; an RPC timeout is an
unknown state and must be reconciled before another attempt.

Record, at minimum:

| Evidence | Required observation |
| --- | --- |
| Wallet/browser | Extension and browser versions, selected Cookie genesis, prompt count and exact warnings |
| Starting state | U has zero COOK, A is fresh, no name or primary record conflicts |
| Transaction | Signature, exact message digest, byte size, required signers, compute usage and actual fee |
| Final state | Finalized success; domain owner U; U's primary record references the same domain |
| Cost isolation | A paid the variable registry charge; U did not fund that charge; sponsor debit stays within the approved maximum |
| Reconciliation | Actual debits and residual A balance accounted for; recovery completed or deliberately recorded as unresolved |
| Independent check | An existing ecosystem tool resolves the final name correctly |
| Phase decision | Pass only with the specified technical evidence and a selected finite pilot budget/distributor |

Attach public transaction/account evidence and observed results to
`docs/feasibility.md` and update `docs/progress.md`. Keep unobserved items open.
