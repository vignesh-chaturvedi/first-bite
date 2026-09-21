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
- Make local commits only. The user handles pushes; do not authenticate GitHub
  CLI, add/change remotes, or push unless the user changes this preference.

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
