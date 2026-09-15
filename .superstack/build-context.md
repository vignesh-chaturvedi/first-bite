# First Bite build context

Updated 2026-09-15.

- Architecture: Next.js web/API + PostgreSQL ledger + persistent Node worker,
  integrating the existing Cookie registry. Phase 1 adds the unfunded Next.js
  shell, PostgreSQL metadata/heartbeats, safe runtime and worker entry point.
- Phase: 00 local checkpoint passed; full feasibility gate remains open. Phase 1
  local foundation, Phase 2 registry/quote engine, Phase 3 invitation/accounting
  backend, Phase 4 execution/recovery engine, Phase 5 newcomer journey and Phase 6
  operational checkpoint verified; Phase 7 local pilot preparation verified;
  hosted CI awaits the
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
- Skills used: scaffold-project and frontend-design-guidelines (already installed;
  telemetry remains off). Cookie MCP's pinned domain
  interface is the relevant integration reference; no MCP runtime or wallet
  access connector is installed or required for the application.
- build_status: mvp_complete=false; local_phase0_tests_passing=true;
  actual_nightly_tested=false; funded_live_registration=false; deployed=false.
- Evidence: `docs/feasibility.md`, `docs/evidence/chain-snapshot.json`,
  `docs/evidence/local-proof.json`, `docs/evidence/phase2-registry-engine.md`,
  `docs/evidence/phase2-observation.json`,
  `docs/evidence/phase3-invitations-accounting.md`,
  `docs/evidence/phase4-execution-recovery.md`,
  `docs/evidence/phase5-newcomer-journey.md`,
  `docs/evidence/phase6-operational-hardening.md`,
  `docs/evidence/phase7-pilot-preparation.md`, `docs/progress.md`.
- Phase 6 verification: 779 tests across 31 files with PostgreSQL 17.11-alpine and
  reviewed ELF passed with zero skips; lint, TypeScript, peer checks and direct
  Next production build passed. Thirteen HTTP checks verified status/gates and
  nonce CSP; 11 client JS chunks had no forbidden secret/runtime markers. Complete
  example browser flow and client navigation passed without console errors.
  Actual synthetic pg_dump/pg_restore and six operator CLI checks passed.
  Temporary database stopped/removed; private artifacts cleaned; unfunded
  production preview runs on loopback port 3000. No live transaction or deployment.
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
- Phase 5: /start real preparation/status flow, /preview isolated labeled examples;
  explicit Nightly custom-network adapter with WebCrypto signature checks,
  authenticated session recovery and public cost breakdown. No browser storage,
  secret URLs or signed payload state. Approval remains disabled. Expired sessions
  on paused/consumed passes still require operator inspection; live Nightly and
  independent CookBook resolution remain unverified.
- Phase 6: exact bounded private accounting exports, same-snapshot execution-role
  health and aggregate sponsor holds, read-only pinned registry health, mandatory
  fresh service admission, enforced nonce CSP, tested synthetic archive restore,
  operator runbook/security/backup docs and compatible deployment templates.
  Public readiness explicitly says sponsorship disabled. No schema/dependency or
  live signer setting added. Hosted controls and real sponsor history remain open.
- Review: security_score=B; quality_score=B; ready_for_mainnet=false.
  Fixed finding: missing enforced browser CSP (defense in depth, no demonstrated
  XSS exploit); fixed with fresh nonces, caller-header replacement, dynamic layout
  and no-store. Reviewed authorizations retain exact fixed-message/finality rules.
  This implementation review is not an independent audit; see HTML Phase 6 review.
- Phase 7 preparation: protocol, blank private notes/JSON templates, strict offline
  aggregate reporter and record-format guide. Retries preserve session history;
  walkthroughs never count as live participants. Reports retain unverified
  provenance and phase7Complete=false even with a satisfied record checklist.
  67 pilot tests plus 23 existing private-export tests passed with zero skips;
  lint and TypeScript passed. Blank-template CLI returned expected exit 2, zero
  live participants and ten missing codes; private smoke artifact removed.
  No dependency/schema/runtime/UI changes, real
  participants, funded operations or activation. Full database/VM suite and browser
  evidence above belong to Phase 6 and were not rerun for this offline addition.
- Next: actual Nightly unfunded manual probe, then Phase 7's live prerequisites.
  First close the real Nightly/funding,
  independent resolution, signer activation and finite allocation gates. Hosted
  CI and production backup/restore evidence remain pending user remote/host setup.
- Live-test preparation follow-up: public S/U + explicit limits worksheet using
  finalized read-only registry evidence and exact costs. RegistryObservation now
  returns userBalance from the same account snapshot; quote funding rules remain
  intact. Diagnostic A is discarded and output contains no signable payload.
  58 worksheet tests plus 243 related regressions passed with no skips; types/lint
  passed. See docs/evidence/smoke-worksheet-preparation.md. The existing unfunded
  Nightly diagnostic is running on 127.0.0.1:8787 (HTTP 200 checked 2026-09-15);
  no actual extension test result or real-account worksheet exists yet.
