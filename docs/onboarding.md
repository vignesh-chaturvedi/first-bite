# Newcomer journey

Phase 5 provides six screens in one journey: invitation, wallet, name, review,
progress and result. The UI uses First Bite's existing paper/forest theme,
system fonts, responsive layouts and native accessible controls.

## Two entry points

- `/start` uses the real invitation, quote, reservation and status APIs. Local
  preparation must be configured as described in [campaigns](campaigns.md).
  Its approval button and the execution HTTP routes remain disabled.
- `/preview` uses explicitly labeled in-memory fixtures. It never calls fetch,
  RPC or the injected wallet. Use the example invitation, connect the example
  wallet and choose a name; `taken`, `cookie` and `admin` demonstrate an unavailable
  name. Example approval advances through submitted, confirmed and complete.
  Reloading restarts this walkthrough. It produces no real ownership evidence.

No sponsor secret, live signer, dependency or database migration was added in
this phase. The execution library remains independently injectable for local
proof. Runtime activation and real Nightly evidence remain prerequisites for
funded registration, as recorded in [progress](progress.md).

## Browser and capability boundary

The invitation is entered in a password field and cleared from React input state
on submission. It is sent only in an exact same-origin POST body. The server
returns an HttpOnly capability cookie. No invitation, capability, signed payload
or secret is stored in localStorage, sessionStorage, a URL, analytics or logs.
Clipboard actions are explicit and copy only public names/addresses.

`GET /api/session` returns the assigned wallet, session expiry, public campaign
summary and latest historical attempt ID. This restores progress after reload
without persisting even an attempt ID in browser storage. The API authenticates
the cookie before looking up its invitation. Status remains readable during a
pause or after consumption while that capability is valid; revoked capabilities
are rejected. This does not grant any new preparation or signing permission.

Sessions last at most 15 minutes. Re-entering an active, unexpired invitation can
renew access. Consumed/expired passes and paused campaigns cannot exchange for a
new capability under the current policy. If the session has expired in one of
those states, the organizer must inspect the saved attempt through the CLI.
A dedicated read-only recovery capability is not implemented in this checkpoint.
The worker's accounting/reconciliation does not depend on an open browser.

The API client uses fixed local paths, same-origin credentials, no-store,
no-referrer, rejected redirects, a 12-second deadline and a streamed 64 KiB
response limit. Runtime schemas validate native-unit strings and public response
shapes and strip undeclared fields. UI errors map fixed codes to helpful text;
raw server/wallet errors are never rendered.

## Wallet connection and signing

The small browser-only adapter follows Nightly's documented injected interface:
`window.nightly.solana`, `standard:connect`, a sign-transaction feature and
`changeNetwork({genesisHash,url})`. The reviewed Cookie genesis is required.
No standard Solana cluster string is invented for Cookie. Wallet Adapter packages
from the original plan were not added: the existing Phase 0 diagnostic's explicit
Nightly interface supports the required custom-network checks without a general
send adapter. This is an implementation choice, not proof of extension support.

Connection, network change and signing each require a user action; there is no
auto-connect or sign-and-send method. Missing/locked/unsupported wallets and wrong
wallet/network states have recovery guidance. Event subscriptions plus bounded
polling invalidate the current connection when the account, network or injected
provider changes. Wallet prompts have a 60-second bound and safe fixed errors.

Before an enabled injected sign call, the adapter parses a bounded canonical
legacy packet, checks the three distinct signer accounts, the assigned user and
empty signature slots, then verifies its message SHA-256. After the prompt, it
requires unchanged message bytes, a valid Ed25519 user signature and all other
signature slots still empty. WebCrypto and Uint8Array avoid Node signing code or
Buffer polyfills in the browser. The server remains authoritative for fixed
instruction/policy validation. The adapter never broadcasts anything.

Actual Nightly prompts, partial-signature behavior and supported desktop browsers
still require the [real wallet test](nightly-smoke-test.md). Mobile signing is
explicitly described as unverified in the interface.

## Name, coverage and recovery states

Names normalize to the registry's 4–32 ASCII letters, numbers and internal
hyphens. Availability/quote checks debounce by 650 ms. A generation counter
discards stale successes and errors after name, invitation, wallet, network or
offline changes. Availability never implies an on-chain reservation. Precise
registry failures map to unavailable-name or wallet-ineligible messages; other
chain errors remain generic.

The review shows the name, assigned owner, zero user cost and maximum sponsor
coverage. Optional details show registration, setup, transaction fee, recovery
allowance, Cookie network and registry. Amounts are exact decimal strings derived
without Number conversion. A prepared attempt's stored cost breakdown is returned
on fresh reservation, idempotent reservation and status reads.

Reservation uses a stable idempotency key. If its response is lost, the controller
restores the latest session attempt before permitting a new preparation. Initial
session restoration serializes with invitation exchange; stale quote responses
cannot replace another invitation's review. A lost submit response retains the
attempt and requests a status check. No signed payload enters controller state.

Progress polls every five seconds only while visible, online, not terminal and
without a displayed request error. Work is serialized and manual checks remain
available. Confirmed is separate from finalized; no optimistic ownership is
shown. Finalized/complete result rendering requires the server's saved signature
and verification slot, produced by Phase 4's finalized receipt/account checks.
Missing proof, manual-review states and unresolved submissions do not unlock a
replacement. Only conclusively failed or expired attempts offer a fresh name.
Quote expiry alone cannot release a durable signing reservation.

The result supports public name/address copying, a CookieScan transaction link
for real signatures, and the CookBook home page listed in the official ecosystem
registry. No custom CookBook deep link or auto-filled wallet operation is used.
The application does not claim that an independent consumer has resolved the
name. That remains a real-pilot evidence requirement.

## Verification

Run `pnpm test:onboarding` for the browser adapter, controller and API tests.
These use synthetic wallets and controlled responses. Run the complete suite
with the test PostgreSQL URL and reviewed ELF to also cover session restoration,
private projections and all earlier chain/accounting behavior.

Browser checks are recorded in [Phase 5 evidence](evidence/phase5-newcomer-journey.md).
The walkthrough is a design/interaction test, not a substitute for a funded
wallet journey. No new Playwright package was needed for the local browser check;
the connected browser tool drove the built/development application.

Primary integration sources checked 2026-09-14:
[Nightly transaction signing](https://docs.nightly.app/docs/solana/solana/sign_transaction/),
[Nightly network switching](https://docs.nightly.app/docs/solana/solana/change_network/),
[Cookie apps registry](https://github.com/cookiechain/apps/blob/main/apps.json).
