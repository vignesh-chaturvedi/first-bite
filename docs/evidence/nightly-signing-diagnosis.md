# Nightly signing refusal diagnosis

Recorded September 15, 2026. The unfunded diagnostic is incompatible with the
simulation requirement in the locally installed Nightly 1.51.24 approval UI.
This explains the observed failure before signing. It does not establish that
a funded sponsor will pass all remaining checks.

## Evidence reviewed

- The user supplied `nightly-signature-probe-failed.json`, reporting a failure at
  `2026-09-15T05:09:34.466Z`, stage `sign`, feature `solana:signTransaction`, and
  matching expected/provider Cookie genesis. Signature validity, unchanged
  message and preservation checks are null. Broadcast, registration and Phase 0
  completion are false. The JSON is internally consistent with the screenshots;
  it is not a returned signature or independently verified wallet trace.
- SHA-256 of the original JSON:
  `8d3e8b9afbda3a5fa259a45dd7aeba7d16b5b6438975dd6cb930ef53386deaa5`.
  An unchanged mode-0600 copy is retained in ignored `artifacts/private/`.
  The user's wallet address is not copied into this committed record.
- The installed extension manifest identifies Nightly 1.51.24. The Brave app
  plist reports 152.1.94.117. These are installed-file observations, not a
  runtime attestation of a particular open browser process. The exported user
  agent reports Chrome/152.0.0.0, which is not the full Brave version.

## Installed extension control flow

Read-only inspection was limited to the installed manifest, localization name
and static JavaScript bundles. No wallet storage, keys or browser session data
were inspected; the installed extension was not modified.

1. `inject-runtime.js` maps `solana:signTransaction` to a signing request with
   serialized bytes and the selected provider. It does not set the `submit`
   flag used by the separate sign-and-send method.
2. `utils-CsvfxVRf.js` simulates with `sigVerify: false` and
   `replaceRecentBlockhash: true`. A returned transaction error becomes
   `simulationFailureKind: transaction-failed`.
3. `ApproveTransaction-DrCnCG39.js` responds to Approve by opening the failure
   overlay when that transaction error exists. It does not invoke the signing
   callback in that branch.
4. Closing the overlay invokes the cancellation callback in
   `ConfirmTransactionSolana-BQTNHklZ.js`. That callback sends the generic
   `User rejected approval` error back to the page.

This control flow explains why clicking Approve after AccountNotFound showed
failure, then returned a misleading rejection message when the user closed it.
It is not evidence that the app called sign-and-send or that the user originally
clicked Cancel.

The public [Nightly signing documentation](https://docs.nightly.app/docs/solana/solana/sign_transaction/)
documents separate signing and sending operations. It does not document a
skip-simulation option for signing. Do not substitute a send method or weaken
the wallet's simulation checks to make the unfunded probe pass.

Static file hashes, relative to the installed extension version directory:

| File | SHA-256 |
| --- | --- |
| `manifest.json` | `81d75ded62c7118b171591e68ebf5f7854869fe2358f7c180828ab403c4fa247` |
| `inject-runtime.js` | `8ab1f21954fdaaf2665691e7d7998b86a31923d50966f99f4bd81bf89d0f4aea` |
| `chunks/ApproveTransaction-DrCnCG39.js` | `fb6af052aeee32f8dcf23fc0808fead1a757ecbc6847f497d58783b5c2b1fcae` |
| `chunks/ConfirmTransactionSolana-BQTNHklZ.js` | `70f16d896c9b4886cad6a2b054d07eab9cd3454586f9edba725ecac643f5278b` |
| `chunks/utils-CsvfxVRf.js` | `a19377ad53d74a5b4c1a08d1d98de83d8a867a2aabc1570399c94784b13b4166` |

## Independent read-only reproduction

At `2026-09-15T05:14:08.318Z`, a one-off RPC check used the existing fixed builder,
saved registry amounts, a new diagnostic name and fresh public S/A/U identities.
No user wallet was used and no signatures were created. The RPC genesis matched
Cookie. `getAccountInfo` confirmed that the generated sponsor account did not
exist. The unsigned 696-byte transaction was simulated with signature checking
disabled and blockhash replacement, matching the wallet's relevant simulation
options, at finalized commitment.

- Simulation context slot: `25204613`.
- Error: `AccountNotFound`.
- Compute units consumed: `0`; logs: empty.
- No broadcast or on-chain mutation was requested.

This reproduces the error for the intentionally nonexistent fee payer. It is a
fresh reproduction, not a replay of the user's exact bytes or proof of the
wallet's internal RPC endpoint. It also shows that the failure happens before
registry execution; funding may expose further issues that still need testing.

## Next checkpoint

The user chose to create a separate sponsor account in Nightly. Keep the existing
newcomer U account empty and obtain the new sponsor S public address. Never send
COOK to a randomly generated sponsor shown in the old unfunded probe: its secret
was discarded, so those funds could not be recovered through the diagnostic.

Prepare a separately labeled diagnostic that uses only the real sponsor public
address, reads its state and a fresh quote, retains the fixed S/A/U message and
verifies simulation before requesting the user's signature. It must not take
sponsor secrets or broadcast. Review the exact cost and funding destination
before the user funds S. A public address alone does not prove sponsor ownership.

Successful simulation is a prerequisite, not signature proof. After it succeeds,
inspect one actual Nightly user-signature attempt and verify unchanged bytes.
The independently approved funded registration/readback, finite pilot budget,
runtime custody/activation and hosted-operation gates remain separate and open.

Validation for this documentation checkpoint: report-field assertions, static
control-flow review, the read-only reproduction above and whitespace checks.
Application code is unchanged; no additional wallet approval was requested.
