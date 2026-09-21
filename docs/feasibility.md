# Phase 0 feasibility evidence

**Decision: the composition now passes both local proof and one real sponsored
registration. The full Phase 0 gate remains open.** The original local evidence
below is supplemented by the [Nightly diagnostic](evidence/nightly-signature-pass.md)
and [finalized live registration](evidence/first-live-registration.md). On September
21, receipt/signatures, exact debit, zero-COOK newcomer, ownership, primary name
and independent forward resolution were verified. No campaign or deployment has
been activated.

## Chain and interface observations

The [reviewed RPC snapshot](evidence/chain-snapshot.json) records finalized reads
on 2026-09-13 at 11:15:30 UTC from `https://rpc.cookiescan.io`.
Program/config and program-data/rent reads used adjacent slots 24,873,259 and
24,873,260; this is not a single atomic snapshot of the entire network.

| Identity | Recorded value |
| --- | --- |
| Genesis | `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2` |
| Registry | `H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA` |
| Config | `4s4DK5eMahyNXe8UarT3q3WPC95Q2wqRfEP19JWXmMGg` |
| Program data | `8RkUR6ksTVomXiyH8pNpoq7X35a5gQJjZnCX4sESHuoM` |
| Deployed ELF SHA-256 | `c61dadce0ddbe48f2c74d973deefe8e1af79aacfbb12b8edd891162a18ead254` |
| ELF allocation | 322,280 bytes, downloaded from the upgradeable program-data account |
| Interface revision | `cookie-mcp` commit `c4cabe0cf51e99e131b7b0df6eea57c241073b72` |
| RPC version | Solana core 4.1.2; feature-set identifier 3345198602 |

The program has an upgrade authority. The inspection command checks the recorded
ELF hash on subsequent runs. A hash mismatch requires a reviewed new baseline;
do not call it the same proof. The pinned IDL is not a verified source build of
the executable. See [upstream provenance](../vendor/cookie-domains/README.md).

