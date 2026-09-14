# Security model and local hardening

This is an implementation review of First Bite's local checkpoint, not an
independent audit or authorization to run a funded pilot. Production preparation
and all application relay paths remain disabled. The reviewed scope includes
capability APIs, browser policy, fixed transaction validation, reservation and
settlement boundaries, logs and encrypted attempt material. It does not include
a new audit of Cookie's upstream program, Nightly's extension or a hosting vendor.

## Browser and HTTP boundary

`src/proxy.ts` generates a fresh 24-byte random nonce for every non-asset request.
It replaces inbound `x-nonce` and `Content-Security-Policy` values before rendering
and returns the same policy in the response. `src/app/layout.tsx` waits for
`connection()` so Next can attach that nonce to its framework scripts and styles.
HTML must remain dynamically rendered and uncached. Do not add a CDN cache rule,
static export or partial prerendering to these routes without redesigning this
policy. Prefetch headers cannot bypass the proxy. APIs, health responses and
ordinary missing pages receive the policy too; only Next asset paths and the
favicon bypass nonce processing.

Production script sources require a nonce and use `strict-dynamic`. Inline event
handlers, plugins, embedded frames, web workers and base tags are blocked. Styles
use self and the request nonce; fonts and fetches use self. Images may use self,
data or blob URLs. There are no external analytics, script CDNs or browser RPC
allowlist entries. The Nightly adapter communicates with the injected provider;
network compatibility still requires an actual extension test. Do not add an
unrestricted `https:` source to accommodate an unverified extension failure.

Development additionally allows script eval, inline styles and WebSocket HMR.
These allowances are selected only by `NODE_ENV=development`. The production
build must be used for release verification. CSP does not force loopback HTTP to
HTTPS; the production ingress must provide HTTPS and HSTS and block direct origin
access. Existing `no-referrer`, `nosniff`, frame denial and camera/microphone/
geolocation denial apply globally. No CSP reporting endpoint collects page URLs
or invitation information in this checkpoint.

State-changing API requests require an exact configured Origin, allowed Fetch
Metadata site and JSON content type. Host or forwarded headers cannot select the
accepted origin. Bodies are limited to 4,096 actual streamed bytes and five
seconds, including absent or misleading Content-Length. Strict schemas reject
extra fields; returned errors use fixed text and fresh request IDs.

Invitation and session capabilities use 32 random bytes and distinct SHA-256
lookup domains. A session is an HttpOnly, SameSite=Strict cookie, Secure on HTTPS,
with no Domain attribute. Duplicate capability cookies are rejected. Database
checks bind a session to its invitation and expected wallet. Public status views
project only permitted fields and use private/no-store responses. Neither
capabilities nor signed payloads enter browser storage or URL parameters.

API limits are stored in PostgreSQL. A global bucket is consumed before creating
IP or other attacker-influenced buckets; contextual limits additionally bind
sessions, wallets, invitations and attempts where applicable. `TRUSTED_IP_HEADER`
defaults to `none`, which intentionally shares one local bucket. A deployment may
trust a supported IP header only when its ingress overwrites it and direct access
to the app is blocked. Application limits do not replace ingress connection/body
limits or database retention monitoring.

## Transaction and storage boundary

First Bite does not accept arbitrary relay instructions. The validator compares
the complete legacy message against a fixed instruction sequence, program IDs,
canonical PDA addresses, signer privileges, account ordering and exact amounts.
Sponsor S, fresh attempt payer A and owner U must be distinct and on curve. The
wallet signs only its assigned slot; both other signature slots must be empty.
The returned message must remain byte-identical and carry a valid Ed25519 user
signature before the server may authorize it.

The chain adapter checks the reviewed genesis, executable/config/rent policy,
account owners and eligibility, original blockhash and exact message fee. These
checks reduce accidental chain/policy drift; they still rely on the configured
RPC and an upgradeable upstream registry. They cannot remove the race between
preflight and execution. Inconsistent final evidence retains a hold for review.

Campaign/invitation locks serialize authorization with pause and revocation.
Once authorization commits, the original operation can finish after a pause.
New authorization also requires fresh private operational evidence for the same
campaign: database/schema, worker freshness, accounting consistency, aggregate
sponsor holds, registry policy and matching enabled signer. A missing, failed or
stale check denies admission. Existing operation reconciliation does not depend
on that admission check, so health failures do not silently abandon held funds.
Signed bytes must be persisted before broadcasting; retry reuses those bytes.
Fenced job leases and unique ledger events protect overlap and settlement.
Native units use bigint and database numeric strings, never floating-point
currency arithmetic. Finalized receipts and matching owner/primary state are
required for successful accounting. Unknown history or signed expiry does not
free a reservation. See [execution.md](execution.md) for the exact invariants and
controlled failure proofs.

