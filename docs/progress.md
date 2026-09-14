# Development progress

Updated 2026-09-14. User direction: develop phase by phase with local commits;
prepare local proof first while the user arranges the wallet.

| Phase | Status | Next evidence |
| --- | --- | --- |
| 00 — transaction and pilot feasibility | Local proof passed; full gate open | Real Nightly signing, funded registration/readback, pilot cap and distributor |
| 01 — application foundation | Local implementation verified; hosted CI gate open | Remote Actions run after the repository is connected |
| 02 — registry integration | Local engine verified; wallet/live gate open | Real Nightly/funded evidence before connecting a sponsorship flow |
| 03 — invitations and accounting | Local backend verified; live gate open | Real wallet/funded evidence before sponsorship |
| 04 — signing and recovery | Local engine verified; activation gate open | Signer custody and service/worker wiring after real-wallet/funded evidence |
| 05 — newcomer experience | Local journey verified; live gate open | Real Nightly/funded journey and independent name resolution before activation |
| 06 — operational hardening | Not started | Crash recovery, accounting and deployment checks |
| 07 — pilot | Not started | Five observed newcomers and resolution evidence |
| 08 — release and submission | Not started | Live app, source, demo and submission receipt |

## Phase 0 local checkpoint

- [x] Create the `first-bite` folder and local `main` Git repository.
- [x] Save the development spec, research references, pinned IDL and license.
- [x] Pin the local TypeScript/testing dependencies and lockfile.
- [x] Read current genesis, executable/config, rent and message fee without spending.
- [x] Prove the five-action composition with the actual deployed ELF in LiteSVM.
- [x] Test exact-message signatures, price increases/decreases, invalid/taken names,
  wrong owners, forged signatures and a cleared existing primary record.
- [x] Implement and synthetically test a local Nightly signature diagnostic.
- [ ] Test the actual Nightly extension and record its prompt/warnings.
- [ ] Select a test-spend cap and send one approved live registration.
- [ ] Record finalized owner/primary and independent ecosystem resolution.
- [ ] Choose the finite pilot budget, owner and distribution channel.

The local checkpoint commit (`e1d9091`) does not declare Phase 0 complete.
Following the user's instruction to continue while arranging the wallet, Phase 1
was limited to the wallet-independent application foundation. This is a sequencing
adjustment to the original plan, not evidence that the wallet/funding gates passed.
Registry promotion and funded operations remain subject to those gates. No remote,
live deployment or funded campaign exists.

## Phase 1 local checkpoint

- [x] Add Next.js App Router, strict TypeScript, Tailwind theme tokens and a small
  shared button component; preserve the Phase 0 integration/proof code.
- [x] Add the responsive invitation-preview shell and loading/error/not-found states.
- [x] Validate configuration without leaking rejected values; reject relay enablement.
- [x] Add server-only database access, bounded readiness, typed errors and safe logs.
- [x] Add PostgreSQL/Drizzle migrations, deterministic non-secret fixtures and an
  isolated test database with migration locking/history checks.
- [x] Verify the heartbeat worker, required-worker readiness and graceful shutdown.
- [x] Add CI and unfunded Railway configuration without connecting an account.
- [x] Pass lint, types, peer checks, production build and 100 tests with no skips.
- [x] Check the browser at 375, 768 and 1280 pixels, anchor navigation, keyboard
  focus and not-found recovery; no runtime browser errors were observed.
- [ ] Observe a successful hosted CI run after the remote is supplied.

See [Phase 1 evidence](evidence/phase1-foundation.md) for exact verification scope
and local environment limitations. The phase commit records a verified local
checkpoint; it does not claim hosted CI, live wallet compatibility or deployment.

## Phase 2 local checkpoint

After the user continued development, the next phase was implemented as a local
engine and read-only inspection. This extends the sequencing adjustment above;
it does not close Phase 0 or enable a funded API. The app preview is unchanged.

- [x] Pin reviewed chain, executable, config, fee receiver and rent policy.
- [x] Read all account evidence at one finalized context, then obtain live rent,
  a subsequent blockhash and an exact message fee with rollback/deadline checks.
- [x] Reject unavailable names, reused attempt payers, ineligible primary records,
  unsupported account layouts and unsafe numeric RPC values.
- [x] Prepare exact unsigned quotes with explicit operator caps, immutable
  metadata, separate execution/recovery costs, hash, expiry and expected outcome.
- [x] Independently parse and validate fixed message bytes, instruction order,
  account permissions, amounts and signer identities.
- [x] Test adversarial message and asynchronous-object mutation cases.
- [x] Execute quote bytes against the pinned registry ELF in LiteSVM and verify
  ownership/primary, exact sponsor costs, preserved user funds and price rollback.
- [x] Recheck the public RPC without signing/broadcasting; reviewed policy matches.
- [x] Pass 200 tests with zero skips, lint, types and production build.
- [ ] Complete the real-wallet/funded test before exposing a sponsorship flow.

