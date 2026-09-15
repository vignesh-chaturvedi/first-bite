# Nightly user-first signature pass

Recorded September 16, 2026 from the user's supplied
`nightly-sponsor-probe-passed.json`. The local diagnostic reports a successful
newcomer signature on the exact sponsor-backed transaction. This closes the
core user-first signing compatibility check, not the full Phase 0 gate.

## Evidence and provenance

The original export is preserved unchanged with mode 0600 in ignored
`artifacts/private/nightly-sponsor-probe-passed-20260915T202720.json`.
SHA-256: `eb7d6d9ab0b3d8adfd70f0923abf2f715bf3a32235429c22bcce9864d3aa7741`.
The committed record omits the user's wallet addresses. S is the funded account;
U is the separate empty Nightly account. Their roles were swapped after the
user funded the original newcomer. No further transfer was required for this test.

| Observation | Reported result |
| --- | --- |
| Prepared | 2026-09-15T20:27:09.006Z |
| Verified | 2026-09-15T20:27:20.323Z |
| Preparation to verification | 11.317 seconds |
| Outcome / mode | `passed` / `user-first` |
| Provider feature | `solana:signTransaction` |
| Cookie genesis | `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2` |
| Name inspected | `firstbitecheck0001.cook` |
| Sponsor balance / newcomer balance | 15999.999 COOK / 0 COOK |
| Planning requirement / shortfall | 15000.003469720 COOK / 0 COOK |
| Unsigned simulation | Passed, no error, 31747 compute units |
| Simulation context | Slot 25325716 |
| Simulation block heights | Before 24880745; after 24880746 |
| Last valid block height | 24880893 |
| Transaction | 690 bytes, three distinct required signers |
| Message SHA-256 | `194d1538abc61a6dfeeb023e969f6dbd78030f20700aad7903af9c3fe18f6294` |
| Newcomer signature / message | Valid / unchanged |
| Sponsor / attempt-payer signatures | Both absent |
| Broadcast / registration | Both false |

The report's chain identity, pinned policy/config/program hashes, accounts,
signer list, duplicated message digest/size/lifetime fields, exact cost arithmetic,
balance/cap coverage and chronological fields were checked for consistency.
Payload/secret fields were absent. The private copy was checked for byte equality,
hash, permissions and Git exclusion. The export contains metadata only; the
signature cannot be cryptographically reverified from this file. The signature
and unchanged-message checks were performed by the local verifier at test time.

## Scope and remaining observations

This is evidence that the tested Nightly flow returned U's valid signature on
the three-signer message, after funded-state unsigned simulation, without
changing its contents. The verifier's pass also required its chain identity,
context and transaction lifetime checks to succeed. It is not evidence for the
separate application adapter or a later wallet version.

The exact Nightly version and popup warning fields still contain manual-entry
placeholders. The report records a Chrome/152.0.0.0 user agent on macOS. Earlier
static inspection found Nightly 1.51.24 and Brave app 152.1.94.117, but those
earlier observations are not an attestation of this successful attempt's runtime.
The user was asked to supply the success prompt/summary, warning text (or no
warning), and exact extension version; these remain unrecorded.

Preservation of a pre-existing attempt signature was not tested and is optional
for the selected user-first flow. Neither S nor A signed. The attempt key was
discarded, so this diagnostic transaction cannot be completed or reused for a
real registration. No name, on-chain owner or primary record was created by it.
The entered 15001 COOK ceiling was a diagnostic limit, not spend approval.

## Next development checkpoint

Prepare a separate runner for one reviewed registration, reusing the fixed
transaction builder and exact-message user signature verification. It needs
durable encrypted attempt-key custody, a reviewed sponsor signing method,
persist-before-send state, bounded execution and finality/readback/reconciliation.
Keep the current diagnostic sign-only. Prepare the runner and local tests before
requesting approval for a concrete name, public accounts, fresh actual attempt
payer and current maximum cost. Refresh the quote before any eventual send.

The real transaction must register the name, transfer it to U, set it as U's
primary and prove finalized ownership/primary with independent resolution and
exact sponsor debit/residual accounting. The finite pilot budget/distributor,
application activation and hosted operational evidence remain separate gates.
No new wallet action or funds movement was performed while recording this report.
