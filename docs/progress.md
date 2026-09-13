# Development progress

Updated 2026-09-13. User direction: develop phase by phase with local commits;
prepare local proof first while the user arranges the wallet.

| Phase | Status | Next evidence |
| --- | --- | --- |
| 00 — transaction and pilot feasibility | Local proof passed; full gate open | Real Nightly signing, funded registration/readback, pilot cap and distributor |
| 01 — application foundation | Local implementation verified; hosted CI gate open | Remote Actions run after the repository is connected |
| 02 — registry integration | Not started | Promote proof code only after its gate passes |
| 03 — invitations and accounting | Not started | Database reservations and concurrency checks |
| 04 — signing and recovery | Not started | Durable execution and recovery worker |
| 05 — newcomer experience | Not started | Real wallet journey and accessible screens |
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
