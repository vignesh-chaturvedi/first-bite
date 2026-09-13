# First Bite build context

Updated 2026-09-13.

- Architecture: Next.js web/API + PostgreSQL ledger + persistent Node worker,
  integrating the existing Cookie registry. Phase 1 adds the unfunded Next.js
  shell, PostgreSQL metadata/heartbeats, safe runtime and worker entry point.
- Phase: 00 local checkpoint passed; full feasibility gate remains open. Phase 1
  local foundation verified; hosted CI awaits the user's remote repository.
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
  `docs/evidence/local-proof.json`, `docs/progress.md`.
