# Phase 7 local pilot preparation

Verified 2026-09-14. This is a partial checkpoint: the actual pilot has not run.
There are zero recorded real newcomers, live registrations and demo recordings.
The user chose local proof first while arranging the wallet and funds.

## Implemented scope

- An ordered [pilot protocol](../pilot.md), private raw-observation worksheet and
  blank JSON input template. Prerequisites cover Nightly, bounded funded proof,
  independent resolution, finite allocation, runtime activation and hosting.
- An offline command that validates bounded strict records, reference types,
  timestamps, duplicate sessions/artifacts and exact integer accounting.
- Aggregate participant counts that separate walkthroughs and retain all live
  sessions. Latest participant outcomes determine completion; earlier rejection
  and assistance remain counted. Unknown observations remain unknown.
- Descriptive manual-step medians with sample sizes and explicitly named latest
  completed-session duration. These do not claim total onboarding time or causal
  performance/conversion improvement. Baseline artifacts cannot be double counted.
- Bounded UTF-8/JSON file reads, rejection of final-path symlinks and nonregular
  inputs, private exclusive output and fixed errors. Reports omit participant,
  session, evidence, commit and artifact-hash identifiers.
- A CI entry for the isolated pilot tests and corrected historical wallet guide
  wording reflecting the custom adapter already implemented in Phase 5.

## Verification

| Check | Result |
| --- | --- |
| Pilot tests | 67 passed, no skips |
| Existing private-export tests | 23 passed, no skips |
| Combined focused run | 90 tests across two files passed |
| TypeScript | `pnpm typecheck` passed |
| ESLint | `pnpm lint` passed with zero warnings |
| Actual CLI boundary in tests | Blank records exit 2; invalid records exit 1; synthetic satisfied records exit 0 while keeping `phase7Complete: false` |
| Project-root CLI smoke | Blank template returned expected exit 2, zero live participants, ten missing evidence codes and a mode-0600 report; private smoke artifact removed |
| Privacy/file behavior | Temporary fixtures removed after tests; exclusive mode-0600 export, no overwrite/traversal, bounded input and sanitized errors verified |

All success-shaped observations in the tests are explicitly synthetic fixtures.
They are not participant evidence or claims about the live chain. The repository
input template is tested to remain blank. The full database/ELF suite, production
build and browser verification belong to the preceding Phase 6 checkpoint; this
offline addition does not modify runtime, UI, dependencies or database schema.
Hosted CI has not run because no remote is connected.

## What this checkpoint cannot establish

The report has `provenance: operator_recorded_unverified`,
`manualReviewRequired: true`, `activationChanged: false` and
`phase7Complete: false` for every input. Exit 0 means the entered-record checklist
is satisfied; the reporter neither reads supporting artifacts nor verifies their
hashes, observer claims, actual people, consent or chain outcomes. Its checklist
does not encode every manual acceptance criterion. Independent consumer escrow
behavior, fair baseline conditions, issue fixes and final screenshots require
separate review, as explained in the [record format](../pilot-record-format.md).

No participant was contacted, invitation distributed, live transaction signed or
broadcast, campaign funded, service deployed or remote added. Runtime execution
remains disabled and its live custody/service/worker wiring is still unfinished.
Proceed first with the actual unfunded [Nightly probe](../nightly-smoke-test.md),
then review the concrete bounded funded test and remaining prerequisites in order.
Phase 7 and the original live feasibility gate remain open.
