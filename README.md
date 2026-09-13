# First Bite

An invitation-based onboarding pass that sponsors a newcomer's first `.cook`
name on Cookie. The intended flow is one Nightly transaction approval, with
registration cost, account rent and transaction fees covered by a capped campaign.

**Current milestone: Phase 0 local proof implemented. The full Phase 0 gate is
still open.** Real Nightly compatibility, a funded registration and the pilot's
budget/distribution decisions remain pending. No live funds were spent and no
application is deployed.

## Start here

- [Development specification](docs/development-spec.html): complete phases and architecture.
- [Progress](docs/progress.md): current evidence and outstanding gates.
- [Feasibility results](docs/feasibility.md): what the local proof establishes.
- [Nightly test instructions](docs/nightly-smoke-test.md): next wallet checkpoint.

## Run the proof

Use Node **24.6.0** (recorded in `.node-version`) and pnpm **11.20.0**.
The supported major is Node 24. Install those runtimes through your usual version
manager; the repository does not change your global Node installation.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:unit
pnpm phase0:inspect
pnpm test
pnpm phase0:proof
```

`phase0:inspect` reads the public Cookie RPC, checks the recorded genesis and
executable hash, and stores the deployed program in `.cache/registry.so`.
It writes a fresh observation to `.cache/chain-snapshot.json`; it does not replace
the reviewed evidence under `docs/evidence/`. It never broadcasts a transaction.

The proof runs that actual executable inside **LiteSVM** using the committed
config/rent/fee-receiver snapshot. Its generated signers, sponsor funding and price
changes exist only inside the local VM. `pnpm test` includes a loopback HTTP test
with a fake RPC and synthetic wallet signatures; this is not a real Nightly test.
Local tests need permission to bind to `127.0.0.1` when running in a sandbox.

After the executable is downloaded, the test suite and `phase0:proof` need no
internet. To refresh the baseline later, inspect the new observation, review any
program/config differences and deliberately update the evidence. An upgraded
registry causes inspection to fail rather than silently changing the tested code.
After an upgrade, reproduction of this version needs a cached/archive copy of the
exact ELF hash listed in [feasibility](docs/feasibility.md); the binary is not
committed to Git.

## Check Nightly later

```sh
pnpm phase0:wallet
```

Open the printed loopback URL in the browser containing the Nightly extension.
This diagnostic can verify user signing and partial-signature preservation using
an unfunded sponsor identity. It never creates a sponsor signature and has no
broadcast endpoint. Follow the [smoke-test guide](docs/nightly-smoke-test.md).

## Repository layout

```text
src/lib/cookie/          strict account decoding and fixed transaction construction
scripts/phase0/          read-only inspection, local proof and Nightly diagnostic
tests/                  encoding, signatures, deployed-program and diagnostic tests
docs/evidence/          reviewed public chain observation and local execution evidence
vendor/cookie-domains/   pinned upstream IDL, provenance and MIT license
```

Phase 1 will add the chosen Next.js application shell. The later database,
campaign ledger, signing service and recovery worker are intentionally tracked as
future phases in the spec; this proof is not a production sponsor service.

## Development and commits

Work one phase at a time and follow `AGENTS.md`. Every completed phase receives a
local Git commit with a descriptive subject and a body explaining its changes and
verification. Partial checkpoints must identify open gates. Commit messages have
no AI/model attribution or co-author trailers. No remote is configured; the user
will connect the remote repository later.

Upstream IDL and encoding references are credited in
[vendor provenance](vendor/cookie-domains/README.md). New project code has no
publication license selected yet; choose one before the public-source submission.
