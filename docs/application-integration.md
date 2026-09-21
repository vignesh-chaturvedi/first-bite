# Application integration and hosting handoff

The invitation journey is now wired to the durable registration engine. This is
an implementation checkpoint, not a deployed service or authorization to spend.
The default configuration remains paused. [Local validation](evidence/application-integration.md)
records 1,228 passing tests and the production build result. The user sets up hosting next and
handles GitHub pushes; no hosting resources or real sponsor keys were created.

## What runs where

| Component | Responsibilities | Private material |
| --- | --- | --- |
| Next.js web | Invitation exchange, quotes, reservations, verified newcomer signature, durable job authorization and progress | Database URL and attempt wrapping key; **no sponsor secret** |
| PostgreSQL | Campaign caps, invitations, ledger, encrypted attempts/packets and leased jobs | Private durable database; backed up with custody metadata |
| Persistent Node worker | Load dedicated sponsor, validate and sign fixed messages, persist before send, reconcile finality and residual recovery | Same database and wrapping key, plus dedicated sponsor secret |
| Nightly | Newcomer connects on Cookie and approves the reviewed transaction | Newcomer key stays in Nightly |

The separate successful smoke runner used two Nightly approvals. The application
uses the planned automated sponsor engine, so newcomers make one approval. A
**new dedicated app sponsor** belongs in the worker's secret manager during setup;
there is no need to export the existing Nightly accounts. Funding and campaign
caps will be decided before activating real invitations.

## Prepare these three services

Use this repository's `first-bite` directory as the service root, Node 24.6–24.x
and pnpm 11.20.0. Keep dev dependencies available when building and in the worker
image because its entry point uses `tsx`.

| Service | Build / setup | Start |
| --- | --- | --- |
| Web | `pnpm install --frozen-lockfile` then `pnpm build` | `node node_modules/next/dist/bin/next start --hostname 0.0.0.0` |
| Database | PostgreSQL 17, private connection; run `pnpm db:migrate` once from a release task | Managed by your hosting provider |
| Worker | `pnpm install --frozen-lockfile` then `pnpm typecheck` | `node --import tsx src/worker/index.ts` |

Do not migrate at every web/worker start or run fixture seeding on production.
`railway.json` and `railway.worker.json` provide separate optional templates.
A static-only host cannot run the server routes or persistent worker. Migrations
use a direct or session database connection; avoid transaction pooling for the
migration command's session lock. Allow at least 60 seconds for worker drain.

## Initial hosting configuration: paused

Set `NODE_ENV=production`, `APP_ORIGIN` to the web service's exact HTTPS origin,
`DATABASE_URL` to the private database, and keep `RELAY_ENABLED=false` and
`PREPARATION_ENABLED=false`. The web needs no sponsor secret. The database-backed
heartbeat can be tested with `WORKER_ENABLED=true`. The worker can be provisioned
with no sponsor key until the later activation step.

`/healthz` checks the process. `/readyz` checks the migrated database and, when
required, fresh worker health. Neither endpoint authorizes a registration.

After the services exist, we will verify them and configure activation together:

- Both web and worker: the same `APP_ORIGIN`, database, Cookie RPC and reviewed
  genesis, canonical 32-byte base64 `ATTEMPT_ENCRYPTION_KEY`, and
  `SPONSOR_PUBLIC_KEY`. Set the three enable flags to `true` only for activation.
- Worker only: canonical standard-base64 `SPONSOR_SECRET_KEY_BASE64` encoding the
  dedicated sponsor's full 64-byte keypair. The loader verifies its public key.
- Configure `TRUSTED_IP_HEADER` only if your ingress overwrites that header and
  prevents direct access. Never send secrets as `NEXT_PUBLIC_*` settings or chat
  messages. Keep the RPC credentials and private database URL server-side.

Disabled execution does not load a signer. Enabled web code exposes submit/retry
only, uses a read-only chain adapter and cannot co-sign. An enabled worker refuses
missing, malformed or mismatched sponsor keys before advertising readiness.

## Custody, admission and recovery

The first enabled admission/worker heartbeat stores a custody fingerprint in
`app_metadata` for the sponsor. It binds the reviewed chain policy and wrapping
key. Another replica with a different key cannot claim work or overwrite that
binding. The application refuses to infer custody if unbound encrypted legacy
preparations already exist. Start this first deployment with a new migrated
database; do not delete custody metadata to bypass a mismatch.

Back up the wrapping key separately from the database. Keep it stable across web
and worker, deployments and restores. Automatic key rotation is not implemented.
A custody mismatch requires restoring the correct configuration or a separately
reviewed migration, not resetting attempts or reservations.

Matching execution heartbeats include the custody identity. Ordinary heartbeats,
other sponsors, other wrapping keys and stale workers do not satisfy admission.
Quotes, reservations and new signed authorizations check operational health;
reservations and authorization still enforce caps and eligibility under database
locks. Jobs are leased only by the configured sponsor's worker. Saved signed
bytes and transaction identity survive restarts and uncertain responses.

Pause the **campaign** to stop new registrations while allowing authorized work
and recoveries to finish. Turning execution off is an emergency stop and suspends
reconciliation; it does not erase liabilities. The private `pnpm ops` commands now
accept a configured hosted database and never load a sponsor key or broadcast.
See [campaign commands](campaigns.md), [execution](execution.md), and
[backup/restore](backup-restore.md).

## Submission scope and remaining work

The user chose to reuse the one verified registration and defer the five-person
pilot. The exact historic popup wording remains unavailable; no paid repeat is
needed to recreate it. User-confirmed GitHub Actions passed before this change;
this integration needs its own run after the user pushes.

Remaining: provision services, agree the finite reviewer campaign and custody
setup, check the hosted Nightly journey, and prepare submission assets/links.
No deployed end-to-end result is claimed by the local tests. Any further paid
registration requires a stated purpose, accounts and spending ceiling.
