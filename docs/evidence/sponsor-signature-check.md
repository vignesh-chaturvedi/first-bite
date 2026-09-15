# Sponsor-backed signature diagnostic checkpoint

September 15, 2026. Added a loopback diagnostic at `/sponsor` to address the
Nightly 1.51.24 simulation requirement. No successful wallet signature had been
captured at this implementation checkpoint. A later
[user-supplied report passed](nightly-signature-pass.md) at
`2026-09-15T20:27:20.323Z`; the observations below retain their original scope.

## Implemented behavior

The user connects the empty newcomer U and supplies a distinct sponsor S public
address, name and exact decimal COOK limits. No secrets are accepted. The server
generates fresh attempt-payer A and immediately discards its secret. Neither S
nor A signs, and there is no funding or broadcast operation.

The same validated worksheet plan produces both the cost report and the fixed
transaction in memory. Registry/config/ELF/rent pins, name availability, fresh-A
conditions, S/U roles, U's zero balance and each supplied cap must pass. Blocked
checks return metadata and no transaction candidate. Successful planning leads
to a simulation of exactly those unsigned bytes, with `sigVerify: false`,
`replaceRecentBlockhash: false`, finalized commitment and a minimum context.
Simulation errors, stale contexts, expired blockhashes, invalid RPC data and
timeouts fail closed.

Only a passing simulation returns a short-lived user-first candidate. The page
checks network, account, inputs and lifetime before/after the wallet request.
The server consumes verification once and verifies only U's signature on the
same message, then checks genesis and block height at or after the simulation
context. Extra signatures and changed messages are rejected. Signature success
never declares registration, pilot or Phase 0 complete.

## Verification

- 137 browser-script, sponsor-engine and worksheet tests passed across four
  files. These cover exact decimal conversion, caps and zero-balance checks,
  timeout/stale/mutated RPC results, late wallet responses, account/input changes,
  expiry, failures/downloads and payload exclusion.
- 13 loopback HTTP tests passed across the original probe and new sponsor
  endpoints. They cover origin/session/input restrictions, shortfall without
  simulation, exact user signature, replay, extra signatures and lifetime/chain
  changes.
- 14 pinned-ELF local proof tests passed. Their funding/execution is confined to
  the VM; no real account or wallet is used.
- TypeScript, lint and whitespace checks passed. The new `test:wallet` command
  is included in the existing CI definition; hosted CI has not run.
- The restarted `/sponsor` page was inspected in the in-app browser. Initial
  state has empty sponsor/name fields and disabled preparation/signing without
  Nightly. The extension interaction paths are covered by synthetic browser
  tests, not claimed as a real wallet pass.

## Read-only checks with the supplied public accounts

The original worksheet at `2026-09-15T05:30:48.481Z` and the new HTTP endpoint at
`2026-09-15T09:39:06.883Z` both reported zero balances for S and U and a sole
funding-shortfall blocker. Exact private artifacts are in ignored
`artifacts/private/sponsor-readiness-20260915.json` and
`artifacts/private/sponsor-endpoint-readiness-20260915.json` with mode 0600.
The first RPC request was rejected by automatic approval review due to a usage
limit; an authorized retry after local checks succeeded. No result was inferred
from the rejected request.

For the inspected name `firstbitecheck0001.cook`:

| Component | COOK |
| --- | ---: |
| Registration | 15000 |
| Domain rent | 0.001927920 |
| Primary rent | 0.001426800 |
| Exact-message fee | 0.000015000 |
| Estimated execution cost | 15000.003369720 |
| Entered diagnostic recovery allowance | 0.000100000 |
| Total planning requirement / shortfall | 15000.003469720 |

The endpoint returned HTTP 200 with outcome `blocked`, simulation `not_run`,
`signatureRequestReady: false` and candidate `null`. Nothing was signed or sent.
This verifies the real unfunded stopping path, not the funded simulation path.
The amounts and name availability must be refreshed after funding or delay.

Next: separately arrange funding of the user's own S account, rerun the check,
inspect the wallet prompt only after successful simulation, and retain a valid
signature report or failure. Funding, registration, finalized owner/primary,
independent resolution, finite pilot allocation and runtime activation remain
separate pending gates. Do not fund any old randomly generated probe sponsor.