The database and its owners are trusted. Constraints and append-only triggers
protect ordinary application mutations; an owner can alter those protections.
Use separate migration and runtime privileges, a private database network and
encrypted backups. A restore must be reconciled with the chain before any future
signer is activated. Restoring an older ledger is not permission to repeat a spend.

## Secrets, logs and retention

Attempt payer keys use AES-256-GCM, fresh IVs and authenticated context containing
the preparation ID and payer address. User and fully signed payload envelopes use
separate purposes bound to the operation ID. The wrapping key is server-only;
this checkpoint has no runtime sponsor-key loader. An attacker who obtains both
the wrapping key and the database can recover retained attempt secrets. This
design is not a hardware vault or protection against a compromised app server.

| Material | Retention rule |
| --- | --- |
| Raw invitation | Written once to a mode-0600 private operator artifact; only its hash enters the database. Operators control artifact distribution/removal. |
| Session token | Cookie only; only its hash is stored. Expiry/revocation denies further access. Historical database rows require operational cleanup. |
| Quoted A key | Replaced/rotated quotes clear the envelope. The unsigned sweep clears expired quotes. Reservation moves the envelope into the attempt and clears the quote copy. |
| Prepared A key | An unsigned-expiry sweep releases the reservation and clears the envelope only while status is still prepared. |
| User-signed payload | Cleared when the fully signed payload commits, or when settlement completes. |
| Fully signed payload | Retained across uncertainty/retries; cleared after conclusive finalized settlement. |
| A key after registration | Cleared for completed/no-residual success or finalized registration failure. Retained while residual recovery or manual review requires it; cleared after completed recovery. |
| Audit/ledger | Append-only history. No blanket expiry cleanup may erase accounting evidence. |

These are database envelope deletion rules. JavaScript strings, third-party
crypto objects, heap copies, PostgreSQL WAL and existing backups may retain prior
material. Owned plaintext byte arrays are erased best-effort; locked memory and
physical secure erasure are not claimed. Retain wrapping keys needed for held
operations. A key rotation procedure with versioned envelopes, an external signer
and a production backup retention schedule are still activation work.

The application logger accepts only fixed event/failure codes, validated request
IDs and bounded numeric fields. API error boundaries do not log raw exceptions,
URLs, cookies, user-signed bytes or keys. Database idle errors are fixed events.
The privileged operator CLI returns public accounting/inspection data and the
private output path when issuing a pass; handle that terminal accordingly.
Ingress, platform and database logs are outside the application logger and must
be configured to omit request bodies, cookies, authorization headers and query
parameters. Crash dumps and APM request capture must be disabled before secrets
are introduced.

## Review outcome and open gates

The concrete Phase 6 browser hardening change is an enforced nonce policy with
dynamic rendering, caller-header replacement and cache prevention. Targeted tests
exercise production/development policy, forged nonce input, matcher bypasses and
the existing defensive headers. Build, deployed response and hydrated browser
evidence belongs in the Phase 6 evidence record; unit tests alone do not establish
extension or production-platform compatibility.

The local review found no additional demonstrated transaction-safety exploit in
the examined boundaries. It is not a complete proof of all concurrency schedules,
supply-chain integrity or external dependencies. No full independent audit,
continuous fuzzing campaign, hosted penetration test or funded security test is
claimed. Security and implementation quality are graded **B for the local
checkpoint**; readiness for live funds is **false**.

Before activation, finish the real Nightly signing/rejection/account-switch
test, funded registration and independent resolution, agree the sponsor cap and
distribution plan, validate ingress/header/backup/restore behavior on the chosen
host, and implement the narrowly scoped signer activation and emergency process.
Keep the existing runtime gates closed until those decisions and evidence exist.

Implementation follows the installed Next 16.3.5 CSP and proxy guides. Public
primary references: [Next CSP](https://nextjs.org/docs/app/guides/content-security-policy),
[Next proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy),
[Node authenticated encryption](https://nodejs.org/api/crypto.html), and
[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).
