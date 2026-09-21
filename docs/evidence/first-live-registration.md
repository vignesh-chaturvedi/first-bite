# First finalized sponsored registration

Date: 2026-09-21. The separate runner completed the user's approved registration
of **firstbitecheck0001.cook**. A fresh read-only chain verification confirms the
receipt, all three signatures, sponsor debit, zero-COOK newcomer, final owner and
primary record. An existing ecosystem app also resolves the name correctly.
This closes the one-registration proof; the full Phase 0 gate remains open.

## Approval and wallet evidence

The user approved this name, the reviewed sponsor/newcomer accounts and a total
ceiling of **15,001 COOK** before enabling the runner. Both wallet approvals were
performed manually in Nightly. No sponsor or newcomer private key was exported.
The user reports Nightly **1.51.24** for this successful run. A subsequently
supplied `brave://version` screenshot records **Brave 1.94.121**, Chromium
**152.0.7977.83**, official arm64 build, on macOS 26.2 (25C56). The screenshot
and a version metadata sidecar are preserved privately; the original transaction
report is unchanged. Exact successful popup/warning text remains unrecorded.

The user's metadata and completion screenshot were preserved in ignored private
storage. The report SHA-256 is
`1deaab01b4914e625012e7a6a3f40cba1e12a476eaac86b3126c2aa0ae03c10f`.
The signed transaction and attempt custody remain in the encrypted local journal;
neither is added to version control. Full public account addresses are retained
in the private report rather than repeated here as a participant list.

## Finalized chain verification

Read-only verification completed at `2026-09-21T04:54:15.735Z` against
`https://rpc.cookiescan.io`. The receipt block time is
`2026-09-21T04:40:46Z`, at slot **26,344,969**.

- Cookie genesis and the current program, config, fee receiver and rent policy
  still match `cookie-registry-2026-09-13-v1` (policy read slot 26,346,732).
- The 690-byte legacy transaction has exactly the three expected, distinct
  signers. Every signature verifies and the fixed instruction policy passes.
- Message SHA-256 matches the user's report:
  `c57f06e7673bd29701a5d3d2bcf180b226929c1f1e5406be0cba9128c5da7b5a`.
- History reports finalized success. Exact receipt balance changes agree with
  the original quote and the user's settlement report, within the approved cap.
- Fresh finalized account reads at slot **26,346,737** give the newcomer as both
  domain and primary-record owner, with `firstbitecheck0001` as the primary name.
- The newcomer starts and ends with zero native COOK. The temporary attempt
  payer starts and ends at zero, and its current balance remains zero.

| Actual amount | COOK |
| --- | ---: |
| Registration price | 15,000 |
| Domain rent | 0.00192792 |
| Primary rent | 0.0014268 |
| Transaction fee | 0.000015 |
| Total sponsor debit, including the fee | **15,000.00336972** |
| Sponsor balance after this transaction | 999.99563028 |
| Attempt-payer residual | 0 |

The 0.0001 COOK recovery allowance was a planning reserve, not an additional
charge. No sweep is needed for this attempt. All arithmetic uses exact native
units; 1 COOK is 1,000,000,000 units. No fiat valuation is inferred.

The full transaction signature is retained in the private report. These public
receipt facts were re-read, not inferred from the screenshot. Verification reused
the reviewed message/settlement validators; it is a separate chain read, not an
independent implementation of those validators.

## Independent ecosystem resolution

[Sprinkle](https://sprinkle-ten.vercel.app), discovered in the Cookie Chain
[submission catalogue](https://github.com/cookiechain/superteam-hackathon-submissions/blob/main/apps.json),
resolved `firstbitecheck0001.cook` in its rendered payment preview. Its owner
link targeted the exact newcomer address from the approved report
(`33tjyH…CNJhKW`). The source is [ys317/sprinkle](https://github.com/ys317/sprinkle).

This observation used Sprinkle's existing browser application, without connecting
a wallet or submitting a payment. It establishes forward name resolution. The
primary-name result comes from the separate finalized chain read above, not a
reverse lookup in Sprinkle. Both tools use Cookie's community RPC; this is
independent application evidence, not independent validator infrastructure.

## Checkpoint validation

Finalized RPC assertions, report-copy SHA-256, private-file permissions, exact
balance arithmetic, documentation links, HTML gate state and `git diff --check`
passed. The restarted viewer visibly shows `complete`, sending disabled, saved
wallet approvals and the verified settlement. No application code changed, so
the previously recorded runner test suite was not rerun for this evidence update.

## Preserved records and remaining scope

Private files under `artifacts/private/registration-smoke/`:

- `registration-metadata-passed-20260921.json`: unchanged user export.
- `finalized-verification-20260921.json`: fresh read-only receipt/account checks.
- `independent-resolution-20260921.json`: observed tool URL and resolved target.
- `registration-complete-user-screenshot.png`: original completion screenshot.

The existing journal was cleanly closed and reopened without `--allow-live`.
The localhost viewer reports `complete` and `allowLive: false`. No additional
transaction was sent during verification. Encrypted historical journal snapshots
still require their existing private-key protection; this is not a claim that
old secrets were erased from every snapshot.

Still needed: successful popup/warning text, and a chosen
finite pilot allocation, owner and distribution channel. Application signer
custody, relay/worker activation, deployment and an observed newcomer pilot are
separate milestones. This manual two-wallet runner does not establish the
deployed application's intended one-approval journey. No further registration
or funding is needed to prove this completed transaction.
