# Offline pilot record format

This is a contract for **operator-entered, unverified observations**. The reporter
validates structure, references and aggregate consistency; it does not read the
referenced artifacts or prove that their contents occurred. Keep the
[pilot protocol](pilot.md) and [raw observation template](pilot-observation-template.md)
alongside this contract. Neither a valid record nor a satisfied checklist closes
Phase 7.

Start from [pilot-input.template.json](pilot-input.template.json). It intentionally
contains zero observations, empty evidence and null prerequisites. The planned
five participants are a target, not five recorded users or an approved pass
allocation. Keep the repository template blank and edit a private copy.

## Command and files

Run from the project root:

```sh
pnpm pilot:report --input artifacts/private/pilot-input.json --out pilot-report.json
```

Provide exactly one `--input` and one `--out`; duplicate, unknown or positional
arguments are rejected. The input must be a regular UTF-8 JSON file no larger
than 256 KiB. A final-path symlink, directory, special file, invalid UTF-8 or
oversized input is rejected. The reader does not follow the final-path symlink;
it does not impose an input-directory or file-permission policy. Place completed
inputs and their raw evidence in an access-restricted, ignored location yourself.

`--out` is a basename, not a path: a 1–61 character stem beginning with an ASCII
letter or digit, followed only by letters, digits, `_` or `-`, then `.json`.
The reporter writes under `artifacts/private/` relative to the working directory,
creates a new output with mode `0600`, rejects a symlinked export directory and
refuses to overwrite an existing file. A newly created export directory uses
mode `0700`; the command does not repair permissions on an existing directory.
Use a new filename for each run. Even the aggregated output is private pending
manual review, not a publication artifact.

| Exit | Meaning |
| --- | --- |
| `0` | Report written and its entered-record checklist is satisfied. Evidence still requires manual verification. |
| `2` | Report written, but required recorded evidence is missing or inconsistent. This is expected for the blank template. |
| `1` | Invalid arguments/input/references, file access or another command failure. Inspect the safe error code; do not assume an output was created. |

The command prints output location and aggregate checklist counts, not raw notes
or participant records. It performs no network, database, wallet, signing,
invitation distribution or publication operation.

## Shared field rules

All objects are strict: supply every listed field and do not add unknown keys.
Use `null` where the contract permits unknown or missing information. An empty
array records no entries; it does not prove an activity was observed.

| Type | Accepted value |
| --- | --- |
| Evidence reference | `E` plus exactly three decimal digits, such as `E001`; nullable references also accept `null`. |
| Participant / session / baseline ID | Respectively `P`, `S` or `B` plus exactly three decimal digits. These codes contain no identity proof. |
| Timestamp | Valid ISO datetime in UTC with `Z`, not later than report generation. |
| Count | Integer from `0` through `1000`. |
| Native amount | String containing `0` or 1–24 decimal digits without a leading zero, sign, decimal point or exponent. JSON numbers are not accepted. |
| Artifact digest | Exactly 64 lowercase hexadecimal characters representing the operator-recorded SHA-256. |
| Commit | Exactly 40 lowercase hexadecimal characters. |

Evidence IDs, session IDs and baseline IDs must each be unique. A participant
cannot have two observations at the same instant in the same environment, even
with differently formatted timestamps. Retests get new session IDs and later
timestamps while retaining the same participant ID.

## Input fields

The root contains `schemaVersion: 1`, `plannedParticipants` (integer `5`–`50`),
`prerequisites`, `evidence`, `observations`, `baselines`, `accounting` and `demo`.
These schema limits bound local records; they do not approve that number of
passes or any spending.

`prerequisites` contains the five nullable evidence references below. A non-null
reference must identify existing evidence of the exact kind shown.

| Field | Evidence kind |
| --- | --- |
| `nightly` | `nightly` |
| `fundedRegistration` | `registration` |
| `budget` | `budget` |
| `activation` | `activation` |
| `hosting` | `hosting` |

