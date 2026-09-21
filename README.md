# First Bite

An invitation-based onboarding pass that sponsors a newcomer's first `.cook`
name on Cookie. The intended flow is one Nightly transaction approval, with
registration cost, account rent and transaction fees covered by a capped campaign.

**Current milestone: Phase 7 local pilot preparation.** A pilot protocol, blank
observation templates and private offline reporting support the next live test.
No real pilot participants have been observed. The application includes the
Phase 6 accounting, readiness, CSP and backup/restore work, plus a separate
walkthrough that exercises the screens without a wallet, database or funds.
Application execution remains disabled; see the phase evidence and open gates.
The standalone Nightly user-first diagnostic now passes with a valid newcomer
signature and unchanged message; see the [report](docs/evidence/nightly-signature-pass.md).
The separate [one-registration runner](docs/registration-smoke-runner.md) has now
completed a real registration with both Nightly approvals: finalized ownership,
primary name and exact sponsor debit were rechecked, and Sprinkle independently
resolved the name. See the [live evidence](docs/evidence/first-live-registration.md).
The user reports Nightly 1.51.24. Phase 0 still needs the successful popup/browser
record and pilot budget/distribution decisions. The runner is back in read-only
mode; no application is deployed or campaign activated.
The user handles GitHub pushes; this workspace makes local commits only.

## Start here

- [Development specification](docs/development-spec.html): complete phases and architecture.
- [Progress](docs/progress.md): current evidence and outstanding gates.
- [Feasibility results](docs/feasibility.md): what the local proof establishes.
- [Nightly test instructions](docs/nightly-smoke-test.md): diagnostic scope and separate registration requirements.
- [Sponsor-backed signature check](docs/sponsor-signature-check.md): current balance, exact cost and simulation checks before a newcomer signature.
- [One-registration runner](docs/registration-smoke-runner.md): separate manual wallet approvals, explicit send and finalized reconciliation.
- [Smoke-test spend worksheet](docs/smoke-worksheet.md): read-only cost and funding review for public S/U accounts.
- [Database setup](docs/database.md): local PostgreSQL, fixtures and isolated tests.
- [Runtime guide](docs/runtime.md): configuration, health endpoints and worker.
- [Deployment preparation](docs/deployment.md): unfunded hosting and CI configuration.
- [Registry engine](docs/registry-engine.md): pinned chain policy, account rules and exact quotes.
- [Campaign accounting](docs/campaigns.md): invitations, local APIs, reservations and operator commands.
- [Execution and recovery](docs/execution.md): signing, durable jobs, finality, recovery and activation boundaries.
- [Newcomer journey](docs/onboarding.md): screens, wallet adapter, recovery, preview and browser verification.
- [Operator runbook](docs/runbook.md): accounting exports, readiness, pause, recovery and release.
- [Backup and restore](docs/backup-restore.md): isolated synthetic database recovery proof.
- [Security model](docs/security.md): HTTP, signing, privacy and retention boundaries.
- [Pilot protocol](docs/pilot.md): live prerequisites, observation method, comparison and demo.
- [Pilot record format](docs/pilot-record-format.md): private input, aggregate report and limitations.

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
does not issue invitations. Use `/preview` for the labeled example walkthrough,
or `/start` for the invitation flow. Environment examples contain no signing keys.
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
pnpm test:onboarding
pnpm test:pilot
pnpm test:worksheet
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:operations
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:campaigns
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:execution
pnpm build
```

`test:foundation` runs without Cookie RPC access and includes synthetic wallet
diagnostic tests. PostgreSQL integration is skipped when `DATABASE_TEST_URL` is
omitted; do not count that as database verification. Test scripts read exported
shell variables, whereas Next.js, database and worker scripts load `.env`.

`test:pilot` exercises synthetic records and private files without a database or
network. To summarize real observations later, copy the blank
`docs/pilot-input.template.json` to an access-restricted location and follow the
[pilot protocol](docs/pilot.md):

```sh
pnpm pilot:report --input artifacts/private/pilot-input.json --out pilot-report.json
```

The report stays under ignored `artifacts/private/` and cannot overwrite an
existing file. Exit 2 means valid records have missing evidence; exit 1 means
invalid input or command failure. Exit 0 satisfies only the entered-record
checklist. Supporting evidence still requires manual review and the report
always keeps `phase7Complete: false`.

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

## Check Nightly

```sh
pnpm phase0:wallet
```

Open `http://127.0.0.1:8787/sponsor` in the browser containing the Nightly
extension for the [sponsor-backed check](docs/sponsor-signature-check.md).
Connect the empty newcomer, enter the separate sponsor public address and inspect
the cost/shortfall report. Signing stays disabled until the sponsor balance,
limits and exact unsigned simulation pass. This page never funds or broadcasts.
The user's successful report is saved; there is no need to repeat this signature
check just to continue development. Use the separate
[one-registration runner](docs/registration-smoke-runner.md) for the reviewed live test.

