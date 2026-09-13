# First Bite

An invitation-based onboarding pass that sponsors a newcomer's first `.cook`
name on Cookie. The intended flow is one Nightly transaction approval, with
registration cost, account rent and transaction fees covered by a capped campaign.

**Current milestone: Phase 2 local registry and transaction engine.** The Next.js
foundation now has a read-only registry client, exact unsigned quotes and an
independent fixed-message validator. Phase 0's real Nightly compatibility, funded registration and pilot
budget/distribution gates remain open. No live funds were spent and no application
is deployed. Hosted CI awaits the remote repository.

## Start here

- [Development specification](docs/development-spec.html): complete phases and architecture.
- [Progress](docs/progress.md): current evidence and outstanding gates.
- [Feasibility results](docs/feasibility.md): what the local proof establishes.
- [Nightly test instructions](docs/nightly-smoke-test.md): next wallet checkpoint.
- [Database setup](docs/database.md): local PostgreSQL, fixtures and isolated tests.
- [Runtime guide](docs/runtime.md): configuration, health endpoints and worker.
- [Deployment preparation](docs/deployment.md): unfunded hosting and CI configuration.
- [Registry engine](docs/registry-engine.md): pinned chain policy, account rules and exact quotes.

## Run the application

Use Node **24.6.0** (recorded in `.node-version`) and pnpm **11.20.0**.
The supported major is Node 24. Install those runtimes through your usual version
manager; the repository does not change your global Node installation.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`. The preview works without a database or wallet and
does not issue invitations. Environment examples contain no signing keys.
To verify a production build, use `pnpm build` followed by `pnpm start`.

For the database and heartbeat worker:

```sh
docker compose up -d postgres
DATABASE_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev' pnpm db:migrate
DATABASE_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev' pnpm db:seed
DATABASE_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev' WORKER_ENABLED=true pnpm worker
```

The worker writes health records only. Configure the same database and worker
setting on the web process to require a recent heartbeat at `/readyz`. See the
database guide for a temporary verification container if persistent Docker
storage is unavailable.

## Verify

```sh
pnpm peers check
pnpm lint
pnpm typecheck
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:foundation
pnpm test:registry
pnpm build
```

`test:foundation` runs without Cookie RPC access and includes synthetic wallet
diagnostic tests. PostgreSQL integration is skipped when `DATABASE_TEST_URL` is
omitted; do not count that as database verification. Test scripts read exported
shell variables, whereas Next.js, database and worker scripts load `.env`.

## Run the transaction proof

```sh
pnpm phase0:inspect
pnpm phase2:inspect
pnpm test:proof
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
src/lib/chain/           finalized read-only registry client and reviewed policy pins
src/lib/transactions/    exact unsigned quotes and independent message validation
scripts/phase0/          read-only inspection, local proof and Nightly diagnostic
scripts/phase2/          read-only registry, availability, rent and fee inspection
src/app/                page shell, recovery states and health routes
src/components/         brand mark and small shared button component
src/config/             validated server configuration
src/db/                 database schema, migrations, fixture and heartbeat helpers
src/server/             server-only database access, readiness, logging and errors
src/worker/             heartbeat entry point and graceful shutdown loop
drizzle/                committed migration SQL and metadata
scripts/db/             explicit migration and local fixture commands
tests/                  runtime, database, transaction and diagnostic checks
docs/evidence/          reviewed public chain observation and local execution evidence
vendor/cookie-domains/   pinned upstream IDL, provenance and MIT license
```

Campaign accounting, invitations, signing and transaction recovery remain future
phases. The engine is not connected to a public quote or wallet route. Neither
the page shell nor a healthy worker can sponsor a transaction. See the
[Phase 2 evidence](docs/evidence/phase2-registry-engine.md) for the 200-test result
and public read-only observation.

## Development and commits

Work one phase at a time and follow `AGENTS.md`. Every completed phase receives a
local Git commit with a descriptive subject and a body explaining its changes and
verification. Partial checkpoints must identify open gates. Commit messages have
no AI/model attribution or co-author trailers. No remote is configured; the user
will connect the remote repository later.

Upstream IDL and encoding references are credited in
[vendor provenance](vendor/cookie-domains/README.md). New project code has no
publication license selected yet; choose one before the public-source submission.
