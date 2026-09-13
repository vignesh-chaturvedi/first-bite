# Phase 2 local verification

Verified 2026-09-14 in Asia/Kolkata. This is a local engine checkpoint. Real Nightly
compatibility, funded registration, the pilot budget/distributor and hosted CI
remain open. No wallet-facing quote route or sponsorship service is enabled.

## Automated evidence

Node 24.6.0, pnpm 11.20.0 and the unchanged Phase 1 dependency lockfile were used.
`pnpm lint`, `pnpm typecheck`, `pnpm build` and all **200 tests in 13 files** passed,
with zero skips. PostgreSQL integration used `postgres:17.11-alpine` in a disposable
512 MiB memory-backed container; persistent Docker data was not modified.

New tests cover reviewed policy pins, finalized contexts/rollback, numeric
precision, invalid/taken names, fresh-attempt accounts, cleared/existing primary
records, request deadlines and redacted RPC failures. Quote tests cover exact
costs/caps, separate recovery reservation, balance checks, expiry boundaries,
stable hashes/bytes and mutations of caller-owned keys and adapter objects.

The independent message parser was tested against golden instruction/account
encodings, all single-byte mutations and all truncations of both supported primary
funding branches. Extra instructions, privilege changes, different fee recipients,
altered amounts and malformed vector lengths are rejected.

Three new execution cases pass against the actual pinned registry ELF in LiteSVM:

- A quoted registration with a zero-COOK user ends with the expected domain owner
  and primary record, exact domain/primary rent and exact sponsor execution debit.
- The same quoted flow with 5 COOK already in the user's wallet preserves those
  unrelated funds. The wallet signature and message bytes remain intact after
  the other two local signatures are added.
- Raising the registry price after preparation fails atomically: no domain or
  primary is created, user/receiver balances remain unchanged, A has zero balance,
  and the sponsor loses only the quoted transaction fee.

The VM is local, uses synthetic signers/funds and does not establish network
finality, Nightly signing prompts or live confirmation behavior.

## Public read-only observation

The new client was exercised at **2026-09-14 02:19:21 IST**
(`2026-09-13T20:49:21.865Z`). The full result is preserved in
[phase2-observation.json](phase2-observation.json).

Account context was slot `24948174`; the later blockhash context was `24948176`.
Genesis, executable, config, recipient and rent all matched the reviewed policy.
The randomly generated diagnostic name was available at that observation.

| Component | Exact native base units |
| --- | ---: |
| Registration | 15000000000000 |
| Domain rent | 1927920 |
| Primary rent | 1426800 |
| Exact message fee | 15000 |
| Estimated execution debit | 15000003369720 |

The sampled transaction was 698 bytes including its three empty signature slots.
The diagnostic sponsor was unfunded; this result is not an authorized or usable
sponsor quote. No recovery budget or live spend was approved. The inspection made
only read-only RPC calls and never signed or broadcast a transaction.

## Boundaries still to implement

The quote caller supplies the public identity of a fresh server-owned attempt.
Chain absence is checked now; durable uniqueness, encrypted secret storage and
campaign reservations arrive with the later invitation/signing phases. A quote
does not reserve a name or funds. Signing must revalidate policy/account state,
simulate, check invitation/budget locks and persist signed bytes before sending.

These additions are backend modules, so no frontend behavior changed. Phase 1's
browser evidence remains applicable to the preview. The full production build
was rerun; hosted Actions requires the user's remote repository.
