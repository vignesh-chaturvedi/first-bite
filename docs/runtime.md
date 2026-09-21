# Application runtime

The web application authorizes durable registration jobs; the separate worker
holds the dedicated sponsor key and processes signing, finality and recovery.
Defaults remain paused. No hosting or funding is configured by this checkpoint.
See [application integration and hosting handoff](application-integration.md).

## Configuration

`src/config/schema.ts` validates only the supported settings below with Zod. The
web wrapper `src/config/server.ts` is marked `server-only` and reads configuration
lazily, so production builds and the unfunded shell need no database. The standalone
worker imports the pure schema and database modules without React server markers.

| Setting | Default | Rule |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `APP_ORIGIN` | `http://localhost:3000` | HTTP(S) origin without credentials, path, query or fragment |
| `COOKIE_RPC_URL` | `https://rpc.cookiescan.io` | HTTP(S) URL, server-only; used for reviewed quotes and transaction checks |
| `EXPECTED_GENESIS_HASH` | Recorded Cookie genesis | Must match the reviewed chain policy for preparation |
| `DATABASE_URL` | Unset | PostgreSQL URL; required for database readiness and enabled worker |
| `WORKER_ENABLED` | `false` | Exact strings `true` / `false` only |
| `RELAY_ENABLED` | `false` | Requires preparation, worker, database, wrapping key and sponsor public key |
| `PREPARATION_ENABLED` | `false` | Requires database and wrapping key; HTTPS in production, or local HTTP in development/test |
| `ATTEMPT_ENCRYPTION_KEY` | Unset | Canonical standard base64 for a private 32-byte wrapping key |
| `SPONSOR_PUBLIC_KEY` | Unset | Canonical on-curve public key, required for execution |
| `SPONSOR_SECRET_KEY_BASE64` | Unset | Worker only; canonical base64 64-byte keypair matching the public sponsor; never read by common config |
| `TRUSTED_IP_HEADER` | `none` | `none`, `x-real-ip` or `cf-connecting-ip`; configured ingress must overwrite the selected header |

An empty database URL is invalid. Omit it for an unfunded preview. Use a separate
`DATABASE_TEST_URL` for integration tests; it is owned by the database test runner,
not this runtime schema. Restart services after changing runtime settings. Only the enabled worker consumes a sponsor secret. Preparation uses the private wrapping key and generates
hashed capability sessions. See [campaign setup](campaigns.md) for these boundaries.
Configuration errors list field names only, never submitted values or Zod issues.

## Health endpoints

- `GET /healthz` returns HTTP 200 and `{"status":"alive"}` whenever the Node
  route is running. It does not contact the database or RPC. Use it for process
  liveness and the unfunded deployment shell.
- `GET /readyz` returns HTTP 200 only when PostgreSQL is reachable and the latest
  migration marker is exactly `app_metadata['schema_version'] = {"version":3}`.
  When `WORKER_ENABLED=true`, a worker heartbeat must also be no more
  than 30 seconds old. Execution-enabled services require a matching sponsor/custody
  fingerprint, not a shell worker or another deployment identity. Missing configuration/migrations, database errors, a stale
  required worker or timeout return HTTP 503.
- Readiness responses expose only `status`, `scope: "foundation"`, and
  the configured `relayEnabled` flag and `sponsorship: "disabled"` or
  `"campaign_checks_required"`. A ready foundation does not guarantee campaign
  funding or permit arbitrary signing. Neither endpoint publishes database addresses, credentials,
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

With defaults the process logs `worker.disabled`, opens no connection and exits.
With worker enabled and relay disabled it publishes foundation health only. With
both enabled it validates the dedicated sponsor key, verifies the database custody
binding, publishes matching execution health and runs sequential leased jobs.
The loop waits one second between ticks. Failed heartbeat checks skip execution;
only safe fixed error codes are logged.

SIGINT/SIGTERM cancel the wait and drain the in-flight tick. Shutdown removes this
worker's heartbeat, closes its pool and clears its owned sponsor-key buffer.
Unclean exits stop satisfying readiness after 30 seconds. Keep the worker's
60-second deployment drain and stable wrapping key across compatible releases.
No new registration is signed by an HTTP request. See [execution](execution.md)
for persist-before-send, finality and reservation guarantees.

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


## Private operational readiness

`pnpm ops readiness --campaign CAMPAIGN_UUID` checks a consistent accounting
snapshot, execution-role heartbeat, campaign/policy, finalized chain identity and
sponsor funding. It requires enabled runtime settings and the matching execution heartbeat. This
private diagnostic does not change public liveness or expose details in `/readyz`.
The injected execution service requires fresh passing admission evidence before
new authorization; previously authorized reconciliation proceeds during a pause
or readiness outage. See [operator runbook](runbook.md) for thresholds and scope.

Documents render dynamically with a unique CSP nonce and no-store caching. Run the
production build to verify the enforced policy; development includes HMR-specific
allowances. The deployment templates start Node directly for predictable signal
handling and allow explicit overlap/drain intervals.
