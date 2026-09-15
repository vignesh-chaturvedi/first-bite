# Nightly failure observation

Observed September 15, 2026, from screenshots supplied by the user in this task.
This record describes the displayed UI and the user's reported actions. It is
not an independently captured wallet trace, RPC observation, signed-payload
validation or successful signature report. The user's wallet address and raw
transaction bytes are intentionally omitted.

## Observed sequence

1. The user reported manually selecting Cookie in Nightly. A screenshot showed
   the Cookie network icon and matching “Expected genesis” and “Nightly genesis”
   values on the local diagnostic at `http://127.0.0.1:8787`.
2. The diagnostic's public review showed `mode: user-first`, three required
   signers and `transactionBytes: 696`. The page described a fresh, unfunded
   sponsor whose signature is never created and showed `broadcast: false`.
   These are displayed diagnostic metadata, not independent payload validation.
3. Nightly's approval prompt said its simulation showed the transaction would
   fail. Its details displayed `AccountNotFound`. The user then reported the
   unsuccessful result after the approval step.
4. The next screenshot showed Nightly's “Transaction failed...” screen with
   `AccountNotFound` again.
5. The page showed “User rejected approval”, “No result yet. Phase 0 remains
   open.”, and a disabled **Download evidence report** button. No successful
   signature report was provided.

The screenshots identify Brave and Nightly, but their exact versions were not
provided with that first attempt. Subsequent installed-file inspection and the
downloaded failure report are recorded in the
[signing refusal diagnosis](nightly-signing-diagnosis.md). Nightly's displayed balance was zero COOK; no independent balance read
is established by this record. The optional attempt-signature preservation mode
was not tested in this observed sequence.

## Interpretation and limits

The local probe creates a fresh, unfunded sponsor as fee payer. `AccountNotFound`
is consistent with that design, but the screenshots do not establish the exact
cause inside Nightly or which RPC its internal simulation used. A matching
provider genesis does not independently verify that simulation endpoint.

The page's “User rejected approval” text is the error returned to the diagnostic;
it does not prove that the user clicked Cancel. The observed sequence did not
establish a valid returned user signature, unchanged transaction bytes, preserved
partial signatures, successful simulation, on-chain execution or any charge.

The probe's implementation requests signing only, never creates the required
sponsor signature and exposes no broadcast endpoint. That implementation
boundary remains unchanged by this observation. No funded test is authorized or
completed by this record.

## Diagnostic follow-up

The original page populated its report only after successful `/verify`, so it
offered no download for the observed failure. The follow-up provides downloadable
failure outcomes and clears earlier evidence when a new diagnostic attempt
starts. Failed or incomplete results remain distinct from verified signatures.
Reports exclude transaction payloads and private/session data; manually observed
wallet warnings and exact extension/browser versions still need separate notes.

Wallet calls are limited to 120 seconds and local HTTP requests to 15 seconds.
The page ignores late results after timeout and does not automatically retry a
wallet approval. Timeout cannot dismiss an extension popup: close any stale
Nightly popup before starting another attempt. Retaining the existing screenshots
does not require another approval or funding the disposable diagnostic accounts.

Implementation checks passed: nine tests across `wallet-probe-browser.test.ts`
and `wallet-probe.test.ts`, plus TypeScript and lint. The browser regressions
execute the actual inline script with a synthetic provider and minimal DOM;
they cover rejection export, timeout and late response handling, verification
failure, stale result clearing and payload exclusion. The server checks use
synthetic signatures. The initial sandboxed server test could not bind loopback;
the permitted loopback rerun passed all nine tests without skips. These checks
do not establish actual extension compatibility or retroactively convert this
screenshot record into a verified signature result.

## Subsequent diagnosis and remaining evidence

The [subsequent diagnosis](nightly-signing-diagnosis.md) identifies installed
versions, explains the approval UI's simulation requirement, and independently
reproduces AccountNotFound for the unfunded fee payer. The limitations above
describe what the original screenshots alone established.

- The user's separate sponsor public address and a reviewed funded-state test.
- A successful signature compatibility report from the actual extension.
- Separately reviewed funded registration, finalized owner/primary readback and
  independent name resolution.
- A finite pilot allocation, owner and distributor before runtime activation.

Phase 0 remains open. No successful live registration or pilot is claimed.
