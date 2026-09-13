# Development progress

Updated 2026-09-13. User direction: develop phase by phase with local commits;
prepare local proof first while the user arranges the wallet.

| Phase | Status | Next evidence |
| --- | --- | --- |
| 00 — transaction and pilot feasibility | Local proof passed; full gate open | Real Nightly signing, funded registration/readback, pilot cap and distributor |
| 01 — application foundation | Not started | Depends on Phase 0 gate |
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

The local checkpoint commit does not declare Phase 0 complete. Proceed to Phase 1
after the outstanding gate evidence is recorded, or after an explicit revision
of the development plan. No remote, live deployment or funded campaign exists.
