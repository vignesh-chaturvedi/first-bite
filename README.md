<p align="center">
  <img src="public/brand/first-bite-readme.png" width="180" height="180" alt="First Bite — a forest-green bite symbol with a sage crumb" />
</p>

# First Bite

**A sponsored first `.cook` name for newcomers to Cookie Chain.**

First Bite lets a community sponsor cover a newcomer's name registration, account
setup and network fee through a capped, wallet-bound invitation. The newcomer
keeps ownership of their name and wallet. It integrates Cookie's existing naming
registry; it does not deploy a new token or naming program.

[Live website](https://first-bite-web.onrender.com/) ·
[Interactive walkthrough](https://first-bite-web.onrender.com/preview) ·
[Verified registration](docs/evidence/first-live-registration.md) ·
[GitHub Actions](https://github.com/vignesh-chaturvedi/first-bite/actions/workflows/ci.yml)

## For reviewers: start here

1. **Try the walkthrough:** open [/preview](https://first-bite-web.onrender.com/preview),
   use the example invitation, connect the example wallet, choose a name and
   follow the review and completion screens. No wallet extension or funds are
   needed. This walkthrough is labeled as a simulation throughout.
2. **Inspect the real transaction:** open the
   [finalized CookieScan receipt](https://cookiescan.io/tx/Aj3TFknX3H2t25chxevjtQ4Ycz9TSFAg2nH1RNQadxt5t4S8c1146RtAR7AgPhcw5Wxd6AGEAoQhfQdAuSaCkhC)
   and compare it with the [verification record](docs/evidence/first-live-registration.md).
3. **Reproduce locally:** follow [Quick start](#quick-start) for the UI, or
   [Run the checks and transaction proofs](#run-the-checks-and-transaction-proofs)
   for the database and registry engine.

The Render service may show a startup screen on its first request after sleeping.
Wait for it to finish loading. The public site currently offers the walkthrough
and saved-progress interface; **new wallet approvals are paused**. The real proof
below was completed with the separate, two-wallet Nightly registration runner.
It is not a claim that the hosted invitation journey is accepting live claims.

## Verified on Cookie Chain

On **21 September 2026**, First Bite completed one real sponsored registration
of **`firstbitecheck0001.cook`**. Finalized receipt and account reads verified
ownership, primary-name assignment and exact sponsor spending. The newcomer had
**0 COOK before and after** the transaction.

| Recorded result | Value |
| --- | --- |
| Transaction result | Success, finalized |
| Finalized slot | `26344969` |
| Name | `firstbitecheck0001.cook` |
| Verified owner | `33tjyHQ327RZtCGDFimQHuxB2HW1KSPwdanekKCNJhKW` |
| Primary name | `firstbitecheck0001.cook`, assigned to the same owner |
| Registration price | 15,000 COOK |
| Total sponsor debit, including rent and fee | **15,000.00336972 COOK** |
| Network fee, included in that total | 0.000015 COOK |
| Newcomer debit / temporary payer residual | 0 COOK / 0 COOK |
| Wallet / browser used | Nightly 1.51.24; Brave 1.94.121 |

**Transaction signature (hash):**

```text
Aj3TFknX3H2t25chxevjtQ4Ycz9TSFAg2nH1RNQadxt5t4S8c1146RtAR7AgPhcw5Wxd6AGEAoQhfQdAuSaCkhC
```

[Open transaction on CookieScan](https://cookiescan.io/tx/Aj3TFknX3H2t25chxevjtQ4Ycz9TSFAg2nH1RNQadxt5t4S8c1146RtAR7AgPhcw5Wxd6AGEAoQhfQdAuSaCkhC) ·
[Detailed evidence and verification boundaries](docs/evidence/first-live-registration.md) ·
[Public metadata JSON](docs/evidence/first-live-registration.public.json)

[Sprinkle](https://sprinkle-ten.vercel.app) also resolved the registered name to
the same newcomer address during verification. That demonstrates forward
resolution in another ecosystem application; the primary-name result comes from
finalized registry account reads. No second paid registration is needed to
inspect this proof. These amounts describe this transaction, not a current quote.

## What is implemented, and what is live

| Area | Current scope |
| --- | --- |
| Hosted web UI | Next.js on Render, with Neon PostgreSQL; public simulated walkthrough available |
| Real on-chain proof | One finalized sponsored registration through the separate runner, using two manual Nightly approvals |
| Application engine | Invitation exchange, quotes, capped reservations, Nightly signing adapter, durable submission, finality and recovery implemented and locally tested |
| Application worker | Tested locally on the operator's Mac; no continuously operated public sponsorship service |
| New public registrations | Paused; no public funded campaign is offered |
| User research | No multi-person pilot or adoption/retention claim |

An enabled application campaign is designed for **one newcomer approval**; the
worker supplies the sponsor signature. That hosted flow has not been verified
with a funded invitation. Exact historical Nightly popup wording is unavailable;
the extension version, browser version and finalized receipt are recorded.

## Architecture

```mermaid
flowchart LR
  N[Newcomer + Nightly] --> W[Next.js web and API]
  W --> D[(PostgreSQL)]
  R[Node worker] <--> D
  R --> C[Cookie naming registry]
  C --> R
  W --> N
```

The web process handles invitations, coverage and progress. PostgreSQL records
campaign limits, reservations, encrypted attempts and durable jobs. When execution
is enabled, the worker signs only validated registration messages, saves the
transaction before sending, and reconciles finality and exact spending. The web
process does not receive the sponsor secret.

The fixed transaction funds a temporary payer, registers the name, transfers it
to the newcomer and assigns their primary name. Sponsor, temporary payer and
newcomer are three distinct signers. Amounts use exact native units rather than
floating-point arithmetic. See [execution and recovery](docs/execution.md) and
the [security model](docs/security.md).

**Stack:** Node 24, Next.js 16, React 19, TypeScript, Tailwind CSS, PostgreSQL 17,
Drizzle, `@solana/web3.js`, Nightly, Vitest and LiteSVM. Exact versions are pinned
in [package.json](package.json) and [pnpm-lock.yaml](pnpm-lock.yaml).

## Quick start

Requires Git, **Node 24.6.0–24.x** and **pnpm 11.20.0**. The recorded Node version
is in [.node-version](.node-version). Docker is only needed for the optional
database setup below.

```sh
git clone https://github.com/vignesh-chaturvedi/first-bite.git
cd first-bite
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Copy `.env.example` only on a fresh checkout; retain an existing local `.env`.
Open [localhost:3000](http://localhost:3000), then choose **Walkthrough**, or visit
[localhost:3000/preview](http://localhost:3000/preview) directly.

The default configuration needs **no database, wallet or funds**. Keep
`RELAY_ENABLED`, `PREPARATION_ENABLED` and `WORKER_ENABLED` set to `false`.
Leave `DATABASE_URL` commented out when unused; an empty value is invalid.
The `/start` page is the real invitation interface, not a source of demo passes.

If port 3000 is occupied, run:

```sh
APP_ORIGIN=http://localhost:3001 pnpm dev --port 3001
```

Use that exact origin in the browser. To check a production build, stop the dev
server and run `pnpm build`, then `pnpm start`. This is a Node-hosted Next.js
application, not a static export.

## Add local PostgreSQL and the worker

This optional setup exercises the application foundation without signing or
spending. Install Docker with Compose, then start the supplied PostgreSQL service:

```sh
docker compose up -d --wait postgres
```

Set these values in your development `.env`:

```dotenv
DATABASE_URL=postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev
WORKER_ENABLED=true
RELAY_ENABLED=false
PREPARATION_ENABLED=false
```

The credentials above belong only to the local development container.
Apply migrations and optional development fixture metadata:

```sh
pnpm db:migrate
pnpm db:seed
```

Restart `pnpm dev` in one terminal and run `pnpm worker` in another. Both read the
same `.env`. In this configuration the worker writes health heartbeats only;
no sponsor key is required. Seeding creates no wallets, invitations or funds.

- `/healthz` reports whether the web process is healthy.
- `/readyz` checks the migrated database and the required worker heartbeat.
  Expect `status: "ready"`, `scope: "foundation"`, `relayEnabled: false` and
  `sponsorship: "disabled"` once both services are ready. This does not enable claims.
- In the database-free preview, a 503 response from `/readyz` is expected.

Compose exposes PostgreSQL only at `127.0.0.1:55432` and creates separate
`first_bite_dev` and `first_bite_test` databases on the first volume initialization.
Use `docker compose stop postgres` to stop it without deleting data. See
[database setup](docs/database.md) for existing-volume and port troubleshooting.

## Run the checks and transaction proofs

For a quick check without a database or wallet:

```sh
pnpm peers check
pnpm lint
pnpm typecheck
pnpm test:onboarding
pnpm build
```

For the complete test suite, start local PostgreSQL as above, then:

```sh
export DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test'
pnpm phase0:inspect
pnpm test
pnpm phase0:proof
```

`phase0:inspect` makes read-only Cookie RPC calls and downloads the deployed
registry executable to ignored `.cache/registry.so`, checking its reviewed
genesis and program hash. **Run it before the full suite on a fresh checkout.**
The proof then executes that program locally in LiteSVM with synthetic accounts
and balances; these commands do not spend real COOK or broadcast transactions.

Tests use isolated schemas in the separate test database and apply their own
migrations. They read exported `DATABASE_TEST_URL`, not `.env` automatically.
Database integration cases skip when it is omitted. The full suite also needs
the reviewed executable; a skipped or unavailable prerequisite is not a passing
proof. HTTP tests need permission to bind local loopback ports.

For checks without RPC access, follow the `foundation` job in
[CI](.github/workflows/ci.yml); it excludes `tests/execution-flow.test.ts` from
`test:execution`. The `registry-proof` job downloads the pinned executable and
runs the VM-backed proofs separately. A registry upgrade intentionally fails the
hash check; do not silently replace the reviewed policy to make a test pass.
See [feasibility](docs/feasibility.md) for the recorded executable hash.

## Deploying your own instance

The walkthrough can run as a Next.js web service with execution paused. For the
complete sponsored application, use a web service, PostgreSQL and a persistent
Node worker. The worker must stay available to reconcile authorized transactions;
running it once does not create a permanently active service.

| Service | Build / setup | Start |
| --- | --- | --- |
| Next.js web | `pnpm install --frozen-lockfile --prod=false` then `pnpm build` | `node node_modules/next/dist/bin/next start --hostname 0.0.0.0` |
| PostgreSQL | PostgreSQL 17; run `pnpm db:migrate` once with a direct/session connection | Managed database service |
| Node worker | `pnpm install --frozen-lockfile --prod=false` then `pnpm typecheck` | `node --import tsx src/worker/index.ts` |

Set `NODE_ENV=production` and `APP_ORIGIN` to your exact HTTPS site origin.
Use the host's private environment settings for database credentials. Keep
execution flags false for the walkthrough. `tsx` is needed by the worker, so
retain development dependencies in its runtime image. Do not run local fixture
seeding on a hosted database.

For funded campaigns, the web and worker need matching configuration, a stable
attempt-encryption key, a dedicated sponsor and finite campaign limits. Only the
worker receives the sponsor secret. Follow the [hosting and activation guide](docs/application-integration.md)
and [operator runbook](docs/runbook.md); toggling flags alone is not a complete
activation procedure. Never commit `.env`, private keys or signed payloads.

## Program and evidence references

| Reference | Value |
| --- | --- |
| Network | Cookie Chain (independent SVM network); native asset COOK |
| RPC | `https://rpc.cookiescan.io` |
| Expected genesis | `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2` |
| Existing naming registry | [`H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA`](https://cookiescan.io/address/H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA) |
| New First Bite token or program | None; First Bite integrates the existing registry |

- [Real registration evidence](docs/evidence/first-live-registration.md): receipt,
  ownership, primary name, spending, independent resolution and limitations.
- [Application integration proof](docs/evidence/application-integration.md):
  recorded local tests of the complete application engine.
- [Nightly signature evidence](docs/evidence/nightly-signature-pass.md): the
  separately observed wallet compatibility check.
- [Development specification](docs/development-spec.html) and
  [progress record](docs/progress.md): architecture decisions and dated checkpoints.
- [Campaigns](docs/campaigns.md), [onboarding](docs/onboarding.md),
  [backup and restore](docs/backup-restore.md), [security](docs/security.md).

## Repository map

```text
src/app/                 web pages, API routes and health endpoints
src/components/          onboarding UI, shared controls and brand graphics
src/lib/cookie/          registry decoding and fixed transaction construction
src/lib/chain/           read-only chain client and reviewed policy pins
src/lib/transactions/    quotes and independent message validation
src/lib/campaigns/       invitations, capabilities and capped reservations
src/lib/execution/       durable signing, jobs, settlement and recovery
src/db/ and drizzle/     schema and committed migrations
src/worker/              heartbeat and enabled execution runtime
scripts/phase0/          local proof, wallet diagnostics and separate live runner
scripts/ops/             operator CLI; no sponsor signing key required
tests/                  unit, HTTP, PostgreSQL and LiteSVM checks
docs/evidence/           public verification records; no signing secrets
vendor/cookie-domains/   upstream IDL, provenance and license
```

## Attribution and license

Cookie registry IDL and encoding references are credited in
[vendor provenance](vendor/cookie-domains/README.md); their existing
[MIT license](vendor/cookie-domains/LICENSE) is preserved.
First Bite is released under the [MIT license](LICENSE). Copyright (c) 2026
Vignesh Chaturvedi. Upstream and dependency notices retain their respective terms.
