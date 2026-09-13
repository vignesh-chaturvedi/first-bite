# Local database foundation

Phase 1 adds two tables: `app_metadata` records the schema version and local
fixture, and `service_heartbeats` records each worker's start and most recent
heartbeat. Sponsorship, invitations, reservations and ledger tables belong to
later phases.

## Start PostgreSQL

From the project directory:

```sh
docker compose up -d postgres
```

The development-only container listens on `127.0.0.1:55432`. Its named volume
persists data across restarts. The initial entrypoint creates separate
`first_bite_dev` and `first_bite_test` databases. The committed username/password
are explicitly non-secret local fixtures; never use them for a hosted database.
Set `FIRST_BITE_DB_PORT` before starting Compose to choose another local port.

Docker initialization scripts run only for a new volume. If an existing local
volume lacks the test database, add just that database:

```sh
docker compose exec postgres createdb -U first_bite first_bite_test
```

This command should only be needed once; an already-existing database error is
harmless. Do not delete a volume to rerun initialization. Stop the local service
with `docker compose stop postgres` when it is not needed.

A native PostgreSQL 17 instance also works. Create the same two databases under
a local role, and adjust the two URLs to its port and credentials.

### Temporary verification without persistent Docker storage

If the Docker VM has insufficient disk space to initialize a volume, a bounded
memory-backed instance can exercise the database tests. It uses the same port, so
stop the project Compose service first. This is disposable verification storage;
all its data disappears when the container stops.

```sh
docker compose stop postgres
docker run --detach --rm --name first-bite-verification-postgres --tmpfs /var/lib/postgresql/data:rw,size=512m --publish 127.0.0.1:55432:5432 --env POSTGRES_USER=first_bite --env POSTGRES_PASSWORD=first_bite_local_only --env POSTGRES_DB=first_bite_dev postgres:17.11-alpine
docker exec first-bite-verification-postgres pg_isready -U first_bite -d first_bite_dev
docker exec first-bite-verification-postgres createdb -U first_bite first_bite_test
```

Run `createdb` after `pg_isready` reports accepting connections. Use the migration,
fixture and test commands below, then stop the temporary instance:

```sh
docker stop first-bite-verification-postgres
```

Restore adequate Docker storage before returning to the persistent Compose setup.
Do not remove unrelated project volumes to rerun First Bite's tests.

## Apply migrations and seed development

Use a direct/session database connection for migrations: the advisory lock must
stay on the same connection through the complete migration run. Do not use a
transaction-mode pooler for this command.

```sh
DATABASE_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev' pnpm db:migrate
DATABASE_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_dev' pnpm db:seed
```

Migration SQL, Drizzle snapshots and the journal are committed under `drizzle/`.
The initial migration inserts `schema_version = {"version":1}` for readiness.
Repeated migration runs verify the recorded hashes against the committed SQL
and apply only pending migrations. A concurrent migration fails clearly; retry
after the other migrator finishes. Applied migration files are immutable—add a
new migration for later changes.

`db:seed` only writes the `development_fixture` metadata row, with the same value
on every run. It contains no wallets, private keys, invitations or funds. The CLI
rejects production mode, remote hosts, other database names and connection
overrides. It accepts only local `first_bite_dev` or `first_bite_test` databases.

To generate a future migration after changing the schema:

```sh
pnpm db:generate
```

Review generated SQL before applying it. The application and worker never apply
migrations on startup. Migration commands close their pool on success and failure;
they report fixed event names without URLs, SQL parameters or raw driver errors.

## Verify against PostgreSQL

```sh
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:db
```

Integration tests require the dedicated local `first_bite_test` database. Each
run creates a randomly named private schema and separate migration-history
schema, exercises migrations, deterministic fixtures, heartbeat updates,
migration locking and history-integrity checks, then drops only those schemas.
It does not truncate development tables or reset the database.

Without `DATABASE_TEST_URL`, URL/fixture-boundary tests still run, and PostgreSQL
integration cases are explicitly skipped. A skipped integration suite is not
evidence that database verification passed; CI and phase verification must set
the test URL.

## Connection lifecycle

`createDatabase(databaseUrl)` returns an owned `{ db, pool }` pair. It opens
connections lazily, caps each pool at five connections, and uses three-second
connection, statement and query timeouts. Account for one pool per web process
and worker when sizing a later deployment. Handle query failures at the request
or worker boundary and close the pool during graceful shutdown. Idle-pool errors
emit only a fixed structured event, never the original driver error.

Web access must go through a server-only module. Browser components must not
import `src/db`; the Node worker, migration runner and tests can import it directly.
Production database credentials belong only in server runtime configuration.

References: [Drizzle PostgreSQL integration](https://orm.drizzle.team/docs/get-started-postgresql),
[node-postgres pool lifecycle](https://node-postgres.com/apis/pool),
[PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS),
[official PostgreSQL image versions](https://github.com/docker-library/postgres/blob/master/versions.json).
