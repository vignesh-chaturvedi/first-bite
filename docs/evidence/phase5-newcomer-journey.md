# Phase 5 verification

Local checks performed 2026-09-14 with Node 24.6.0, pnpm 11.20.0,
PostgreSQL 17.11, existing pinned dependencies and the reviewed cached registry ELF.

## Verified results

| Check | Result |
| --- | --- |
| Complete suite with PostgreSQL and cached ELF | 641 passed, 26 files, zero skips |
| Browser-only Nightly adapter | 32 synthetic tests passed |
| Controller and supporting value/API checks | 36 tests passed |
| HTTP client boundaries | 35 tests passed |
| Campaign API | 39 tests passed |
| New database coverage | Session recovery, historical attempts, private cost projection included in full suite |
| ESLint, TypeScript and whitespace | Passed after the final UI copy/accessibility edits |
| Final production build | Passed with `/start`, `/preview` and `/api/session` |
| Built HTTP smoke | 13 expected responses passed |
| Browser walkthrough | Invitation → wallet → name → review → submitted → confirmed → complete passed |
| Unavailable-name recovery | `taken` rejected; `crumb` checked and reviewed successfully |
| Responsive checks | 375, 768 and 1280 px inspected; document width matched viewport |
| Keyboard and clipboard | Step heading focus, visible Tab outline, native details and name copying passed |
| Browser errors | No warnings/errors observed during the example journey |
| Client chunk inspection | No secret-setting, encrypted-payer, execution-table or database-URL markers found |
| Theme contrast | Checked text/button pairs exceed 4.5:1; input borders exceed 3:1 in both palettes |

The full suite completed in 21.26 seconds. Browser interaction used the actual
local app through the connected in-app browser. It inspected the wallet/name
screens at desktop size, review/progress at mobile size, and result at tablet
and desktop sizes. The dark theme was active during those screenshots. Tests
of offline/network changes, rejected signatures, stale responses, duplicate
requests, reload recovery and false success used injected ports rather than a
real extension or funded chain transaction.

## Final environment checks

The final production build includes the result-screen copy button, CookBook
handoff and name input's `aria-invalid` attribute. Automatic approval review
intermittently failed due to model capacity/usage limits; permitted retries later
completed the build, cleanup, preview restart and HTTP smoke. No bypass was used.

HTTP checks returned 200 for home, `/start`, `/preview` and `/healthz`, and 503 for
foundation readiness without a database. The three preparation mutations returned
`PREPARATION_DISABLED`; submit/retry returned `EXECUTION_DISABLED`. Unauthenticated
session and attempt reads returned `SESSION_REQUIRED`; campaign lookup without a
database returned `SERVICE_UNAVAILABLE`. The real invitation browser form also
displayed the disabled-pilot explanation and cleared its synthetic input code.

The temporary memory-backed `first-bite-phase5-postgres` container was stopped
and removed. The development process on port 3002 and earlier production process
were stopped. The updated production preview runs at `http://127.0.0.1:3000`, and
its hydrated walkthrough entry was verified in a fresh browser tab. Temporary
viewport overrides were reset. No persistent/unrelated database data was deleted.

## What this establishes

The real `/start` path restores an HttpOnly capability session, uses private
preparation/status APIs and has a strict Nightly adapter. Execution stays disabled
in both the browser and runtime. No sponsor secret, signing switch, schema
migration or dependency was introduced. Earlier migration files and the lockfile
remain unchanged. Next dev appended its documented local-guide block to
`AGENTS.md`; the installed generator was checked and the relevant component/route
guides were read.

The `/preview` path uses isolated in-memory examples and never fetches, opens a
wallet, signs or broadcasts. Every screen labels the walkthrough and its outcome
as examples. The result exposes no example transaction link. The CookBook home
URL comes from the official Cookie apps registry; fetching that site through the
web tool failed, so its availability and real name resolution are unverified.

This remains a local checkpoint with the original live gate open. Real Nightly
prompts and supported desktop browsers, funded registration/readback, independent
consumer resolution and pilot budget/distribution are still required. Mobile
signing is explicitly unverified. Expired capability recovery for paused or
consumed invitations needs operator help under the current policy.

See [onboarding contract](../onboarding.md) and [phase progress](../progress.md).