Evidence: [Phase 2 verification](evidence/phase2-registry-engine.md),
[public observation](evidence/phase2-observation.json), and
[engine contract](registry-engine.md). Encrypted attempt keys and reservations
were subsequently implemented in Phase 3; submission remains in Phase 4.

## Phase 3 local checkpoint

The user continued the local development sequence. This checkpoint proves the
invitation/accounting backend under the existing feasibility gate; it does not
enable real signing or declare the original Phase 0 prerequisite complete.

- [x] Add campaign, invite, capability, quote, attempt, ledger and rate tables,
  exact numeric constraints, active uniqueness and cross-record foreign keys.
- [x] Issue/rotate wallet-bound random invitations with hash-only storage and
  private output files; add campaign pause/resume, inspection, revocation and expiry.
- [x] Exchange tokens into bounded HttpOnly sessions with origin/body checks,
  fixed error responses and layered database rate limits.
- [x] Encrypt fresh attempt keys with preparation-bound authenticated envelopes.
- [x] Atomically reserve invitation/name, worst-case native amount and one slot;
  validate stored quote/message/policy and enforce idempotency.
- [x] Release only expired unsigned reservations once; retain all signing/uncertain
  holds and erase abandoned unsigned quote keys through bounded housekeeping.
- [x] Add five API routes, disabled-by-default local preparation configuration,
  operator/setup documentation and CI coverage.
- [x] Pass 351 tests with no skips, lint, TypeScript, Drizzle checks and production
  build; verify built HTTP responses and the private operator workflow.
- [x] Stop/remove the temporary test database and restore the unfunded preview.
- [ ] Complete the outstanding real-wallet/funded gate before enabling sponsorship.

See [Phase 3 evidence](evidence/phase3-invitations-accounting.md) and
[campaign contract and commands](campaigns.md). The worker is still heartbeat-only;
the separate Phase 4 engine now proves signing, reconciliation, settlement and
recovery locally, as recorded below.

## Phase 4 local checkpoint

The user continued the local development sequence while arranging the wallet.
This checkpoint verifies the execution library and injectable worker with a real
temporary PostgreSQL database and the reviewed registry executable in LiteSVM.
It does not activate a live signer or close the original Phase 0 prerequisite.

- [x] Authorize only the stored message with the assigned user's valid signature;
  recheck policy, fee, accounts, lifetime and campaign/invitation state.
- [x] Commit authorization and a work item atomically; encrypt and persist fully
  signed bytes before sending, with a separate authenticated payload envelope.
- [x] Fence durable jobs by lease owner, retry identical bytes after uncertainty,
  and keep expired or inconsistent signed operations held for manual review.
- [x] Verify finalized receipts, exact balance changes and resulting ownership
  before atomically settling fees, debits, invitation consumption and holds.
- [x] Prepare separate capped residual sweeps, retain recovery allowances until
  finality, and credit only verified returned funds; clear completed payer keys.
- [x] Add disabled-by-default submit/retry boundaries, private status fields,
  append-only execution audit, operator commands and CI coverage.
- [x] Test crash/restart, lost send and commit responses, overlapping workers,
  pause ordering, provisional failure and residual recovery against the database/VM.
- [x] Pass 518 tests across 23 files with zero skips, ESLint, TypeScript,
  schema/snapshot consistency and production build; verify 10 built HTTP responses.
- [ ] Connect runtime signer custody and execution service/worker after the real
  Nightly, funded-registration and finite pilot-budget gates are satisfied.
- [ ] Observe hosted CI after the user connects the remote repository.

See [Phase 4 evidence](evidence/phase4-execution-recovery.md) and
[execution and recovery](execution.md). The unfunded preview remains available;
Phase 5 implements the newcomer journey below. Full operational readiness, real
funded crash/recovery evidence and deployment remain later gates.

## Phase 5 local checkpoint

- [x] Build invitation, wallet, name, coverage review, progress and result screens
  using the existing responsive theme and accessible native controls.
- [x] Add explicit browser-only Nightly connection/network/signature validation;
  retain disabled real approval and execution boundaries.
- [x] Add debounced name checks, stale response guards, fixed helpful errors,
  exact coverage amounts and a separate labeled example walkthrough.
- [x] Restore the latest attempt through an authenticated session endpoint;
  return stored public cost details without private quote fields.
- [x] Distinguish confirmed, finalized and manual review; require signature/slot
  proof before rendering verified ownership and provide a CookBook handoff.
- [x] Pass 641 tests with zero skips, TypeScript, lint and the initial production
  build; check the full example journey and 375/768/1280 px layouts in browser.
- [x] Pass the final production rebuild and 13 HTTP checks, remove temporary
  PostgreSQL and restore the production walkthrough on port 3000.
- [ ] Complete real Nightly/funded evidence before activating wallet approvals.

Automatic approval review caused temporary capacity/usage interruptions; the
permitted final checks subsequently passed. No live signing or deployment was
attempted. See [Phase 5 evidence](evidence/phase5-newcomer-journey.md)
and [onboarding contract](onboarding.md) for exact scope and remaining limits.
