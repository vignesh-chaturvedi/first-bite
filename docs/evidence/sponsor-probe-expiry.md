# Sponsor diagnostic expiry — September 16, 2026

The user supplied `nightly-sponsor-probe-failed.json` and screenshots after
funding the original newcomer and using it as sponsor S. The other, empty
account became newcomer U. The account roles are inputs, not fixed identities.

The unchanged export is stored locally with mode 0600 in ignored
`artifacts/private/nightly-sponsor-probe-expired-20260915T201553.json`.
SHA-256: `fef975225ae52eb9bd0ce8a27b8fee724f0831e3a5b4af536901fdc58292fcd5`.
Public wallet addresses are retained only in that private artifact.

## What the supplied evidence establishes

- Preparation finished at `2026-09-15T20:14:30.018Z` with no planning blockers.
- Sponsor balance was 15999.999 COOK; newcomer balance was zero. The planning
  requirement was 15000.003469720 COOK and the shortfall was zero.
- The exact unsigned transaction simulation passed at slot 25324021, using
  31747 compute units. Its last valid block height was 24879201; the post-
  simulation height was 24879053, leaving 148 blocks at that observation.
- Failure was recorded at `2026-09-15T20:15:53.297Z`, 83.279 seconds later,
  at stage `verify`, with the previous generic `expired` error code.
- In the browser code, reaching `verify` means Nightly returned a byte array
  and it was submitted to the local verifier. It does not itself establish
  that the signature was valid. Both signature verification flags in the
  exported failure are null.
- The diagnostic did not broadcast or register the name. Phase 0 remains open.

Blockhash expiry is the likely explanation: the chain's block height can exceed
the last valid height before the local 120-second deadline. However, the old
HTTP code also covered missing/consumed candidates, deadline expiry and changed
or invalid chain responses. The export contains no verification-time height, so
the exact old branch cannot be established conclusively. This is distinct from
the earlier `AccountNotFound` refusal before Nightly returned transaction bytes.

For background on recent-blockhash expiry, see the
[Solana transaction confirmation documentation](https://solana.com/developers/cookbook/transactions/confirmation).
Its approximate Solana timing is not used as a Cookie network deadline.

## Recovery changes

The long preparation JSON is collapsed, with a compact name/account/cost review
beside signing and an explicit **Prepare fresh check** button. Passing preparation
brings that review into view. A visible 30-second window limits starting a new
wallet request; it is a conservative UI rule, not a blockchain countdown. The
user may review first, then explicitly prepare again. Refreshing never opens
the wallet automatically. Existing wallet-response and server freshness checks
remain in force, including during an already-open prompt.

HTTP failures now distinguish `blockhash_expired`, `chain_changed`, and the
existing local/missing/consumed `expired` case. Error responses contain only
fixed messages/codes. Browser failures include stage timestamps but no
transaction bytes, tokens or signatures. One-use verification is unchanged;
expired or invalid requests still cannot be reused.

## Verification

All 104 wallet diagnostic tests passed across five files, as did TypeScript,
lint and whitespace checks. The restarted `/sponsor` page was inspected in the
in-app browser: preparation JSON is collapsed and the review, freshness guidance
and both buttons appear together. This render check used no wallet connection.

New regressions cover the visible age/start window, explicit refresh without automatic signing,
time spent inside an open wallet prompt, 83-second chain expiry before local
timeout, failure timing and redaction, chain identity/height classification,
deadline crossing during RPC, one-use rejection and the inclusive last valid
height boundary. No new real wallet approval or registration was performed
while implementing this recovery.
