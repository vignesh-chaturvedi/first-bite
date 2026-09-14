# Unfunded deployment preparation

`railway.json` describes one Next.js web service built with Railpack. This file
does not create infrastructure or publish anything. No hosting account, project,
remote repository, database credentials or domain has been connected.

For a later explicitly requested preview, use this project directory as the
service root. Keep `RELAY_ENABLED=false` and `WORKER_ENABLED=false`, set
`APP_ORIGIN` to the preview's HTTPS origin and omit `DATABASE_URL`. Use Node 24
and the package manager pinned in `package.json`. The start command reads
Railway's `PORT` through Next.js and binds to `0.0.0.0` inside the container.
`/healthz` is the deployment liveness check. `/readyz` intentionally returns 503
without a migrated database; a static preview cannot claim service readiness.

The first hosted preview must have no sponsor/attempt keys or real invitation
tokens. Do not use local fixture database passwords for hosted services. Do not
expose runtime configuration with `NEXT_PUBLIC_` variables. `.env*`, local caches,
keys, generated signed payloads and build output are excluded from version control.

For a future database-backed environment, provision its own database, run
`pnpm db:migrate` once from a direct session connection, and check `/readyz` before
enabling traffic that needs PostgreSQL. The worker entry point is `pnpm worker`;
it requires a separate long-running service and `WORKER_ENABLED=true`. Configure
its required database, Node runtime and TypeScript runner explicitly. The current
web config does not provision or launch that service. Give it at least five
seconds to finish a bounded database operation and close on SIGTERM.

The runtime worker still only writes foundation health records. The injectable
execution engine and its operational admission check have local proof, but signer
custody and execution worker activation remain gated. A deployed shell does not
enable sponsorship. `railway.worker.json` is a separate opt-in service template;
it starts the heartbeat entry point directly, with ten seconds of overlap and
sixty seconds of SIGTERM drain. The web template starts Next directly, with ten
seconds of overlap and thirty seconds of drain. Neither file provisions services
or reads signing keys. Keep runtime dependencies available for Node/tsx; do not
prune tsx from a worker image.

Nonce CSP makes the document routes dynamic. Preserve the private/no-store
response and do not place a full-page cache in front of onboarding. `/healthz`
checks process liveness; `/readyz` still distinguishes foundation health from
`sponsorship: disabled`. Detailed campaign/chain/funding checks belong to the
private operator command, not a public health payload.

## Continuous integration

`.github/workflows/ci.yml` runs lint, types, foundation tests with isolated
PostgreSQL, peer checks and a production build. The database tests create and
remove only their own random schemas in `first_bite_test`. The separate registry
job downloads the public executable, checks its recorded hash and runs the local
proof. It never signs with a funded identity or broadcasts. An RPC outage or
upgraded executable can fail that job and requires investigation, not a silently
updated baseline.

The workflow has read-only repository permissions and no deployment or signing
secrets. It uses regular pull-request events and does not persist checkout
credentials. A remote Actions result remains pending until the user connects the
repository. Local verification must be recorded separately from hosted CI.

References: [Railway config fields](https://docs.railway.com/config-as-code/reference),
[Railway health checks](https://docs.railway.com/deployments/healthchecks),
[Node setup action](https://github.com/actions/setup-node),
[pnpm setup action](https://github.com/pnpm/action-setup).


## Activation and rollback checklist

This is a reviewable configuration, not a deployment performed by Phase 6.
Before provisioning, agree hosting costs, the finite pilot budget and signer
custody. Close the actual Nightly/funded-registration and independent-resolution
gates. Observe hosted CI after the remote is connected. Use separate preview and
production databases, wrapping keys and limited sponsor identities; previews get
no funded keys or real invitations.

1. Take a private pre-release backup and run the isolated restore drill. Review
   migration compatibility and preserve the old binary and decryption capability.
2. Run `pnpm db:migrate` once using a direct/session connection and a migration
   role. Do not put this command into every web/worker start. Historical migration
   hashes must match; the current schema remains version 3.
3. Configure HTTPS/HSTS ingress, private database access and trusted IP-header
   overwriting before any authenticated traffic. Restrict the runtime database
   role; never share migration-owner privileges as a shortcut.
4. Deploy compatible web/worker versions. Validate graceful shutdown, fresh
   execution-specific heartbeat, read-only chain policy, funding and accounting.
   The current heartbeat entry point must not be treated as an execution worker.
5. Before signer activation, test provider backup restore, an isolated destination
   and off-host wrapping-key recovery. Configure daily and weekly volume backups
   in Railway's Backups settings and capture the actual schedule/retention evidence.
   Those provider settings are not fields in these JSON files and have not been
   applied. Agree recovery objectives; consider WAL/PITR for a smaller loss window.
6. Keep reconciliation running during an ordinary campaign pause. Roll back only
   compatible application code; never reset attempts, erase jobs or restore a
   stale database as an ordinary application rollback.

A database disaster requires a separate isolated recovery: stop signer access,
retain the original volume and inventory of signed transactions, restore and
reconcile sponsor history since the recovery point before reopening admission.
A snapshot may omit sends that later finalized. Lost decryption capability and
missing signatures are operator incidents, never reasons to release uncertain
holds. See [runbook](runbook.md), [backup drill](backup-restore.md) and
[security model](security.md).

Railway references rechecked on 2026-09-14:
[deployment teardown fields](https://docs.railway.com/config-as-code/reference#deployment-teardown)
and [volume backup configuration](https://docs.railway.com/volumes/backups).
