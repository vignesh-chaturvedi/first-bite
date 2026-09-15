# Live smoke-test worksheet preparation

Verified 2026-09-15. This is another local preparation checkpoint within the
outstanding feasibility/pilot gates. No actual Nightly result, real-account
worksheet, funded registration or live pilot result has been recorded.

## Changes

`pnpm phase0:worksheet` accepts the intended name, public sponsor and recipient,
and explicit maximum registration price, registration fee, recovery allowance
and total spend. It uses the existing read-only client and fixed-message builder
to produce a private cost review before a separately approved funded test.

The chain client now returns U's exact balance from its existing finalized
account snapshot, alongside the sponsor balance and registry evidence. It makes
no additional account RPC request. Existing program/config/rent pins, name and
wallet eligibility checks, and the funded quote's balance requirement remain
intact. Synthetic observation fixtures were updated for the required field.

The worksheet validates/copies input and observations before asynchronous fee
reads, preserves exact integer amounts and reports each exceeded limit, funding
shortfall or nonzero recipient balance. Unknown chain/policy failures stop the
command with fixed error text. It retains no diagnostic payer key, exports no
signable payload and writes exclusively through the existing private-file writer.

Every report keeps `spendAuthorized`, `signingEnabled`, `broadcastEnabled` and
`phase0GateComplete` false, with `refreshRequired` true. The actual funded runner
must use a durably retained fresh A and refresh the concrete quote. Recovery fee
adequacy, other campaign holds and concurrent sponsor activity are not assessed
by this worksheet; its output cannot authorize a funding transfer or registration.

## Verification

| Check | Result |
| --- | --- |
| New worksheet tests | 58 passed, no skips |
| Related regression tests | 243 passed across 10 files, no skips |
| TypeScript | `pnpm typecheck` passed |
| ESLint | `pnpm lint` passed, zero warnings |
| Command/file boundary | Injected read-only client produced a private mode-0600 worksheet; existing filenames and traversal rejected; invalid real CLI invocation returned exit 1 with fixed error text |
| Wallet diagnostic availability | Existing signing-only server responded HTTP 200 at `http://127.0.0.1:8787/` |

The regression run covered registry encoding, transaction construction, chain
client, transaction policy, quote, quote mutation, cached-ELF quote proof,
execution-chain verification, settlement and private exports. The new client
tests check absent/zero/nonzero user balances, safe integer boundaries and
mutation during the later blockhash read. Worksheet tests also verify that the
funded quote still rejects insufficient sponsor balance.

All worksheet observations used for verification were synthetic and temporary
files were removed by test cleanup. No real S/U addresses or spend limits were
invented for an RPC run. No database/schema/dependency or application activation
change was made. Database suites, production build and browser UI checks were
not rerun for this read-only client field and operator-command addition; their
earlier Phase 6 evidence remains historical. CI includes the new worksheet test.

The diagnostic page being reachable is only an availability check. Open it in
the desktop browser containing Nightly and follow the
[manual guide](../nightly-smoke-test.md) to collect actual extension evidence.
Next, use the [worksheet guide](../smoke-worksheet.md) once the intended public
accounts and explicit limits are chosen. All original live gates remain open.
