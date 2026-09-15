# Read-only smoke-test spend worksheet

Prepare a concrete cost review for **one prospective registration** before a
separately approved funded smoke test. No worksheet has been run for real sponsor
and recipient accounts yet. A generated worksheet is a point-in-time planning
record, not a wallet quote, reservation, spend authorization or completed test.
The [real Nightly diagnostic](nightly-smoke-test.md) remains a separate gate.

## Choose the inputs

Record the intended name, sponsor's public address S and recipient's public
address U. S and U must be distinct. Supply public addresses only; the command
does not accept signing keys. Keep actual account mappings and output private.

Choose all four limits explicitly, in exact native-unit decimal strings:

| Flag | Planning limit |
| --- | --- |
| `--max-price` | Maximum variable registration price for this name. |
| `--max-fee` | Maximum registration-message network fee, including the possibility that a failed transaction charges a fee. |
| `--recovery` | Separately entered allowance for the constrained recovery operation. |
| `--max-total` | Maximum total exposure for this one registration, its setup/rent, registration-message fee and recovery allowance. |

Each amount must be a positive integer no greater than `18446744073709551615`
(u64 maximum), without decimals, signs or exponent notation. These limits have
no default approved value. The recovery allowance is operator-entered; it is
not a quoted recovery fee or a guarantee that recovery can finish within it.
A second registration attempt or further recovery spending requires its own
review within an explicitly approved allocation.

## Produce and inspect the worksheet

From the project root, replace every uppercase placeholder before running:

```sh
pnpm phase0:worksheet --name NAME --sponsor PUBLIC_S --user PUBLIC_U \
  --max-price NATIVE_PRICE --max-fee NATIVE_FEE --recovery NATIVE_RECOVERY \
  --max-total NATIVE_TOTAL --out smoke-worksheet.json
```

The command reads the pinned finalized registry/configuration, account rents,
name availability and wallet state, then obtains the exact candidate-message
fee. Review its observations, cost breakdown, U's exact starting balance,
sponsor funding shortfall and every blocker. Do not reuse the old research price
as a fresh quote, increase a limit simply to clear a blocker, or treat name
availability as an on-chain reservation.

U's balance and the sponsor balance come from the same finalized account context
as the registry evidence. The report lists that slot and the later blockhash
context. It does not check other campaigns' holds or reserve the sponsor's funds.
Only `COOKIE_RPC_URL` may be read from the process environment; `.env` and signing
configuration are not loaded by this command.

The generated attempt-payer A is diagnostic only. Its secret is discarded and
no signable payload is exported. The command cannot fund, sign or broadcast.
Its private output is created exclusively with mode `0600` under ignored
`artifacts/private/`; choose a new `.json` basename for each run. Existing output
is not overwritten. Review the file privately before attaching any redacted
evidence to project documentation.

| Exit | Meaning |
| --- | --- |
| `0` | Planning checks satisfied; spending remains unauthorized and live gates remain open. |
| `2` | Worksheet produced with blockers such as price, fee or total limit, sponsor funding shortfall, or a recipient whose balance is not zero. |
| `1` | Invalid input, failed RPC observation or file failure; no usable worksheet should be assumed. |

## Review before any later funded execution

Record the actual approver, exact one-test spend maximum, intended name and
distinct S/A/U identities with the funded test's evidence. Passing this command
does not establish actual Nightly compatibility, signer custody, pilot budget,
distribution, runtime activation, finality or independent name resolution.
Do not fund accounts merely because a worksheet reports a shortfall.

The separately reviewed runner must allocate and durably retain its own fresh A,
refresh current registry policy, availability, rents and fee for that actual
message, and obtain the user's approval of the exact fresh quote before any
send. It cannot reuse the worksheet's discarded A or diagnostic digest as an
execution authorization. Preserve the project's exact-signature, bounded-payer,
persist-before-send and finalized reconciliation requirements. After a timeout,
reconcile the same signature before considering another attempt.

Continue with the funded-test evidence table in the
[wallet guide](nightly-smoke-test.md#separate-funded-live-test--not-implemented-by-this-diagnostic)
only after the concrete test is approved. Keep all unobserved results open.