The original unfunded probe remains at the printed root URL. Nightly 1.51.24
refuses it after simulation fails; do not keep repeating its approval or fund its
random sponsor identities. Their secrets have been discarded.
The old page remains available for investigating other wallet versions. Both
pages have no broadcast endpoint. Follow the [smoke-test guide](docs/nightly-smoke-test.md).

To prepare the later funded-test cost review, use `pnpm phase0:worksheet` with
the intended name, public sponsor/recipient and explicit native-unit limits as
described in the [worksheet guide](docs/smoke-worksheet.md). It reports exact
costs, starting balances and funding shortfall privately. Its generated attempt
payer is disposable; it neither funds accounts nor produces a payload for signing.

## Repository layout

```text
src/lib/cookie/          strict account decoding and fixed transaction construction
src/lib/chain/           finalized read-only registry client and reviewed policy pins
src/lib/transactions/    exact unsigned quotes and independent message validation
src/lib/campaigns/       invitations, capability APIs and atomic reservations
src/lib/execution/       fixed-message signing, durable jobs, settlement and recovery
src/lib/operations/      private accounting export and fresh admission diagnostics
src/lib/pilot/           strict offline observation validation and aggregate reporting
src/proxy.ts            per-request nonce CSP and cache prevention
scripts/phase0/          read-only inspection, local proof and Nightly diagnostic
scripts/phase2/          read-only registry, availability, rent and fee inspection
src/app/                page shell, recovery states and health routes
src/components/         brand mark and small shared button component
src/config/             validated server configuration
src/db/                 database schema, migrations, fixture and heartbeat helpers
src/server/             server-only database access, readiness, logging and errors
src/worker/             heartbeat entry point and injectable execution worker
drizzle/                committed migration SQL and metadata
scripts/db/             explicit migration and local fixture commands
scripts/ops/            local invitation, accounting and execution commands
scripts/pilot/          private offline pilot report command
tests/                  runtime, database, transaction and diagnostic checks
docs/evidence/          reviewed public chain observation and local execution evidence
vendor/cookie-domains/   pinned upstream IDL, provenance and MIT license
```

The invitation journey calls preparation/status APIs and has an explicit Nightly
adapter. Wallet approval and submit/retry runtime routes remain disabled, and the
default worker writes heartbeats only. See the
[Phase 7 preparation evidence](docs/evidence/phase7-pilot-preparation.md) for local verification
and remaining live-wallet and runtime activation requirements.

## Development and commits

Work one phase at a time and follow `AGENTS.md`. Every completed phase receives a
local Git commit with a descriptive subject and a body explaining its changes and
verification. Partial checkpoints must identify open gates. Commit messages have
no AI/model attribution or co-author trailers. The user manages the remote and
pushes; do not authenticate GitHub CLI or push on the user's behalf.

Upstream IDL and encoding references are credited in
[vendor provenance](vendor/cookie-domains/README.md). New project code has no
publication license selected yet; choose one before the public-source submission.
