# Phase 6 operational hardening evidence

Verified locally on 2026-09-14 with Node 24.6.0, pnpm 11.20.0, PostgreSQL
17.11-alpine and the previously reviewed registry ELF. This is a local checkpoint,
not a funded pilot or deployment. The original wallet/funding/activation gates
remain open.

| Check | Result |
| --- | --- |
| Final full suite with PostgreSQL and cached ELF | 779 passed, 31 files, zero skips; 23.01 seconds |
| Accounting snapshot and evidence regressions | 28 passed, including 20 real PostgreSQL cases |
| Operational readiness and chain-health probe | 25 passed |
| Nonce CSP / Next matcher / headers | 19 passed |
| Private accounting export | 23 passed |
| Restore-drill safety boundaries | 36 passed |
| Durable PostgreSQL/LiteSVM execution flow | 18 passed, including seven new admission cases |
| ESLint / TypeScript / peer dependencies / whitespace | Passed on final sources |
| Production build | Passed with direct Next invocation; all pages dynamic and proxy included |
| Built HTTP checks | 13 expected status/code responses passed |
| CSP integration | Fresh response nonce, inbound nonce replacement, no unsafe-inline/eval, framework scripts correctly nonced |
| Client bundle inspection | 11 JS chunks checked; no forbidden key-setting, encrypted-payer, execution-table or PostgreSQL URL markers |
| Browser journey | Example invitation → wallet → name → review → simulated approval → example completion passed |
| Browser navigation | Client navigation to home and real invitation page passed |
| Browser console | No warning/error observed during the verified example flow and navigation |
| Operator CLI | Export, mode-0600 permissions, collision rejection, readiness denial and pause verified; six checks |
| Database backup/restore | Actual custom pg_dump/pg_restore passed for pending and settled synthetic operations |
| Migration / lockfile scope | No migration, database schema or dependency-lock change |

## Failure paths and admission

The earlier fixed-message, eligibility/race, price isolation, persist-before-send,
lost response/restart, overlapping lease, finality and recovery tests remain in the
complete suite. New tests reject missing, throwing, stale, future-dated and
wrong-campaign admission evidence. A denied prepared attempt retains its original
hold and can retry after health recovers. Once authorization committed, later
admission failure does not prevent the same operation from reconciling once.

Readiness checks schema and an execution-specific heartbeat, campaign/policy,
accounting consistency, manual reviews, aggregate same-sponsor holds and finalized
chain/program/config/rent/balance observations. Unsafe values, rollback, changed
program data, wrong genesis, insufficient funds and stalled probes fail closed.
The actual operator probe always supplies a disabled signer. There is no new live
signing configuration or public operational-data endpoint.

Accounting tests use actual store settlements for success, charged failure,
unsigned expiry and failed/retried residual recovery. They compare ledger totals,
campaign/attempt counters, user slots, operation evidence, signatures, verified
slots and residuals. A concurrent settlement proves repeatable-read consistency.
Deliberate drift is reported rather than corrected; oversized exports are refused
rather than truncated. Reports do not certify unobserved live sponsor transactions.

## Restore and operator evidence

The completed drill archived 53,649 bytes with SHA-256
`00cd29976b38e20dccec4e0f0f48d3fcf552271544fa812a92c1e16d44dfdd21`.
It matched 12 application tables plus migration history, 90 constraints, 43
indexes, two append-only triggers/functions and one sequence. Fixtures included
two paused campaigns, one signed uncertain operation and one settled operation;
five ledger entries, one pending job and six audit records survived. Ciphertexts
matched byte for byte, decryption/all signatures verified and accounting agreed.
Six append-only and four other constraint violations were rejected. Both owned
databases and the private temporary archive were removed; no RPC or worker ran.
Details and reproducible command: [backup and restore](../backup-restore.md).

A separate CLI smoke created and migrated a fresh `first_bite_dev` only inside
the disposable container, then created one synthetic unfunded campaign. The CLI
wrote a consistent private export, refused overwriting it, returned readiness
denial (`signer_disabled`, `worker_stale`, deliberately wrong configured genesis)
without RPC, and paused the campaign. That database and its single export were
removed afterward. No pre-existing application database was used.

## Browser, build and environment

Production CSP permitted hydration and the complete example flow. A deliberately
slow review expired and disabled approval; a restarted fresh review completed.
Screens retained their existing styling and focus behavior. The real invitation
page loaded after client-side navigation, without connecting a real extension.
Phase 5 contains the detailed responsive checks; Phase 6 inspected the rendered
review/completion screens at the current viewport and tested the changed CSP.

The pnpm-launched build encountered a sandbox port-binding denial in Turbopack's
CSS compiler. Running the same installed Next build directly with approved local
process permissions passed. Automatic approval review also temporarily rejected
browser and Docker inspection due to account usage limits. Subsequent permitted
checks completed; no bypass was used.

After all verification, only `first_bite_test` remained in the dedicated
`first-bite-phase6-postgres` container, which was stopped and automatically removed.
The unfunded production preview runs at `http://127.0.0.1:3000`. No remote, hosted
service, signing secret or funded transaction was added.

## Open exit gates

The optional file-URL preview of the HTML implementation review was rejected by
the browser URL policy; that artifact was source-reviewed, not visually verified.
No alternate browser or URL workaround was used.

The [runbook](../runbook.md), [security model](../security.md),
[HTML implementation review](phase6-security-review.html) and Railway web/worker
templates are ready for review. Security/quality grade B describes this local
implementation review; it is not an independent audit.

Real Nightly compatibility, funded registration and independent resolution,
finite pilot allocation, signer custody/worker activation, hosted ingress and
CI, configured provider backup retention and a production restore/RPO/RTO record
remain prerequisites for the complete operational exit gate. Every live sponsor
debit still needs live reconciliation evidence. Phase 7's observed newcomer pilot
has not started.
