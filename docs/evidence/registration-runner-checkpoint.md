# One-registration runner checkpoint

Date: 2026-09-21. This is a local implementation and read-only preparation
checkpoint. No real wallet approval or transaction broadcast was performed.
Phase 0 and production activation remain open.

## Implemented

- Separate loopback runner at port 8788; the 8787 diagnostic remains sign-only.
- Fixed name, sponsor, newcomer and independent exact native-unit ceilings.
- User-first and sponsor-second Nightly approvals of the same unsigned message,
  independently verified before merging. Neither wallet private key is exported.
- One durable attempt payer in an encrypted, locked, append-only local journal.
  Authorization precedes its signature; full signed bytes precede any send.
- Explicit live flag and final message/cap acknowledgement. The default startup
  cannot broadcast. A restart never automatically signs, sends or creates a new
  attempt; an uncertain send reconciles only the original signature.
- Finalized receipt/byte/signature verification, sponsor/user balance accounting,
  domain ownership and primary-name readback. Residual funds retain custody and
  require manual recovery; no automatic sweep is implemented here.
- Metadata exports with field-by-field projection; no signed payload, attempt
  secret or session token. CLI state and encryption key remain private and ignored.
- Fifteen-second budgets for multi-call registry/preflight/finality reads,
  retaining four-second individual RPC deadlines and quote expiry checks. The
  existing execution adapter's default budget remains unchanged; the standalone
  runner explicitly opts into its larger registry-observation budget.

## Verification

| Check | Result |
| --- | --- |
| Journal, engine, browser, CLI and HTTP suite | 158 passed |
| Existing execution-chain suite, including timeout regressions | 41 passed |
| New pinned-program LiteSVM runner proof | 2 passed |
| TypeScript, ESLint, whitespace | Passed |
| Browser review | Fixed accounts/costs render; sending disabled; unsigned preparation succeeds |

The two local-VM proofs execute the actual saved registry executable with
synthetic funds and separately signed user/sponsor messages. They verify exact
signature preservation, a complete encrypted record before execution, actual
VM balances/owner/primary, and successful reopening of the same journal. One
proof deliberately loses the send response after execution and verifies that
reopening reconciles without sending twice. Finality and slot metadata in these
proofs are test adapters, not evidence of live chain finality or Nightly behavior.

A package-manager Ctrl+C check initially left a stale lock. The original process
was confirmed stopped and all three encrypted snapshots were authenticated as
unsigned before recovering that lock; no record was removed or altered. The
runner now keeps its signal handlers installed through asynchronous cleanup,
and a regression test exercises simultaneous parent/child signals.

## Fresh read-only preparation

The new runner prepared the user's fixed public-account configuration for
`firstbitecheck0001.cook` against the pinned Cookie policy. Registry/config/program
checks passed, the attempt payer was fresh, the newcomer had zero COOK and the
sponsor covered the quoted reservation. Unsigned simulation passed at slot
`26335814` with `31747` compute units. No signature request was made.

| Amount | COOK |
| --- | ---: |
| Registration price | 15000 |
| Domain and primary account rent | 0.00335472 |
| Transaction fee | 0.000015 |
| Estimated execution debit | 15000.00336972 |
| Recovery allowance | 0.0001 |
| Total including allowance | 15000.00346972 |
| Configured total ceiling awaiting live approval | 15001 |

The private metadata record is
`artifacts/private/registration-smoke/review-20260921.json`, SHA-256
`327aa40b2cc7e8e1727f2c1794a025aeb75107b9c7fd2fa746c41888ddf9a284`.
Its message digest is
`f26f05dac052ce3f79eb1c59c0c6ac05f09bd8c63f759da2b2daaa349419908c`.
It contains public metadata only; the actual custody journal is separate and
encrypted. Public participant addresses are retained in private artifacts rather
than committed into this evidence document. This short-lived quote is an
observation, not approval or a price guarantee; refresh it before any live test.

## Remaining gates and limits

Use the [runner instructions](../registration-smoke-runner.md) after approval of
the concrete name, accounts and maximum spend. Both Nightly approvals, a real
finalized registration and independent ecosystem resolution are unverified.
Record the exact Nightly/browser versions and successful popup text during that
run. A pilot budget/distributor and application signer activation are separate.

Historical encrypted journal snapshots retain old attempt-key/signature data;
clearing the latest terminal key field does not erase those records. The local
master key must be protected alongside the journal. Hash-linked records detect
intermediate corruption, not restoring an entire older directory or deleting
its tail. Crash locks and pending records require inspection, not automatic
deletion. These limitations are documented in the operator guide.

The user handles repository pushes. This checkpoint neither authenticates
GitHub CLI nor pushes changes, and does not claim a hosted CI run.