`evidence` is an array of at most 500 objects, each with `id`, `kind`, `sha256`
and `recordedAt`. The only kinds are `nightly`, `registration`, `budget`,
`activation`, `hosting`, `resolution`, `accounting`, `baseline` and `demo`.
Maintain the ID-to-private-artifact mapping outside the JSON record. No file
path, URL, wallet, transaction payload, name, contact or free-text note belongs
in these evidence objects. The digest is not recalculated by the reporter.

`observations` is an array of at most 500 session objects:

| Field | Value |
| --- | --- |
| `participantId`, `sessionId` | Participant and session codes. |
| `environment` | `walkthrough` or `live`; never call a synthetic exercise live. |
| `observedAt`, `commit` | Session timestamp and tested full commit. |
| `outcome` | `completed`, `blocked` or `abandoned`. Retain detailed failure/recovery context in raw notes. |
| `promptCount`, `manualSteps` | Count or `null`. Count actual prompts and discrete tasks using the protocol. |
| `elapsedSeconds` | Integer `0`–`86400` or `null`; duration of this session only. |
| `walletRejected`, `neededHelp` | `true`, `false` or `null`; false means observed absence, null means unknown. |
| `recoveredAfterReload` | `true`, `false` or `null`; true means observed recovery, false means an observed reload did not recover, null means unobserved or not attempted. |
| `blockers` | At most 14 distinct values from the list below. |
| `proof` | Object containing the four fields below. |

Allowed blockers: `wallet_missing`, `wallet_rejected`, `wrong_wallet`,
`wrong_network`, `name_unavailable`, `unclear_coverage`, `unclear_approval`,
`offline`, `timeout`, `session_expired`, `manual_review`, `ownership_mismatch`,
`resolution_failed`, `other`. Keep a historical rejection in `walletRejected`
and raw notes after successful recovery; `blockers` describes blockers remaining
at the recorded outcome. Do not erase the earlier blocked session.

`proof.registration` is a nullable `registration` evidence reference;
`proof.ownerAndPrimaryMatch` is `true`, `false` or `null`;
`proof.resolution` is a nullable `resolution` evidence reference; and
`proof.resolutionOutcome` is `not_checked`, `matches_owner`, `mismatch` or
`escrow`. A live registration artifact digest cannot be assigned to two different
participants by renaming its evidence ID. The same participant may retain it
across retests. This protects against that duplicate record, not fabricated
artifacts or duplicate real people.

`baselines` is an array of at most 100 objects containing `id`, `observedAt`,
`manualSteps` and `evidence` (a required `baseline` reference). Use one distinct
artifact per baseline observation. Reusing its SHA-256 under another evidence
ID is rejected so one observation cannot acquire extra statistical weight.
The observer must still verify that distinct artifacts represent distinct,
fairly comparable observations.

`accounting` is `null` or an object containing an `accounting` evidence reference,
boolean `consistent`, native-unit strings `capNative`, `spentNative`,
`heldNative`, `residualNative`, and counts `pendingAttempts` and
`manualReviewAttempts`. `null` means no accounting record, not a zero balance.
The reporter calculates `availableNative = capNative - spentNative - heldNative`
with exact integer arithmetic. A positive cap is required for its checklist.
The accounting artifact's recorded time must be at least the latest live-session
time. That comparison cannot prove that the artifact actually covers those
sessions or all sponsor debits.

`demo` is `null` or an object with a required `demo` evidence reference, integer
`seconds` from `1`–`300`, boolean `usesRealProduct`, and `participantDisclosure`
equal to `none`, `consented` or `unapproved`. Structural validity allows durations
outside the target; the record checklist requires `60`–`90` seconds, real-product
footage and no unapproved disclosure. `none` means the recording identifies no
participant; it is not a substitute for observation consent.

## Aggregation and missing-evidence rules

Live session totals include every recorded live attempt. Participant outcome
totals use only the latest live session for each participant ID; failed earlier
sessions remain in the session totals. Walkthroughs are counted separately and
never meet the live-participant target.