The [bounty listing](https://superteam.fun/earn/listing/create-an-app-on-cookie-chain-app)
was re-opened during this phase. Its text still showed the Cookie app bounty;
the browser-rendered remaining-time field was unavailable in the text response.
The deadline in the development spec remains the prior research observation and
must be checked in the actual listing before submission.

## What was executed locally

The local VM loads the real downloaded ELF, the recorded registry config and fee
receiver, and rent settings from the recorded chain sysvar. Synthetic S, A and U
keys are created in memory. Only the local VM sponsor receives fixture funds.

The message contains a 200,000-unit compute limit followed by these five actions:

1. S funds A with the exact quoted registration price and domain-account rent.
2. A registers the name and becomes its initial owner.
3. A transfers that name to U using the ordinary transfer instruction.
4. S funds U with the primary-account rent.
5. U sets the new name as primary.

All three signers are distinct. The fee receiver cannot alias a signer or
protected account. S and U are absent from the registration instruction's account
list, and A begins with zero funds and no primary record. `set_primary_domain`
has exactly its eight discriminator bytes, without a name argument.

For a 32-character label, the complete legacy transaction is **704 bytes**,
including its three signature slots and compute-limit instruction; the packet
limit is 1,232 bytes. Tests also cover the shortest eligible four-character label.

| Scenario | Local result | Accounting and state |
| --- | --- | --- |
| Unchanged price; U starts with zero COOK | Passed | Domain owner U, matching primary, U/A end with zero, exact sponsor debit |
| Price increases after preparation; U already has 5 COOK | Fails safely | U keeps all 5 COOK; A stays zero; no domain/primary created; sponsor loses only the 0.000015 COOK fee |
| Price decreases by one configured cent | Passed | Correct final owner/primary; 100 COOK remains in A and must be accounted for separately |
| Non-divisible reference price | Passed | Actual executable agrees with integer floor division; A has no remainder |
| Name already taken | Fails atomically | Existing ownership preserved; no funding remains with new A/U; sponsor fee retained |
| Invalid name or wrong transfer/primary owner | Rejected | Registration and transfers roll back |
| Forged user signature | Rejected | No registration |
| Existing valid cleared primary | Passed | Existing record reused without transferring extra primary rent |

The [saved local proof](evidence/local-proof.json) contains execution logs, exact
amounts and owner/primary checks. Its public keys and signatures are local test
artifacts, not Cookie transactions or participant identities. Compute usage varies
with generated PDA derivation paths; all tested scenarios fit the configured
200,000-unit limit. These logs are evidence of tests, not an audit.

## Cost worksheet

These are **historical native-unit observations**, not dollar conversions or a
funding authorization. Re-read all values before a live transaction.

| Term | Base units | COOK |
| --- | ---: | ---: |
| Long-tier registration, 4–32 characters | 15,000,000,000,000 | 15,000 |
| Domain rent, 149 bytes | 1,927,920 | 0.001927920 |
| Primary rent, 77 bytes | 1,426,800 | 0.001426800 |
| Exact three-signature message fee | 15,000 | 0.000015000 |
| Successful registration debit | 15,000,003,369,720 | 15,000.003369720 |
| Proposed separate recovery-fee allowance Q | 15,000 | 0.000015000 |
| Planning reservation per pass | 15,000,003,384,720 | 15,000.003384720 |
| Ten-pass planning estimate | 150,000,033,847,200 | 150,000.033847200 |

Q is a proposed allowance, not a quoted recovery transaction or approved budget.
Charged failures, additional recovery attempts, reviewer capacity and hosting
need separate budget decisions. A lower-price residual is still campaign spend
until a finalized, verified recovery returns it. Recovery implementation belongs
to Phase 4; this checkpoint does not sweep funds.

## Verification and limits

Verification completed: `pnpm typecheck`, **57 passing tests** across four files,
`pnpm phase0:proof`, and `pnpm peers check` with no peer issues. The tests cover
IDL encodings, corrupt account rejection, exact amount bounds, actor aliases,
changed-message signatures, deployed-program execution and loopback diagnostic
request/signature handling. Dependencies install with lifecycle scripts disabled.
The diagnostic's default layout and missing-extension message were also checked
in the in-app browser, with no browser console errors. This browser had no Nightly
provider, so its rendered state does not count as an extension compatibility test.

The proof uses LiteSVM 1.4.1 and its default runtime feature activation and fee
behavior. It copies Cookie's rent parameters and checks rent/fee results against
the recorded RPC quote, but does not reproduce Cookie's entire runtime, feature
history or validator consensus. Clock time is derived from the observation time.
The executable hash identifies the tested bytes; it does not prove upgrade safety.

At the original local checkpoint, no network broadcast, finality, timeout/retry
reconciliation or actual Nightly behavior was exercised. Synthetic signatures prove the diagnostic
implementation, not the extension. At this Phase 0 checkpoint, later application
dependencies were not yet pinned. Phase 1 subsequently pinned the Next.js stack,
and Phase 5 implemented a custom Nightly adapter; see `package.json` and
[onboarding](onboarding.md). Their local tests do not establish actual extension
compatibility. The later standalone Nightly pass is recorded separately above;
it does not verify the application's adapter or live execution.

The cached ELF is excluded from Git. Reproduce using the read-only inspection
while that executable remains deployed, or retain a trusted archive with the
recorded hash. Tests fail with an actionable error if the binary is absent or
different; they do not substitute a mock registry or silently skip the proof.

## Remaining Phase 0 gates

- Exact successful popup/warning text and browser version. Nightly 1.51.24 is
  user-reported for the successful registration.
- Named campaign owner, finite pilot allocation and invitation distribution path.

The approved 15,001 COOK test cap, funded registration, finalized owner/primary
readback and independent resolution are now evidenced. Do not repeat the paid
test. Keep Phase 0 open in [progress](progress.md) and the HTML until the remaining
gates have evidence; the completed runner is available in read-only mode.
