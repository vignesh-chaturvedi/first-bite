# Phase 3 local verification

Verified 2026-09-14 with Node 24.6.0, pnpm 11.20.0, PostgreSQL 17.11,
the existing pinned dependencies and the cached reviewed registry ELF.

This is a local checkpoint. Real Nightly compatibility, a funded registration,
pilot allocation/distributor and hosted CI remain open. No sponsor key was loaded,
no live transaction was signed or broadcast, and no remote/deployment was added.

## Results

| Check | Result |
| --- | --- |
| Full `DATABASE_TEST_URL=... pnpm test` | 351 passed, 16 files, zero skips |
| Campaign PostgreSQL integration | 38 passed |
| Foundation/migration PostgreSQL suite | 9 passed, including direct SQL NaN rejection |
| Security primitives | 75 passed |
| API orchestration | 29 passed |
| Runtime configuration | 30 passed |
| ESLint and TypeScript | Passed |
| Drizzle metadata and schema/snapshot consistency | Passed |
| Production build | Passed with all five campaign API routes |
| Built HTTP response smoke | 8 expected responses, including disabled preparation and denied unauthenticated access |
| Local operator workflow | Create, activate, issue, list, rotate, inspect, pause, resume, revoke, sweep and end passed |
| Private invitation output | Mode 0600, overwrite refused, no token in stdout, old session rejected after rotation |
| Git whitespace and immutable migration 0000 | Passed |

The full suite was rerun after changing the older transaction module's relative
registry import to the extensionless path supported by the app bundler. A
restricted build initially failed because Turbopack's CSS compiler needed local
process/port access; the permitted build subsequently passed. Dependencies and
the lockfile were unchanged.

## What the accounting tests establish

- Concurrent last-budget and last-user-slot requests admit one hold; native
  budget/capacity constraints prevent negative availability.
- Concurrent requests for one invite and one name across campaigns cannot
  create duplicate active attempts. Repeated idempotent reservation records
  only one hold and one reserve ledger event.
- Session tokens and invites are purpose-separated hashes; wallet/campaign
  mismatches, expired/revoked passes, forged/cross-invite access and tampered
  stored quotes fail before reservation.
- Token rotation preserves the existing pass identity and invalidates old
  capabilities/quotes. Active/uncertain attempts and consumed passes cannot rotate.
- The encrypted payer envelope moves from quote to attempt atomically. Superseded
  or abandoned unsigned quotes and expired unsigned attempts clear their keys.
- Concurrent expiry releases exactly the attempt's recorded amount once.
  Signing, signed, submitted, broadcast-unknown, confirmed, finalized and
  manual-review reservations remain held after wall-clock expiry.
- Ledger UPDATE/DELETE/TRUNCATE and nonfinite native values fail at the database.
  Cross-record foreign keys and active uniqueness prevent contradictory records.
- Atomic rate limits hold under concurrency. HTTP global denial occurs before
  arbitrary IP/token buckets can be created; IP denial occurs before token buckets.
- Exact origins, strict body fields, duplicate-cookie rejection, a 4 KiB body
  bound, five-second total read deadline and redacted responses/logs are covered.
- The successful quote API fixture uses the real quote builder and authenticated
  key envelope with a controlled read-only chain fixture. It returns no payer
  secret or sponsor signature. This is not an actual browser wallet test.

## Runtime and environment scope

Database suites used randomly named private schemas and separate migration
histories. The operator smoke used disposable public-schema records in the same
temporary test database. Its private token files were removed after verification.
The database ran in the 512 MiB memory-backed `first-bite-phase3-postgres`
container because the machine's persistent Docker storage remains full. That
container was stopped and removed after the checks; no persistent or unrelated
volumes were deleted.

The production smoke started the built app on loopback port 3002 with no database
and preparation disabled. Home/health returned 200, readiness returned 503, all
three mutation routes returned PREPARATION_DISABLED, an unauthenticated attempt
read returned SESSION_REQUIRED, and a campaign read without a database returned
SERVICE_UNAVAILABLE. The temporary server was stopped. The updated unfunded
preview was then restored on `http://127.0.0.1:3000`.

The earlier user interface is unchanged; the Phase 5 newcomer journey is not
wired yet. Phase 4 must add signature authorization, durable signing/broadcast,
signing rate limits, reconciliation jobs, settlement and recovery. Current worker
behavior is still heartbeat-only. The operator invokes unsigned expiry manually.
The campaign guide records key-retention, database-owner, ingress and capability
trust boundaries. The full original phase gates remain in [progress](../progress.md).
