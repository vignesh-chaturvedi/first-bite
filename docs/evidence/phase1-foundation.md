# Phase 1 local verification

Verified on 2026-09-13. This records the local application foundation; it does
not close Phase 0's Nightly/funded-registration gate or claim hosted CI/deployment.

## Reproduction

Runtime: Node 24.6.0, pnpm 11.20.0, PostgreSQL 17.11. Application dependencies:
Next.js 16.3.5, React 19.3.0, Tailwind 4.3.3, Drizzle ORM 0.45.2, pg 8.23.0 and
Zod 4.5.4. Exact transitive versions and integrities are in `pnpm-lock.yaml`.
ESLint 9.39.5 is pinned because the installed React lint plugin still uses APIs
removed by ESLint 10; update the compatible toolchain together in a later change.

- `pnpm peers check`: no peer dependency issues.
- `pnpm lint`: zero warnings/errors.
- `pnpm typecheck`: generated Next route types and TypeScript check passed.
- `pnpm build`: standard Turbopack production build passed with the final pins.
- `pnpm db:migrate` and `pnpm db:seed`: passed on a fresh local development DB.
- `DATABASE_TEST_URL=… pnpm test`: **100 passed, zero skipped**, across eight files.
  This includes PostgreSQL migration idempotence, immutable history, advisory
  locking, deterministic fixtures, heartbeat updates, bounded/redacted runtime
  behavior, the synthetic wallet diagnostic and the pinned deployed-program proof.
- A clean source copy with no `node_modules`, `.next` or environment files passed
  `pnpm install --frozen-lockfile --ignore-scripts`, all 100 tests and `pnpm build`.
  The previously hash-checked ELF was copied into its ignored cache for the proof;
  dependency package contents came from pnpm's local store. This did not test
  availability of every registry download or a hosted Actions runner.

## Process and browser checks

The production server started on `127.0.0.1:3000`. `/healthz` returned 200/alive
with `Cache-Control: no-store`. With a migrated database and a required worker,
`/readyz` returned 503 before the worker, 200 after its heartbeat, then 503 after
SIGTERM and the 30-second freshness window. Responses exposed only foundation
status and `relayEnabled: false`. SIGTERM produced `worker.stopped` and exit 0.
Disabled worker startup also exited 0 without opening a database connection.

The built-in browser showed the populated page at 375, 768 and 1280 pixels with
no horizontal overflow. Invitation-anchor navigation, the disabled pilot state,
not-found recovery and a visible keyboard focus outline were checked. No runtime
console warnings/errors were observed on the home page. The browser used its
system dark theme; light-theme tokens were reviewed in source, not visually
emulated. No actual wallet journey is present in this phase.

## Environment and remaining gates

The normal persistent Compose container could not initialize because the local
Docker VM had no free disk space. It was stopped without deleting any volume.
Verification used the same `postgres:17.11-alpine` image with a temporary 512 MiB
memory-backed data directory. The temporary container is disposable and is stopped
after verification; it is not the ongoing development database. The host's native
libpq tools lacked the PostgreSQL server, so they were not used as database proof.

No remote repository is configured. The CI workflow is prepared, but its hosted
result is pending. The Railway configuration has not been deployed. Real Nightly
signing, the approved live registration, pilot allocation/distributor and all
sponsorship functionality remain outstanding.
