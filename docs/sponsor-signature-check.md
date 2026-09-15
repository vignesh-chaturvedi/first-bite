# Sponsor-backed Nightly signature check

The original unfunded diagnostic exposed a Nightly 1.51.24 limitation: the
approval UI refuses signing after a transaction simulation error. This separate
check uses the public address of a sponsor account the operator controls and
reads its existing on-chain state. It creates no funding, sponsor signature or
broadcast. The [user's successful report](evidence/nightly-signature-pass.md)
records a valid newcomer signature on the exact prepared message at
`2026-09-15T20:27:20.323Z`. The core user-first diagnostic passed. The exact
successful-attempt version/warnings, separate funded registration and full
Phase 0 gate remain open. The steps below reproduce the diagnostic if needed.

## Operator steps

1. Create a separate sponsor S account in Nightly and record its Cookie public
   address. Keep the newcomer U account empty. Never fund sponsor addresses from
   the old unfunded probe: their secrets were discarded.
2. Start `pnpm phase0:wallet` and open `http://127.0.0.1:8787/sponsor` in the browser
   with Nightly. Select the empty newcomer account and Cookie network, then
   connect it to this page. Enter S's public address in the sponsor field.
3. Enter the test name and review the displayed diagnostic cost ceilings in
   COOK. They constrain preparation and are not permission to spend. The page
   converts at most nine decimal places to exact native-unit integer strings;
   it does not use floating-point money arithmetic.
4. Run the account/cost check. It reads pinned registry/config/program evidence,
   name availability, fresh-A conditions, balances, rents and the exact message
   fee. An unfunded sponsor produces a downloadable shortfall report, not a
   signing request. Review that amount and destination before separately
   arranging any funding.
5. After the sponsor is funded under that separate review, run the check again.
   All limits and the zero-COOK newcomer requirement must pass. The server then
   simulates the exact unsigned transaction at or after the observed context,
   without replacing its blockhash. Only a successful, fresh simulation enables
   the user-signature test. A simulation pass is not proof that Nightly will
   approve its own simulation.
6. Review the public metadata and request one signature from the newcomer.
   Keep S selected only when managing its account outside this check; the page
   never asks S to sign. On success, download the verified signature report.
   On failure, download its failure evidence and record the exact popup text.

### Reviewing without letting the check age

The preparation JSON is collapsed by default. A passing check brings the compact
name, sponsor, newcomer and cost review into view beside **Sign test in Nightly**.
Review these details at your own pace. When ready, use **Prepare fresh check**
there to obtain another fully checked and simulated candidate; it does not open
Nightly automatically. The page shows the age and allows 30 seconds to start a
wallet request. After that, prepare again. This conservative start window is not
a chain-expiry estimate, and it does not shorten an already-open wallet prompt.

The transaction's block height limit can expire before the separate 120-second
local deadline. Never treat that local deadline as a promise of chain validity.
Verification keeps both checks. New failures distinguish `blockhash_expired`
from `chain_changed` and the local/missing/consumed-candidate `expired` code.
Browser failure reports include when preparation arrived, signing was requested,
the wallet returned and verification began, when those stages were reached.
They contain no signed payloads, and a failed report does not establish a valid
signature. No automatic retry, refresh or wallet approval is performed.

## Boundaries and evidence

- Only public addresses and explicit limits are accepted. No private-key or
  arbitrary instruction input exists.
- Every preparation uses fresh A and immediately discards its secret. Neither A
  nor S is signed in this diagnostic, including after U signs. Returned signed
  bytes are checked in memory and never saved or logged.
- Blocked preparations return no transaction payload. Exported reports omit
  unsigned/signed bytes and the browser session token. The successful candidate
  is stored briefly in server memory and consumed on verification, including
  failed verification. No name or budget is reserved.
- Wrong genesis, stale contexts, invalid costs, policy drift, account conflicts,
  shortfall, nonzero U balance, failed simulation or expired lifetime prevent a
  signature request. Verification also rechecks chain identity and block height.
- A signature report establishes U's valid signature on unchanged prepared
  bytes. Successful registration, finalized ownership/primary, independent
  resolution, recovery, finite pilot allocation and runtime activation remain
  separate gates.

The local server keeps its Host/Origin/token checks, body and pending-request
limits and loopback binding. No network or browser approval is performed
automatically. A wallet timeout does not close Nightly; close a stale popup
before retrying. Reloading loses in-memory evidence, so download reports first.
