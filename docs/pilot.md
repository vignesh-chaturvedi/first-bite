# Phase 7 pilot protocol

**Local preparation only. No real newcomers have been observed, no live names
have been registered, and no pilot budget is approved.** The five-user result
below is an acceptance target, not a result. Keep the Phase 7 exit gate open.
The [development specification](development-spec.html#phase-7) defines the scope;
the [observation template](pilot-observation-template.md) supports each session.

## Close the prerequisites in order

1. **Observe the actual unfunded wallet first.** Run `pnpm phase0:wallet` in a
   desktop browser with the real Nightly extension, following the
   [wallet guide](nightly-smoke-test.md). Record browser/extension versions,
   Cookie genesis, exact warnings, prompt count, rejection behavior and unchanged
   message/signature verification. Use a zero-COOK disposable recipient. The
   diagnostic cannot broadcast and does not establish live registration.
2. **Prepare and review one bounded funded smoke test.** Before sending, choose
   the test name, distinct S/A/U accounts and exact maximum native-unit spend.
   Freshly read registry price, rent, fees and recovery allowance; the research
   snapshot is not a current quote. Use the separately reviewed fixed-message
   runner required by the wallet guide. Record finalized signature, owner,
   primary record, zero-COOK recipient starting state, actual sponsor debit and
   residual/recovery disposition. Resolve an unknown send before another attempt.
3. **Confirm a real independent consumer.** Verify the smoke-test name in an
   existing tool before inviting participants. A working home-page link is not
   resolution evidence. Record the tool, observation time and result, including
   its listed/escrowed-name behavior described below.
4. **Review activation and allocation.** Choose the campaign owner, private
   invitation distributor, number of passes, initial batch, expiry, exact finite
   campaign cap, per-attempt maximum, charged-failure/recovery reserve, and
   hosting/operating limits. None has been selected here. Keep a separate capped
   reserve for later reviewer access; do not infer it from unused pilot passes.
5. **Finish the actual runtime and hosted checks.** The current worker is a
   foundation heartbeat and the real browser approval is disabled. Reviewed
   signer custody, execution-worker wiring, guarded browser/API activation,
   compatible release, HTTPS/private database, fresh execution heartbeat,
   backup/restore evidence and an operator alert destination are prerequisites.
   Flags alone cannot supply this missing implementation or evidence. Follow
   [deployment](deployment.md), [security](security.md) and [runbook](runbook.md).

The operator records the approver, time and private evidence reference for each
prerequisite. Approval must concern the concrete funded test/allocation and
hosting plan. A checklist or report does not authorize spending or deployment.

## Observe the pilot

Use at least five distinct actual newcomers with eligible wallet-bound passes.
Issue only the agreed first batch and inspect its results before releasing more.
Do not expand the pass count or spend cap because a session fails. Scheduling,
contacting participants and distributing invitations require the user's chosen
channel and authorization; this protocol does not send invitations.

Before each session, record the tested commit and environment, obtain observation
consent, assign a pseudonym such as `P001`, and confirm the intended recipient has
zero COOK. Record a reference to that evidence privately. Capture a pre-session
accounting report and readiness result. An operator assists with safety and
recovery, but records every instructional intervention as assistance.

Ask the newcomer to use the real journey from invitation entry through an
independent name check. Before approval, ask them to explain what they receive,
who pays and what they approve. Record what they understood and any confusion
without coaching an answer. Do not prompt an approval if the displayed wallet,
name, network, amount or action is unexpected.

For every session, record all four outcomes explicitly:

| Outcome | What counts |
| --- | --- |
| Completion | Finalized transaction, expected U ownership and matching U primary record, plus independent resolution of the same name. Confirmed alone is provisional. |
| Signing rejection | Any actual rejection or cancelled prompt, reason if voluntarily given, whether the chosen name survives and whether a later approval needed a fresh quote. Zero observed rejections is different from untested behavior. |
| Confusion | Screen/step, short paraphrase, whether it blocked progress, and assistance needed. Do not record unrelated wallet history or personal disclosures. |
| Recovery | Trigger, original attempt reference, visible states, action taken and proven outcome. A reload/recheck must resume the original unresolved attempt; it must not produce an unapproved replacement. |

Record unsuccessful and incomplete sessions in the denominator. Retests keep the
same participant ID and link to the prior session; they are not new people.
Separate deliberately staged rejection/reload checks from spontaneous behavior.
Do not force production failures or spend extra funds to fill a test matrix.

## Verify identity and account for spending

After finalized success, read the registry owner and user's primary record and
record their agreement with the reviewed name/recipient. Then use a genuinely
independent ecosystem tool to resolve the same name. CookBook's official listing
is the current [handoff basis](onboarding.md#name-coverage-and-recovery-states), but its
actual resolution behavior remains unverified. Record an unavailable, stale,
unsupported or mismatched result as a blocker, not a pass.

Separately inspect an existing publicly observable listed/escrowed name using
read-only registry and consumer views. Record what the consumer shows for owner,
listing/escrow state and any recipient interpretation. An escrow account must
not be presented as an ordinary owner's payment recipient. Do not create a
listing, send a payment or alter someone else's record for this check. If no
suitable observation or supported behavior is available, leave this requirement
open. No First Bite payment-recipient feature is added by this pilot.

Compare private accounting exports before/after the batch with independently
observed finalized sponsor debits and verified recoveries. Every charged failure
remains an expense; every residual has a disposition. Keep unresolved signed
attempts and recovery funds held. A database report alone is not a chain balance
statement. Retain the evidence references and discrepancies for operator review.

## Compare manual setup fairly

Measure the existing bridge-to-registration path and First Bite against the same
start and finish: a supported desktop browser, an existing wallet with zero COOK,
and a finalized owned primary `.cook` name that an independent tool resolves.
Record browser/wallet/tool versions, prior network configuration, name
eligibility, operator help and observation date. If the baseline needs a source
asset, account, bridge, swap or faucet that the participant lacks, record that
precondition and blocker. Do not silently grant it to one route.

Count one manual step for a discrete user task (enter invitation, connect wallet,
select network, bridge funds, choose name, review or approve), not each click or
automatic chain event. List the tasks observed in order and count wallet prompts
separately. Record active interaction time and chain/waiting time separately.
Use the same counting rule for both paths and disclose differences in starting
conditions, assistance, sample sizes and prior exposure. Do not fund or execute a
baseline transaction without its own concrete approval.

Report observed counts and limitations. An unobserved baseline stays unobserved;
there is no invented conversion uplift, time saving or successful-user count.

## Stop, fix and retest

Stop new admission for unexpected signing, wrong network/owner/primary,
duplicated spending, unresolved accounting, unsafe recipient interpretation or
other critical reliability failures. Follow the runbook pause boundary: already
authorized attempts may still broadcast, so reconciliation must continue.
Never release holds solely because time elapsed. Record the issue, affected
sessions, fix commit and retest evidence. Resume only after its cause is resolved
and the existing allocation/readiness conditions still hold.

Limit changes to completion, clarity, accessibility and reliability. Keep prior
failed observations; append the retest. Five participants are five distinct
people, not five retries or five walkthrough runs.

## Prepare the eventual 60–90 second live demo

Use the tested release and a separately agreed eligible demonstration pass after
the live gates pass. Obtain permission before identifying any participant. The
demonstration allocation is part of the finite approved cap, not an extra grant.

| Approximate cut | Actual footage |
| --- | --- |
| 0–10 seconds | Zero-COOK recipient and invitation entry, with the invitation token concealed. |
| 10–25 seconds | Connect Nightly, verify Cookie and choose an eligible available name. |
| 25–40 seconds | Review sponsor coverage, recipient and the actual Nightly approval prompt. |
| 40–65 seconds | Honest submitted/confirmed/finalized progression and final registry owner/primary proof. |
| 65–90 seconds | Resolve the same name in an independent consumer; state the observed pilot counts. |

Label every waiting-time cut or time jump. If finalization does not fit, shorten
other footage or label the edit; never replace it with `/preview` success. Retain
the original recording and transaction reference privately. Review the final
video for exposed tokens, signed payloads, keys and unnecessary participant
identifiers before publishing.

## Evidence and phase decision

Keep raw notes, identifying mappings and supporting files out of Git under
`artifacts/private/` or another access-restricted location. Use participant IDs
in observation notes; keep contact details and wallet mappings separately only
if needed for authorized distribution. No tracking pixels or public participant
wallet list is needed. Set an operator-owned retention period before collection;
remove unnecessary personal notes after reviewing the aggregate results.

Start with [pilot-input.template.json](pilot-input.template.json), which contains
zero observations and null prerequisite references. Copy it to the private
working location; leave this repository template blank. Assign `P001`-style
participant IDs, `S001`-style session IDs and `E001`-style evidence references.
The [record format](pilot-record-format.md) describes the exact JSON contract and
the distinction between raw notes and supported reporter fields.

```sh
pnpm pilot:report --input artifacts/private/pilot-input.json --out pilot-report.json
```

The offline command validates entered observations and writes an exclusive
mode-0600 aggregate file under `artifacts/private/`. It refuses to overwrite an
existing report. Even an aggregate remains private pending review; this command
does not publish it. Exit `2` means a valid record still lacks required recorded
evidence (the expected result for the blank template); exit `1` means invalid
input or command failure. Exit `0` means only that the record checklist is
satisfied. The report still says `phase7Complete: false` and records its
unverified provenance.

The command does not query the chain, verify the observer's claims, contact
people, activate the runtime or mark a phase complete. Keep synthetic exercises
explicitly separate from real observations. Review the report and supporting
evidence manually before updating progress.

The Phase 7 gate remains open until five actual newcomers complete, or recorded
blockers are fixed and retested; every issued name has registry and independent
resolution evidence; sponsor accounting reconciles; critical issues are closed;
and the actual product demo and final screenshots exist. Preparing these files
fulfills none of those live observations by itself.
