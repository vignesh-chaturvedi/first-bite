# First Bite development workflow

Build the invitation-based sponsored .cook onboarding application described in
`docs/development-spec.html`. Integrate the existing Cookie naming registry;
do not introduce a custom program or general-purpose transaction relay.

## Phase boundaries

- Develop one phase at a time. Track evidence and incomplete gates in `docs/progress.md`.
- Do not mark a phase complete without its specified evidence. Phase 0 requires
  both local proof and a real Nightly test, plus a chosen pilot budget/distributor.
- Run the relevant checks before committing. Make a local commit after every
  completed phase; a partial checkpoint must say that its gate remains open.
- Each commit needs an imperative, descriptive subject and a body explaining
  changes, verification and any remaining limitations.
- Do not add Co-authored-by, AI/model attribution, or generated-by trailers.
- Do not add a remote or push until the user provides the remote repository.

## Transaction boundaries

- Keep all native-unit arithmetic exact. Use bigint internally and strings in JSON.
- The sponsor S, fresh bounded attempt payer A, and user U must be distinct.
- U never pays the variable registration price; A registers then transfers to U.
- Server code builds and validates fixed messages. Never accept arbitrary relay instructions.
- Keep signing secrets and signed payloads out of version control and logs.
- Read-only chain inspection and local emulation need no real funds. Document
  the exact amount and accounts before any funded live test.
- Future signing/budget/recovery rules must follow the spec's persist-before-send,
  finality, reservation and pause boundaries.
