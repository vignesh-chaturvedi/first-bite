# Development progress

Updated 2026-09-21. User direction: develop phase by phase with local commits;
the user handles pushes. Both smoke-test wallet approvals use Nightly.

| Phase | Status | Next evidence |
| --- | --- | --- |
| 00 — transaction and pilot feasibility | Local proof and Nightly user-first diagnostic passed; full gate open | Successful-attempt version/warning record, funded registration/readback, pilot cap and distributor |
| 01 — application foundation | Local implementation verified; hosted CI gate open | Remote Actions run after the repository is connected |
| 02 — registry integration | Local engine verified; wallet/live gate open | Real Nightly/funded evidence before connecting a sponsorship flow |
| 03 — invitations and accounting | Local backend verified; live gate open | Real wallet/funded evidence before sponsorship |
| 04 — signing and recovery | Local engine verified; activation gate open | Signer custody and service/worker wiring after real-wallet/funded evidence |
| 05 — newcomer experience | Local journey verified; live gate open | Real Nightly/funded journey and independent name resolution before activation |
| 06 — operational hardening | Local checkpoint verified; live/hosted gate open | Signer activation, live debit reconciliation, hosted backups/restore and CI |
| 07 — pilot | Local preparation verified; real pilot unrun | Nightly/funded/activation gates, then five observed newcomers and live evidence |
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
- [x] Observe an actual Nightly attempt and record its unsuccessful prompt/error
  sequence from the user's September 15 screenshots.
- [x] Read the user's sponsor-backed report showing funded planning and unsigned
  simulation passed; Nightly returned bytes but verification failed after 83.279
  seconds with the old generic expiry code. See the
  [expiry diagnosis and recovery](evidence/sponsor-probe-expiry.md).
- [x] Capture the successful Nightly user-first diagnostic: valid newcomer
  signature, unchanged message, funded simulation passed and no broadcast. See
  [the pass evidence](evidence/nightly-signature-pass.md).
- [ ] Complete the successful-attempt extension/browser version and exact
  prompt/warning record; the export retains manual-entry placeholders.
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


## Phase 6 local checkpoint

- [x] Export exact accounting from a repeatable-read snapshot; compare ledger,
  campaign/attempt balances, slots, signatures, verification and residual evidence.
- [x] Add private readiness for schema, execution-role heartbeat, campaign policy,
  accounting, manual reviews, finalized registry identity and sponsor funding.
- [x] Require fresh passing admission evidence for new authorization while keeping
  already-authorized reconciliation independent of readiness outages and pause.
- [x] Enforce per-request nonce CSP with dynamic rendering, private cache controls,
  strict production script/style sources and caller-nonce replacement.
- [x] Add isolated custom pg_dump/pg_restore drill preserving encrypted pending
  work, settled ledger, migrations, constraints, indexes, triggers and sequences.
- [x] Document operator actions, incidents, retention, release/rollback and hosted
  backup gates; configure explicit web/worker overlap, drain and restart behavior.
- [x] Pass 779 tests across 31 files with zero skips, lint, TypeScript, peer checks,
  production build, 13 HTTP checks, operator CLI smoke and complete example UI.
- [x] Remove the disposable database and private drill artifacts; retain the
  unfunded production preview on port 3000.
- [ ] Close the original real-wallet/funded/independent-resolution and pilot-budget
  gates before activating signer custody, execution worker and invitations.
- [ ] Verify hosted CI, ingress protections, provider backups/restore and live
  sponsor-debit reconciliation in the selected production environment.

This is a local checkpoint, not a complete operational exit gate. Temporary
approval-review usage interruptions were resolved by later permitted checks.
See [Phase 6 evidence](evidence/phase6-operational-hardening.md),
[runbook](runbook.md), [security](security.md) and [backup drill](backup-restore.md).
Phase 7 needs the outstanding live inputs/evidence; its local preparation is
recorded below.

## Phase 7 local preparation checkpoint

- [x] Write the ordered pilot prerequisites, five-newcomer observation protocol,
  fair manual-step comparison, pause/retest rules and real-product demo outline.
- [x] Add blank private observation and JSON templates; preserve zero actual
  participants, transactions and completed prerequisites in committed records.
- [x] Implement a strict, bounded offline reporter with evidence-reference checks,
  retry-aware participant counts, unknown observations, independent resolution
  fields, exact recorded accounting and descriptive step/session metrics.
- [x] Reject reused registration/baseline artifacts, ambiguous duplicate sessions,
  invalid/future records and unsafe file inputs; write exclusive private aggregates.
- [x] Keep walkthroughs outside live results and always emit unverified provenance,
  manual review required, unchanged activation and `phase7Complete: false`.
