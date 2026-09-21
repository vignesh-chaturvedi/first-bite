# Invitations and campaign accounting

A capability permits preparation for one wallet-bound invitation; it does not
prove control of that wallet. The execution service verifies the newcomer's exact
transaction signature before authorizing worker signing. Enabled preparation and
submission require matching worker health and bounded campaign/chain checks.

Operator commands now use the configured private database, including hosted
PostgreSQL. They never read a sponsor secret or broadcast. See the
[hosting handoff](application-integration.md) and [execution contract](execution.md).
The earlier five-user pilot is deferred; a future funded reviewer campaign still
needs its own finite cap and invitations.

## Data and reservation rules

Migration `0001_campaign_accounting.sql` adds campaigns, wallet-bound invites,
hashed capability sessions, quotes, attempts, ledger entries and rate buckets.
That migration sets readiness version 2; Phase 4 advances it to version 3.
Native-unit amounts are decimal strings
in PostgreSQL/JSON and `bigint` in application arithmetic.

Campaigns begin as drafts. Activation, schedule and invitation expiry are checked
again under the campaign lock when a quote is saved or an attempt reserved.
Reservation checks the stored fixed message, reviewed registry policy, wallet,
exact execution/recovery costs and unsigned lease. It atomically records the
attempt, holds its full maximum cost and one user slot, points the invitation at
the attempt, and appends one reserve event. No RPC call runs while these locks
are held. A database reservation cannot reserve a name on-chain; the Phase 4
engine rechecks availability and policy before authorization and signing.

Partial unique indexes prevent simultaneous active attempts for an invitation,
a campaign/wallet pair or a name across campaigns. Attempt payer identities are
unique across all attempts. The same invitation/idempotency key and quote returns
the existing attempt; reusing the key with another quote is a conflict. A retry
does not create another ledger entry or extend expiry.

Prepared, unsigned attempts can expire. Release locks the campaign, invitation
and attempt, checks its current state, releases only its recorded reservation,
and appends a unique release event. Signing, signed, submitted, uncertain,
confirmed, finalized and manual-review states retain their holds regardless of
wall-clock expiry. Pausing/revoking does not release money. Phase 4 supplies the
chain reconciliation and settlement transitions. Only `reserve` and `release`
ledger events are written by preparation; Phase 4 settlement writes verified
debit, fee and recovery events.
The ledger trigger rejects UPDATE, DELETE and TRUNCATE. A database owner can
alter schema/triggers, so database credentials remain a trusted boundary.

The unsigned sweep processes at most 500 expired attempts and 500 abandoned
quotes per call, clearing their encrypted payer keys. Repeat until no work
remains. It skips quotes locked by another transaction. The configured execution
worker schedules this sweep each tick; the operator CLI can also run it explicitly.

## Capabilities and keys

Invitation and session capabilities use 32 random bytes. Only purpose-separated
SHA-256 hashes are stored. Invitations are tied to one expected wallet and
campaign; uniqueness prevents issuing a second pass to that wallet in the same
campaign. A token exchange creates a session lasting at most 15 minutes, capped
by invite/campaign expiry. At most five unrevoked sessions are retained per invite.
Rotation replaces the invitation token and revokes old sessions/quotes; it is
refused while an active attempt exists or after consumption. Revocation prevents
new preparation and session access; an existing hold still follows its own
unsigned or reconciliation rules.

Session cookies are HttpOnly, SameSite=Strict, Path=/ and Secure for HTTPS. Local
loopback HTTP development omits Secure. Mutation requests require the exact
configured Origin, same-origin fetch metadata when present, strict JSON fields
and an actual streamed body no larger than 4 KiB, with a five-second total read
deadline and cancellation on timeout. API responses are private,
no-store and no-referrer. Tokens belong in POST bodies/cookies, never URLs.

The server creates a fresh attempt payer for each quote. Its secret is wrapped
with AES-256-GCM, a random nonce and authenticated preparation UUID/public key.
The encrypted envelope moves from quote to attempt in the reservation transaction.
Only the capability-authenticated unsigned transaction is returned to the browser.
The wrapping key stays in server environment configuration, separate from the
database and source. Buffer clearing is best effort in JavaScript; runtime or
cryptographic-library copies may remain until garbage collection. There is no
sponsor secret in this phase. Key rotation with outstanding attempts requires a
later operator procedure; do not replace the wrapping key while holds remain.

Rate limits use atomic PostgreSQL fixed windows. Every operation checks its global
bucket before any source bucket, then its source bucket before capability-specific
buckets. A global denial cannot create new arbitrary IP/token rows. Preparation
also has invitation, wallet and session buckets.
Denied requests retain their bucket counts. Keys hash scope/identity, so the
rate table contains no raw IP addresses or capabilities. The default
`TRUSTED_IP_HEADER=none` deliberately shares one aggregate source bucket.
`x-real-ip` or `cf-connecting-ip` may be selected only behind an ingress that
overwrites that header. Forwarded headers are not guessed or trusted by default.
These limits are not Sybil protection. The submit/retry boundary shares
global, source, session, wallet and attempt limits.

## Local setup