`latestCompletedParticipants` counts latest sessions labelled completed.
`participantsWithCompleteRecordedProof` is stricter: each needs registration
and resolution references, `ownerAndPrimaryMatch: true`,
`resolutionOutcome: matches_owner` and no remaining blockers. A completed label
alone does not supply that proof.

`medianLatestCompletedSessionSeconds` uses non-null durations from latest
sessions labelled completed. It is not total time across retries, a verified
completion-time metric or a sum of active/waiting time. The step comparison uses
non-null manual-step counts from those latest completed sessions versus all
recorded baselines; it includes sample counts, both medians and baseline median
minus First Bite median. Missing either sample set yields `null`. Review raw
notes for comparable conditions; these medians establish no causal improvement.

`sessionsWithWalletRejection`, `sessionsNeedingHelp` and
`sessionsRecoveredAfterReload` count true observations across all live sessions.
`sessionsWithUnknownRejection` and `sessionsWithUnknownAssistance` report nulls
separately. No-reload sessions may keep `recoveredAfterReload: null`.

`missingEvidence` can include:

| Code | Recorded condition |
| --- | --- |
| `prerequisite_nightly`, `prerequisite_fundedRegistration`, `prerequisite_budget`, `prerequisite_activation`, `prerequisite_hosting` | Corresponding prerequisite is null. |
| `five_live_newcomers` | Fewer than five distinct live participant codes. |
| `observations_exceed_plan` | Live participant codes exceed `plannedParticipants`. |
| `completion_and_resolution_evidence` | Fewer than five have complete recorded proof, or any latest participant lacks it. |
| `unresolved_participant_blockers` | A latest outcome is not completed, has a blocker, explicitly fails owner/primary matching, or reports resolution mismatch/escrow. |
| `incomplete_session_observations` | Any live session, including an earlier failed session, has null prompt count, manual steps, duration, rejection or assistance. Preserve unknowns; do not fabricate them to clear this code. |
| `observed_step_comparison` | No usable First Bite manual-step count or no baseline observation. |
| `accounting_evidence` | Accounting is null. |
| `accounting_discrepancy` | Cap is zero, calculated available is negative, or `consistent` is false. |
| `unsettled_accounting` | Held/residual amount, pending count or manual-review count is nonzero. |
| `accounting_predates_observations` | Accounting artifact timestamp precedes a live session. |
| `live_demo_and_disclosure` | Demo is absent, not real product, outside 60–90 seconds, or has unapproved disclosure. |

The checklist is deliberately conservative about unsettled funds. Do not erase
a residual or release an uncertain reservation to satisfy it; keep the report
incomplete and follow the operator runbook. A recorded deliberate residual
disposition still needs manual review rather than automatic certification here.

## Manual evidence remains necessary

Even with no missing record fields, the report always contains
`provenance: operator_recorded_unverified`, `phase7Complete: false`,
`manualReviewRequired: true` and `activationChanged: false`. In particular, the
reporter cannot encode or independently certify:

- Consent, actual newcomer eligibility, distinct real people, approved
  recruitment/distribution, or permission to publish identifying evidence.
- Zero-COOK starting state, real Nightly warnings/signatures, actual runtime
  activation, live finality, owner/primary correctness or actual independent
  consumer behavior behind artifact references.
- The separate read-only listed/escrowed-name recipient check; a normal name's
  `matches_owner` record does not establish this separate safety observation.
- Approved exact funding and hosting limits, signer custody, all sponsor debits,
  backup/restore readiness or complete accounting artifact coverage.
- Critical issue assessment, fixes and retests, retained failed observations,
  final screenshots, honest video edits or the recording's actual contents.
- Fair baseline starting conditions, task-counting consistency, participant
  assistance, source-funding prerequisites, waiting-time separation or absence
  of duplicated real observations behind different digests.

Review these checks against the private raw evidence and the pilot protocol.
Only then can an operator make a documented phase decision. This offline report
never authorizes a wallet approval, a funded action, a deployment or publication.