- [x] Pass 67 pilot tests and 23 existing private-export tests (90 total, no skips),
  TypeScript and lint; add the pilot tests to CI.
- [x] Run the command against the blank template; verify zero live participants,
  ten missing evidence codes, exit 2 and mode-0600 output; remove the private file.
- [x] Observe actual Nightly behavior in the unsuccessful September 15 attempt;
  keep its failure separate from pilot success evidence.
- [x] Capture the successful standalone Nightly user-first diagnostic.
- [ ] Review one concrete funded smoke test and complete its wallet prompt record.
- [ ] Close live ownership/resolution, finite budget/distributor, runtime signer
  implementation/activation and hosted operational prerequisites.
- [ ] Observe at least five real newcomers, retain failures/retests, compare an
  observed baseline and reconcile actual sponsor debits and recoveries.
- [ ] Verify independent consumer behavior including listed/escrowed names, fix
  critical pilot issues and capture real demo footage and final screenshots.

This commit is preparation for the pilot, not completion of Phase 7. It adds no
runtime signing path, deployment, funded transaction or invitation distribution.
The reporter checks entered records; it cannot verify supporting artifacts,
unique humans, consent or actual chain outcomes. The standalone
[Nightly signature test now passes](evidence/nightly-signature-pass.md). The next
checkpoint is the separate funded smoke-test runner under the
[manual Nightly protocol](nightly-smoke-test.md). See
[pilot protocol](pilot.md), [record format](pilot-record-format.md) and
[local preparation evidence](evidence/phase7-pilot-preparation.md).

## Live-test preparation follow-up

This follow-up makes the pending Phase 0 funded-test review concrete while
Phase 7 waits for real-wallet evidence. It does not advance the release phase.

- [x] Add a read-only worksheet for an intended name, public S/U identities and
  four explicit native-unit limits; retain insufficient-funds output as a blocker.
- [x] Expose exact U balance from the existing finalized account snapshot without
  changing eligibility or weakening the funded-quote balance requirement.
- [x] Validate pinned observations, fixed-message costs, independent price/fee/total
  caps and zero-COOK starting state; export only a private diagnostic summary.
- [x] Test exact amounts, asynchronous mutation, invalid observations, private
  export and disabled execution: 58 worksheet and 243 related tests passed with
  no skips; TypeScript and lint passed.
- [x] Start the existing signing-only diagnostic and verify HTTP 200 on loopback
  port 8787. Serving the page does not establish actual Nightly compatibility.
- [x] Receive screenshots of an actual unsuccessful Nightly attempt; preserve
  their limits rather than treating them as verified signature evidence.
- [x] Receive the intended public S/U identities and produce a private worksheet
  using explicit diagnostic limits; the live read reports both balances zero.
- [x] Record the successful standalone Nightly user-first signature check.
- [x] Implement a separate runner with Nightly approvals for both accounts.
- [ ] Obtain concrete funded-test approval before any registration transaction.

See [worksheet instructions](smoke-worksheet.md) and
[follow-up evidence](evidence/smoke-worksheet-preparation.md). No keys, funding,
signable payload, runtime activation or remote are added by this checkpoint.

## Nightly failure observation and diagnostic follow-up

On September 15, the user manually selected Cookie in Nightly and shared a page
showing matching expected/provider genesis values. The user-first prepared
review showed 696 bytes. Nightly displayed `AccountNotFound` during simulation
and then “Transaction failed”; the page displayed the provider's “User rejected
approval” error and kept the download button disabled. This is an observed failed
attempt, not proof that the user cancelled or that the transaction's signature,
wallet simulation endpoint or on-chain outcome was independently checked.

The diagnostic follow-up adds downloadable failure evidence, a fresh result for
each attempt, a 120-second wallet-response limit and a 15-second local-fetch
limit. Late results are ignored after timeout; a stale wallet popup must still be
closed manually. No repeated approval is needed to preserve the screenshots.
Nine diagnostic regression tests passed without skips, including synthetic
browser rejection/export, timeout/late response and server signature checks.
TypeScript and lint passed. These are local checks, not actual extension passes.

See [the observation and its limits](evidence/nightly-failure-observation.md).
The original screenshots left extension/browser versions and the wallet's
internal failure cause unknown; the follow-up below resolves the installed-code
path. Signature compatibility, funded registration/readback, the finite pilot
allocation and all activation gates remain open.

## Nightly simulation diagnosis

- [x] Inspect the supplied failure JSON: matching Cookie genesis, failure at
  signing, null signature checks and no reported registration or phase pass.
- [x] Identify installed Nightly 1.51.24 and Brave app version 152.1.94.117 from
  static manifest/plist metadata, without inspecting wallet storage or keys.
- [x] Trace the installed signing UI: a simulation transaction error opens the
  failure overlay before signing; closing it returns a generic rejection.
