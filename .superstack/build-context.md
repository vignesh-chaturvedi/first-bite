# First Bite build context

Updated 2026-09-14.

- Architecture: Next.js web/API + PostgreSQL ledger + persistent Node worker,
  integrating the existing Cookie registry. Phase 1 adds the unfunded Next.js
  shell, PostgreSQL metadata/heartbeats, safe runtime and worker entry point.
- Phase: 00 local checkpoint passed; full feasibility gate remains open. Phase 1
  local foundation, Phase 2 registry/quote engine, Phase 3 invitation/accounting
  backend and Phase 4 execution/recovery engine verified; hosted CI awaits the
  user's remote repository. Preparation
  routes are disabled by default and restricted to local development/test.
- User requested phase-by-phase local commits with descriptive subject/body and
  no co-author or AI/model attribution; remote repository will be supplied later.
- User explicitly chose local proof first and will arrange Nightly/test funds.
- Stack tested: Node24.6.0, pnpm11.20.0, TypeScript5.9.3, web3.js1.99.0,
  LiteSVM1.4.1, Vitest5.0.0. See package/lockfile for complete exact versions.
- Starter direction: focused Next.js scaffold adapted to the approved spec;
  no generic wallet starter or custom Anchor program was generated. Branding
  follows the existing cream/forest spec direction in `brand.md`.
- Skill used: scaffold-project (already installed). Cookie MCP's pinned domain
  interface is the relevant integration reference; no MCP runtime or wallet
  access connector is installed or required for the application.
- build_status: mvp_complete=false; local_phase0_tests_passing=true;
  actual_nightly_tested=false; funded_live_registration=false; deployed=false.
- Evidence: `docs/feasibility.md`, `docs/evidence/chain-snapshot.json`,
  `docs/evidence/local-proof.json`, `docs/evidence/phase2-registry-engine.md`,
  `docs/evidence/phase2-observation.json`,
  `docs/evidence/phase3-invitations-accounting.md`,
  `docs/evidence/phase4-execution-recovery.md`, `docs/progress.md`.
- Verification: 518 tests across 23 files with PostgreSQL 17.11 and pinned ELF
  passed with zero skips; lint, TypeScript, Drizzle schema/snapshot consistency
  and production build passed. Ten built HTTP responses matched expectations.
  Temporary database stopped/removed; unfunded
  preview restored on loopback port 3000. No live transaction signed/broadcast.
- Phase 3: campaign lock + active uniqueness + append-only ledger; encrypted
  payer keys; hashed invite/session capabilities; private invitation CLI; layered
  database rates; expiry releases only prepared unsigned holds. Worker remains
  heartbeat-only at the runtime entry point.
- Phase 4: injected execution service/worker, exact user authorization, separate
  encrypted signed payloads, persist-before-send, fenced leases, finalized exact
  settlement and capped residual sweeps. Missing/ambiguous signed history holds
  money for manual review; refunds count only after verified finality. Submit/retry
  runtime routes return EXECUTION_DISABLED. No sponsor secret setting exists.
  Signer custody and live service/worker activation remain gated by Phase 0.
- Next: Phase 5 newcomer journey. Preserve the local-only activation boundary
  while actual Nightly/funding and finite pilot allocation remain outstanding.
