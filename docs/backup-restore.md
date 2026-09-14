# Local backup and restore drill

Phase 6 provides a reproducible PostgreSQL archive/restore proof using synthetic
records. It creates its own source and destination databases; it cannot back up or
replace an existing application database. Production backup storage, key custody,
retention, point-in-time recovery, and an approved recovery objective remain
release work.

## Run the drill

Use the project's installed Node dependencies and a disposable PostgreSQL 17.11
container. The example credential is local fixture data. This container requires
no named volume and exposes PostgreSQL only on loopback:

```sh
docker run --detach --name first-bite-restore-drill-local \
  --label app.first-bite.restore-drill=local-only \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=first_bite \
  --env POSTGRES_PASSWORD=first_bite_local_only \
  --env POSTGRES_DB=first_bite_test \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m \
  postgres:17.11-alpine

docker exec first-bite-restore-drill-local pg_isready -U first_bite -d first_bite_test

node --import tsx scripts/ops/restore-drill.ts \
  --container first-bite-restore-drill-local --port 55432

# Remove only this disposable container after the drill finishes.
docker rm --force first-bite-restore-drill-local
```

Wait until `pg_isready` reports acceptance before running the drill. If port
55432 is occupied, choose another loopback host port in both commands. The
already-running, identically labeled Phase 6 container is also accepted with
`--container first-bite-phase6-postgres`.

Do not add `--env-file`, run in `NODE_ENV=production`, or supply real credentials.
The command does not load `.env`, `DATABASE_URL`, `DATABASE_TEST_URL`, RPC URLs,
wallet keys, or application execution flags. It resolves Docker's current context
to a local Unix socket, pins subsequent Docker commands to that socket, and
refuses remote Docker endpoints. It also verifies the disposable label, image
version, running state, and exact loopback port mapping before creating databases.
The Docker socket/container administrator remains a trusted local dependency.

Exit code 0 and `restore_drill.complete` indicate that verification **and cleanup**
succeeded. Output contains only fixed checks, aggregate counts and SHA-256 values.
It excludes invitation codes, session tokens, database rows, signed payloads,
encrypted envelopes, credentials and keys. Errors use fixed codes without raw
PostgreSQL or child-process errors. Each Docker command has a 30-second deadline;
SQL connections, statements and lock acquisition also have finite timeouts.

## What is proved

1. Two fresh database names use a random 96-bit identifier under
   `first_bite_drill_`. Both are created from `template0`. Creation must succeed;
   there is no reuse, `DROP ... IF EXISTS`, `FORCE`, `--clean` or restore-to-existing
   option. Only names successfully created by this invocation are cleaned up.
2. The source applies all committed migrations, including migration-history hash
   validation. Application stores create two distinct synthetic campaigns with
   generated unfunded S/A/U keys and fabricated, non-live blockhashes. One fixture
   holds a signed operation in `broadcast_unknown`; the other has synthetic
   successful settlement, debit, fee, reservation release and a consumed invite.
   Both campaigns are paused before the snapshot.
3. `pg_dump --format=custom` writes an archive to a new mode-0700 temporary
   directory and an exclusive, non-symlink, mode-0600 file. The command checks the
   `PGDMP` header, archive mode, size and SHA-256. It rejects an archive over 8 MiB.
4. `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` restores
   into the new empty destination. It does not execute a worker, query a chain,
   broadcast bytes, grant access or activate application services.
5. Sorted row fingerprints and counts match for all 12 application tables and
   migration history. Constraint definitions, indexes including partial indexes,
   append-only trigger/function definitions and sequence state also match.
   Rerunning the migration checker on the destination accepts restored history.
6. Pending payer-key and signed-payload envelopes match byte for byte. The
   ephemeral drill wrapping key decrypts both to matching hashes, and all three
   signatures of the restored synthetic transaction verify. The transaction
   remains unbroadcast; its hold, invitation relation, retry count and pending
   job survive restoration.
7. Exact PostgreSQL numeric sums reconcile campaign reserves/spending with attempt
   balances and reserve/debit/fee/release/recovery ledger formulas. User counters
   match reserved attempts and consumed invitations. Ledger and audit UPDATE,
   DELETE and TRUNCATE commands each fail with the append-only error. Budget,
   negative-reservation, unique-job and foreign-key violations are rejected.
   All guard probes are rolled back, followed by another fingerprint comparison.
8. Open database pools close; only the two owned databases and private temporary
   directory/archive are removed. The script never starts workers or changes
   application runtime flags. SIGINT/SIGTERM request cleanup. An abrupt kill or
   host failure may prevent cleanup; do not assume success without the final
   cleanup result. A `cleanup_failed` result requires inspecting the dedicated
   disposable container and temporary `first-bite-restore-*` directories before
   removing them; never substitute an application database in a cleanup command.

The custom archive is a consistent single-database backup, restored using
PostgreSQL's archive reader. Global roles and tablespaces are outside this
archive; owners and grants are intentionally omitted for the local proof.
See the official [pg_dump documentation](https://www.postgresql.org/docs/17/app-pgdump.html)
and [pg_restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Recorded local evidence

On 2026-09-14 the drill passed using the labeled
`first-bite-phase6-postgres` PostgreSQL 17.11-alpine container on port 55432:

- 53,649-byte custom archive, mode `0600`, SHA-256
  `00cd29976b38e20dccec4e0f0f48d3fcf552271544fa812a92c1e16d44dfdd21`.
- Schema version 3; three migration records; two campaigns, invites, capability
  sessions, quotes, attempts and operations; five ledger entries; one pending job;
  six audit entries. Ninety constraints, 43 indexes, two triggers and one sequence
  matched. All ciphertext, decryption, signature and accounting checks passed.
- Six append-only rejection checks and four other database-constraint checks
  passed. Two temporary databases and the archive were removed. Zero workers and
  zero broadcasts.
- 36 local boundary tests, TypeScript and focused lint passed. The randomized
  fixture/archive fingerprints change between successful runs.

## Production recovery direction

An actual backup contains private application data even when payer keys and
payloads are encrypted. Store it encrypted with restricted access outside source
control; store the wrapping key separately with its own recovery test. Do not
publish dumps, signing material, full records or capability hashes as evidence.
Custom-format compression alone is not encryption.

Before any funded launch, select a database host and approve backup frequency,
retention and RPO/RTO; configure provider backups or WAL/PITR, isolated restore
access, and off-host key recovery. This local drill does not establish a production
RPO/RTO or prove recovery after losing the wrapping key.

For an actual recovery, isolate the destination and keep preparation, relay and
workers disabled. Preserve the exact restored signed bytes and held reservations.
Validate migration history, schema and accounting; then independently reconcile
every unresolved transaction against finalized chain evidence before enabling any
worker or reopening invitations. A restored database can predate already-sent
transactions: database restoration alone cannot show that an attempt is safe to
replace, refund or release. Pause status alone is insufficient isolation because
already-authorized work may still need reconciliation. Re-enable service only
through the deployment runbook after live wallet, signer and pilot gates are met.
