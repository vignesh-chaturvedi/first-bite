# Main application integration checkpoint

Date: 2026-09-21. Scope: connect the proven registration engine to the main app.
No deployment, new real sponsor, funding, wallet approval or broadcast occurred.
The earlier successful live registration remains the live-chain evidence.

## Implementation

- Request-time availability reaches the real invitation journey as a boolean;
  the preview remains an isolated in-memory walkthrough.
- Main submit/retry endpoints authorize durable jobs using the existing fixed
  message/signature, invitation, price, fee and reservation checks.
- Web runtime has public sponsor identity and a submission-only service. Worker
  custody is loaded separately and is not imported into the web/client boundary.
- The persistent worker executes leased signing, send, finality and recovery jobs.
  Sponsor-scoped claims keep separate sponsors from claiming each other's work.
- Admission checks matching worker custody health, funding and accounting before
  new quotes/reservations/signatures. Campaign pauses still permit authorized
  reconciliation; default runtime flags remain off.
- A database custody binding rejects mismatched wrapping keys before a job claim
  or heartbeat, including during a rolling worker restart. Legacy unbound
  encrypted preparations are not automatically adopted. Rotation is not automated.
- Operator commands accept the configured hosted database without loading signing
  secrets. Updated configuration and service commands are in the hosting handoff.

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm peers check`: passed.
- `DATABASE_TEST_URL=... pnpm test`: **1,228 tests passed across 47 files**, no
  skipped suites. A disposable loopback PostgreSQL 17 instance and isolated random
  schemas were used. Registry execution used the pinned ELF in LiteSVM; real RPC
  was not required for this test run.
- New integration coverage: real HTTP handlers/client/controller, registry reads
  backed by the local VM, invitation exchange, quote/reservation, signed submission,
  persisted packet before send, lost response, worker restart, finalized ownership,
  page-state restoration and exactly one send/debit. The web never reads the sponsor
  secret; stale/mismatched workers deny admission and wrong custody cannot claim jobs.
- Real worker connection coverage: matching heartbeat, empty job tick, graceful
  removal of heartbeat and pool cleanup, disabled startup, malformed/mismatched
  key rejection, concurrent custody binding, and distinct foundation health.
- Production build: `pnpm exec next build --webpack` passed with all application
  routes present. The normal Turbopack build could not finish in this local
  environment: its CSS processing child reported a port-bind permission error,
  including after the escalated retry. The standard CI build command is unchanged;
  its result for this new commit remains to be observed after push.
- Browser on the production build: `/start` shows approvals paused; `/preview`
  loads the example invitation and connects its example wallet. No actual extension
  or funded wallet was used. No sponsor-key loader string was present in client
  static bundles.

The user confirmed the *preceding* commit's GitHub Actions checks passed. That
result does not establish hosted CI for this new integration commit.

## Remaining boundary

Provision web, PostgreSQL and persistent worker, then verify the hosted service.
Configure the dedicated app sponsor, stable wrapping key and finite reviewer
campaign during that phase. Hosting backups, real deployed Nightly operation and
reviewer availability are not proved by local emulation. The five-person pilot
is deferred by user direction; missing historical popup wording stays an honest
limitation. No repeat paid registration is required merely to reproduce it.
