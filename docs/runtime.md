# Application runtime

This foundation starts without signing keys. It cannot register a name, sponsor a
transaction or reconcile a transaction. The Phase 0 real-wallet and funding gates
remain open; a healthy foundation does not close those gates.
The injectable Phase 4 execution engine is verified separately; its live service
and worker wiring remain disabled. See [execution and recovery](execution.md).

## Configuration

`src/config/schema.ts` validates only the supported settings below with Zod. The
web wrapper `src/config/server.ts` is marked `server-only` and reads configuration
lazily, so production builds and the static shell need no database. The standalone
worker imports the pure schema and database modules without React server markers.

| Setting | Default | Rule |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `APP_ORIGIN` | `http://localhost:3000` | HTTP(S) origin without credentials, path, query or fragment |
| `COOKIE_RPC_URL` | `https://rpc.cookiescan.io` | HTTP(S) URL, server-only; used by local quote preparation |
| `EXPECTED_GENESIS_HASH` | Recorded Cookie genesis | Must match the reviewed chain policy for preparation |
| `DATABASE_URL` | Unset | PostgreSQL URL; required for database readiness and enabled worker |
| `WORKER_ENABLED` | `false` | Exact strings `true` / `false` only |
| `RELAY_ENABLED` | `false` | `true` is rejected while live execution activation remains gated |
| `PREPARATION_ENABLED` | `false` | Requires development/test, loopback origin, database and wrapping key |
| `ATTEMPT_ENCRYPTION_KEY` | Unset | Canonical standard base64 for a private 32-byte wrapping key |
| `TRUSTED_IP_HEADER` | `none` | `none`, `x-real-ip` or `cf-connecting-ip`; configured ingress must overwrite the selected header |

An empty database URL is invalid. Omit it for a static preview. Use a separate
`DATABASE_TEST_URL` for integration tests; it is owned by the database test runner,
not this runtime schema. Restart services after changing runtime settings. No
sponsor key is consumed. Preparation uses the private wrapping key and generates
hashed capability sessions. See [campaign setup](campaigns.md) for these boundaries.
Configuration errors list field names only, never submitted values or Zod issues.

## Health endpoints

- `GET /healthz` returns HTTP 200 and `{"status":"alive"}` whenever the Node
  route is running. It does not contact the database or RPC. Use it for process
  liveness and the unfunded deployment shell.
- `GET /readyz` returns HTTP 200 only when PostgreSQL is reachable and the latest
  migration marker is exactly `app_metadata['schema_version'] = {"version":3}`.
  When `WORKER_ENABLED=true`, at least one worker heartbeat must also be no more
  than 30 seconds old. Missing configuration/migrations, database errors, a stale
  required worker or timeout return HTTP 503.
- Readiness responses expose only `status`, `scope: "foundation"`, and
  `relayEnabled: false`. Neither endpoint publishes database addresses, credentials,
  exceptions, registry details or wallet information. Both disable caching.

The readiness check has a 3.5-second response deadline. Database connections,
queries and statements separately use 3-second bounds, so timing out an HTTP
response does not leave an unbounded database request. Heartbeat freshness uses
database time and permits at most five seconds of future timestamp skew.

## Worker operation

```sh
pnpm worker
```

The package script launches:

```sh
node --env-file-if-exists=.env --import tsx src/worker/index.ts
```

With default settings the process logs `worker.disabled`, opens no connection and
exits successfully. To exercise it locally, migrate the development database and
set `DATABASE_URL` and `WORKER_ENABLED=true`. Each process uses a random public
worker ID, writes one heartbeat immediately, then updates it every ten seconds.
Transient database failures are logged as a fixed failure code and retried on the
next interval. This entry point does not load the separate Phase 4 execution
worker or process transaction jobs.

SIGINT and SIGTERM cancel the waiting interval. An active heartbeat is allowed to
finish within the database timeout, then the pool is closed and the worker exits.
No new heartbeat starts after cancellation. Old heartbeat rows remain as service
history and stop satisfying readiness after 30 seconds; a graceful stop can remain
visible as fresh until that window expires. Deployments should allow at least
five seconds for shutdown.

## Logging and API failures

`src/server/logger.ts` writes one JSON object per line with a fixed event name,
level and timestamp. It permits only a UUID request ID, valid HTTP status, finite
duration and an enumerated failure code. Unknown metadata is discarded at runtime;
URLs, free-form messages, raw errors, stacks, wallet payloads and signing material
are never accepted fields. New diagnostic fields must have an explicit safe type
and runtime validation before being added.

`ApiError` selects a known public code and generic message. `apiErrorResponse`
creates a new request ID for correlation and never serializes an unknown error.
Do not pass secrets through request IDs, log event names or custom messages.
