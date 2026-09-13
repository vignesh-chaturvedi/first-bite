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

The current worker only writes health records. Queue processing, signing,
reconciliation, encryption, deploy-time migration orchestration and operational
alerts belong to later phases. A deployed shell would not enable sponsorship.

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