Apply migrations using [the database guide](database.md). In the private `.env`,
set the local database URL, `APP_ORIGIN=http://127.0.0.1:3000`,
`PREPARATION_ENABLED=true`, and `ATTEMPT_ENCRYPTION_KEY` to a securely generated
32-byte key encoded as canonical standard base64. Never prefix it with
`NEXT_PUBLIC_`, commit it or paste it into a support log. Keep
`RELAY_ENABLED=false`. Start `pnpm dev` and use the exact configured origin.

The setup above is unsigned local preparation. Use a separate database from the
future enabled deployment: custody cannot be inferred from legacy encrypted
preparations. Production requires HTTPS; see the hosting handoff for the shared
configuration and separate worker secret. Defaults remain paused. Public campaign/status reads have
their own authentication/rate limits and remain callable when preparation is
disabled. A missing database produces a safe service-unavailable response.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/campaigns/:slug` | Campaign slug | Public campaign status and name rule |
| `GET /api/session` | Session cookie | Assigned wallet, campaign, expiry and latest attempt ID |
| `POST /api/invites/exchange` | `{token}` | Session cookie, assigned wallet, campaign summary |
| `POST /api/quotes` | Session cookie, `{name,wallet}` | Quote ID, costs, expiry, expected result |
| `POST /api/attempts` | Session cookie, `{quoteId,idempotencyKey}` | Durable reservation and unsigned transaction |
| `GET /api/attempts/:id` | Session cookie | This invitation's attempt, including while campaign is paused |

Use a fresh 16–80 character alphanumeric/underscore/hyphen idempotency key for a
new reservation; retain it for retries. Phase 5's `/start` journey calls these
APIs and restores the latest attempt through the HttpOnly session. `/preview`
uses separate in-memory examples. `/start` enables real approval only from the
server runtime flag; `/preview` never connects to a real wallet or service.

Session reads remain available during a campaign pause or after consumption for
an unexpired, unrevoked capability. The latest historical attempt is returned
even after its active pointer clears. Reservation/status include a projected
cost breakdown without private quote fields. Expired sessions still require
invitation exchange; consumed/expired passes or paused campaigns cannot obtain a
new session under the current policy. Their organizer must inspect the attempt
through the CLI. A dedicated read-only recovery capability remains future work.

## Operator commands

Commands load `.env` and use the configured private `DATABASE_URL`, including
hosted PostgreSQL. Run them from the project root or its private operator/release
environment. They modify metadata/accounting and can authorize campaign access;
they never load a signer or broadcast transactions themselves. Create a JSON input
file with explicit dates, native amounts and your intended **public** sponsor
address. The following shape is a local template; choose actual reviewer campaign
caps before activation, and use an unfunded identity for local testing.

```json
{
  "slug": "local-proof",
  "name": "Local preparation proof",
  "startsAt": "2026-09-14T00:00:00Z",
  "endsAt": "2026-09-15T00:00:00Z",
  "maxUsers": 1,
  "capNative": "15000003384720",
  "sponsorPublicKey": "REPLACE_WITH_UNFUNDED_PUBLIC_ADDRESS",
  "limits": {
    "maxRegistrationPrice": "15000000000000",
    "maxTransactionFee": "15000",
    "recoveryAllowance": "15000",
    "maxReservation": "15000003384720"
  }
}
```

```sh
pnpm ops create --input ./local-campaign.json
pnpm ops activate --campaign CAMPAIGN_UUID
pnpm ops inspect --campaign CAMPAIGN_UUID
pnpm ops issue --campaign CAMPAIGN_UUID --wallet EXPECTED_PUBLIC_WALLET --expires ISO_UTC_DATE --out first-pass.json
pnpm ops invites --campaign CAMPAIGN_UUID
pnpm ops rotate --invite INVITE_UUID --expires ISO_UTC_DATE --out replacement-pass.json
pnpm ops pause --campaign CAMPAIGN_UUID
pnpm ops resume --campaign CAMPAIGN_UUID
pnpm ops revoke --invite INVITE_UUID
pnpm ops expire --attempt ATTEMPT_UUID
pnpm ops sweep
pnpm ops end --campaign CAMPAIGN_UUID
```

`issue` and `rotate` save the bearer token only in the chosen filename under
gitignored `artifacts/private/`, created exclusively with mode 0600. Output files
are never overwritten and the token is never printed. Console output includes
only the invitation ID/path. If issuance crashes after commit but before delivery,
find its ID with `invites` and rotate it. A file-write failure attempts revocation;
if database connectivity is lost too, inspect/revoke/rotate before distributing.
The invite list contains assigned wallet addresses: keep it in operator context.
Ending is permanent; pause/resume is the reversible control. Session, expired
quote and rate-row retention cleanup beyond secret erasure belongs to operational
hardening; bounded API rates do not replace database retention monitoring.

Verify with `DATABASE_TEST_URL=... pnpm test:campaigns`. Database suites run
serially because the migration runner intentionally rejects overlapping migration
processes. Tests isolate random schemas and do not reset development data.

Implementation references: [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS),
[exact numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html),
[Node authenticated encryption](https://nodejs.org/api/crypto.html).
