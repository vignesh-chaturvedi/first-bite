# Phase 4 local verification

Verified 2026-09-14 with Node 24.6.0, pnpm 11.20.0, PostgreSQL 17.11,
the existing pinned dependencies and the cached reviewed registry ELF.

This is a local engine checkpoint. Real Nightly compatibility, a funded
registration, pilot allocation/distributor, runtime signer custody and hosted CI
remain open. Test signers and funding were disposable VM fixtures. No live
transaction was signed or broadcast, and no remote or deployment was added.

## Results

| Check | Result |
| --- | --- |
| Full suite with `DATABASE_TEST_URL` and cached ELF | 518 passed, 23 files, zero skips |
| Execution cryptography | 17 passed |
| RPC execution adapter | 39 passed |
| Submit/retry API and sequential worker | 42 passed |
| PostgreSQL execution repository | 26 passed |
| Combined PostgreSQL/registry VM proof | 11 passed |
| Exact receipt settlement verifier | 32 passed |
| Existing foundation, registry and campaign coverage | 351 passed |
| ESLint and TypeScript | Passed |
| Drizzle schema/snapshot consistency | No schema changes to generate |
| Production build | Passed, including both new execution routes |
| Built HTTP smoke | 10 expected responses |

The full suite used the direct local Vitest executable with
`run --no-file-parallelism`, equivalent to `pnpm test`. The final run took
19.64 seconds. A prior run found one stale campaign API response expectation;
its prepared-attempt fixture now includes the new null signature/slot/residual
and zero actual-cost fields. The complete suite passed after that correction.
Dependencies and the lockfile did not change.

## What the proofs establish

- The user's signature authorizes only the persisted fixed registration message.
  Changed messages, incorrect signer slots, forged signatures and corrupt or
  cross-operation encrypted envelopes fail verification.
- Authorization serializes with pause/revocation. A committed authorization can
  finish after pause; repeated requests reuse its original operation.
- Fully signed payloads commit before any send. Failure to persist sends nothing.
  A lost commit acknowledgement or send response can resume after restart with
  identical bytes and the original transaction signature.
- Overlapping workers, lease expiry and stale owners cannot persist a replacement
  or settle an operation twice. The execution loop does not overlap its ticks and
  drains in-flight work before closing the database.
- Confirmed errors are provisional. Missing history after block-height expiry,
  unavailable finalized receipts and inconsistent account evidence retain holds
  for manual review. Retry cannot manufacture a fresh registration or blockhash.
- Finalized registration settlement verifies the stored transaction, exact fees,
  every account balance change, the user's preserved funds and final owner/primary.
  Failed registration charges only its verified fee and leaves the pass eligible.
- Price decreases can leave residual funds in the attempt payer. Recovery uses a
  separately persisted fixed sweep, the original recovery blockhash during
  revalidation, and a campaign-capped fee reservation. No anticipated refund is
  available to the campaign before a verified finalized return.
- Initial recovery discovery survives a crash after registration settlement.
  A bounded deferred scan prevents blocked older attempts from monopolizing
  every pass. Failed/uncertain recovery keeps residual funds and holds visible.
- Settlement and audit records are atomic, idempotent and append-only. Completed
  attempts clear recoverable payer keys and encrypted transaction payloads.
- HTTP enforces capability authorization, exact origins, bounded strict JSON,
  layered signing limits and private response fields without signed bytes/keys.

The combined proof executes the reviewed deployed registry ELF inside LiteSVM;
its controlled chain adapter never connects to a live network. The separate RPC
adapter suite exercises response/context/fee/balance validation with controlled
RPC fixtures. These are complementary local proofs, not a real Nightly journey
or live RPC finality test.

## Runtime and environment scope

Migration `0002_execution_recovery.sql` advances readiness to version 3 and
backfills outstanding Phase 3 reservations. The existing `0000` and `0001`
migration SQL files remain unchanged. Test suites use randomly named private
schemas and do not reset development data.

PostgreSQL ran in the temporary 512 MiB memory-backed
`first-bite-phase4-postgres` container because persistent Docker storage was
unavailable. It was stopped and automatically removed after verification;
no persistent or unrelated volumes were deleted.

The updated production build was started at `http://127.0.0.1:3000` with
preparation and relay disabled and no database configured. Home and `/healthz`
returned 200; `/readyz` returned 503. All three preparation mutations returned
`PREPARATION_DISABLED`, and submit/retry returned `EXECUTION_DISABLED`.
Unauthenticated attempt status returned `SESSION_REQUIRED`; campaign lookup
without a database returned `SERVICE_UNAVAILABLE`. The unfunded preview remains
running. No screen changes were made in this backend phase.

The ordinary `pnpm worker` remains heartbeat-only. The execution service and
worker are injectable modules verified by the suites, not enabled application
processes. Local operator commands can inspect execution, requeue existing work
or prepare a capped recovery job; preparation does not sign or send it. Those
new CLI wrappers were typechecked; their underlying repository/recovery paths
were tested, but no live operator recovery command was run.

Runtime signer custody, service/worker activation, real wallet/funded evidence,
safe proof of never-landed signed expiry and full operational readiness remain
open. The conservative implementation retains ambiguous signed holds instead
of releasing them from a timer or missing history. See the
[execution contract](../execution.md) and [phase progress](../progress.md).
