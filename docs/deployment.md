# Deployment preparation

The current service commands, configuration and sequence are in the
[application integration handoff](application-integration.md). The user will set up
hosting next. No provider resources, credentials, keys or funded campaign have
been created by this implementation.

`railway.json` defines the Next.js web service and `railway.worker.json` defines a
separate persistent Node worker. They do not provision PostgreSQL or launch each
other. Default runtime flags remain off. Provision the services in paused mode,
apply migrations once, then verify them before enabling bounded sponsorship.

Documents use nonce CSP and no-store responses; do not cache the invitation flow.
Use `/healthz` for process liveness. `/readyz` checks the migrated database and the
required worker identity; campaign funding and accounting remain private operator
checks. Graceful worker shutdown drains work, withdraws its heartbeat and closes
custody. Keep the configured 60-second drain period.

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
credentials. The user confirms the preceding shutdown-fix commit passed GitHub Actions.
The application-integration commit needs its own hosted run after push. Local
verification is recorded separately from hosted CI.

References: [Railway config fields](https://docs.railway.com/config-as-code/reference),
[Railway health checks](https://docs.railway.com/deployments/healthchecks),
[Node setup action](https://github.com/actions/setup-node),
[pnpm setup action](https://github.com/pnpm/action-setup).


## Activation and rollback checklist

This is a reviewable configuration, not a deployment performed by Phase 6.
The Nightly/funded-registration and independent-resolution proof is complete.
The user deferred the five-person pilot. Before activating a reviewer campaign,
agree its finite operating budget and dedicated sponsor custody, and verify the
new commit through CI. Use separate preview and
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
   A plain heartbeat is insufficient; admission requires the matching execution
   fingerprint and a successfully loaded worker signer.
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