- [x] Reproduce `AccountNotFound` at slot 25204613 with a fresh unsigned fixed
  transaction, nonexistent sponsor, zero compute units and no broadcast.
- [x] Retain the original failure report privately and document provenance,
  limitations and static file hashes. Report assertions and whitespace checks
  passed; application code is unchanged by this checkpoint.
- [x] Obtain the separate sponsor public address from the user.
- [x] Implement the reviewed diagnostic with fresh quote and successful simulation
  required before requesting a newcomer signature; test it with synthetic state.
- [x] Record the user's funded sponsor state and successful simulation/signature
  report after swapping the two account roles; see the pass evidence below.

See [the diagnosis](evidence/nightly-signing-diagnosis.md). The current unfunded
probe is not suitable for completing this installed Nightly version's signing
test. Phase 0, funded registration and runtime activation remain open.

## Sponsor-backed diagnostic checkpoint

- [x] Add `/sponsor` with a public sponsor address, exact COOK limit entry,
  readable costs, shortfall reports and a separate signature request.
- [x] Reuse the worksheet's pinned observations and fixed message without
  changing its public report API. Check fresh A, zero-balance U and independent
  caps before simulation. S and A never sign in this diagnostic.
- [x] Simulate the exact unsigned message without replacing its blockhash, check
  chain/context/height and expire the candidate. Reject changed bytes, extra
  signatures, account changes, late wallet responses and replayed verification.
- [x] Export only metadata; preserve failure codes without raw provider text,
  keys, tokens or transaction payloads. Add diagnostic checks to CI.
- [x] Pass 137 browser/engine/worksheet tests, 13 loopback HTTP tests and 14
  pinned-ELF local proof tests (164 total), TypeScript, lint and whitespace checks.
- [x] Restart the diagnostic and inspect its rendered page. Call the new endpoint
  with the user's public accounts: HTTP 200, both balances zero, only
  `sponsor_funding_shortfall`, simulation not run, no signing candidate.
- [x] Obtain actual funded-state simulation and a verified Nightly user signature;
  the follow-up report passed at `2026-09-15T20:27:20.323Z`.

The live endpoint read at `2026-09-15T09:39:06.883Z` quotes
15,000.003369720 COOK expected execution cost, plus the entered 0.0001 COOK
allowance: 15,000.003469720 COOK total shortfall. This is a time-specific planning
result for `firstbitecheck0001.cook`, not a reservation or spend authorization.
Public account addresses and reports remain in ignored private artifacts.

See [operator instructions](sponsor-signature-check.md) and
[checkpoint evidence](evidence/sponsor-signature-check.md). No funds moved;
registration, finality/readback, pilot allocation and runtime activation remain
unverified. This checkpoint does not complete Phase 0.

## Successful Nightly user-first report

The user supplied the [successful diagnostic report](evidence/nightly-signature-pass.md)
after the expiry recovery change. It records 690 bytes, three required signers,
a valid newcomer signature and unchanged message, with matching Cookie genesis.
Funded-state simulation passed and verification finished 11.317 seconds after
preparation. No sponsor/attempt signature, broadcast or registration occurred.

The original report is preserved unchanged in private ignored storage. Metadata,
cost and identity consistency, private copy/hash/permissions, local links and
whitespace were checked. This documentation checkpoint changes no runtime code
and does not repeat the wallet test. Exact version and prompt/warning capture
remain pending; a registered name, finalized owner/primary, independent resolution
and the pilot budget/distributor are still required before Phase 0 can close.

## Separate one-registration runner

- [x] Build fixed-configuration CLI and a separate localhost page for two manual
  Nightly wallet approvals, followed by an explicit spend confirmation.
- [x] Preserve one attempt payer and all execution transitions in a private
  encrypted journal, with authorization and signed bytes durable before send.
- [x] Reconcile the original signature after uncertainty/restart; verify exact
  finalized receipt, spend, owner and primary. Retain residuals for manual recovery.
- [x] Pass 158 runner tests, 41 execution-chain tests and two pinned-program
  local-VM proofs, plus TypeScript, lint and whitespace checks.
- [x] Initialize private review state and prepare against Cookie with sending
  disabled. Exact unsigned simulation passed; estimated execution debit was
  15000.00336972 COOK, or 15000.00346972 with the recovery allowance.
- [ ] Approve the concrete live name/accounts/ceiling, collect both actual Nightly
  approvals and verify a real finalized registration plus independent resolution.

See [runner instructions](registration-smoke-runner.md) and
[checkpoint evidence](evidence/registration-runner-checkpoint.md). No live funds
moved during this checkpoint. The successful-attempt version/popup record,
pilot allocation and application activation remain open. The user handles GitHub
pushes; development continues with descriptive local commits only.
