# Private pilot observation template

Copy this blank template into an access-restricted, ignored location for each
actual session. Do not put completed participant notes in this documentation
directory. Use pseudonyms, not names, handles, contacts or wallet lists. The
[pilot protocol](pilot.md) defines acceptance and safe recovery. Empty means
unobserved; do not fill with sample successes.

## Session and consent

- Participant ID (`P001`-style):
- Session ID (`S001`-style) / prior-session reference if this is a retest:
- Actual newcomer / operator rehearsal / synthetic exercise:
- Observation consent recorded privately at:
- Permission to identify publicly, if separately requested: not assumed
- UTC start / end:
- Tested commit / environment:
- Browser / Nightly version / supported desktop platform:
- Prior Cookie/network/tool experience and relevant baseline conditions:
- Observer evidence reference (`E001`-style; no personal name required here):
- Live gate review and finite allocation approval references:
- Pre-session readiness / accounting report references:
- Zero-COOK starting-state evidence reference:

## Journey observations

List tasks actually performed in order. Preserve failed or abandoned steps.
State whether assistance was required and separate active time from waiting.

| Step / UTC time | Task and visible state | Assistance or confusion | Active / wait duration | Private evidence reference |
| --- | --- | --- | --- | --- |
| | | | | |

- Before approval, participant's explanation of what they receive:
- Participant's explanation of who pays and what they approve:
- Wallet prompt count / exact warnings, with secrets removed:
- Signature rejected or cancelled: unobserved / none observed / observed
- Rejection reason if volunteered; selected-name preservation; eventual outcome:
- Confusion: unobserved / none observed / observed; blocking step and paraphrase:
- Recovery: unobserved / not needed / attempted; spontaneous or staged:
- Recovery trigger, original attempt reference, states, actions and outcome:
- Session outcome: incomplete / rejected / failed / unresolved / completed
- Outcome reason and time (confirmed-only remains unresolved):

## Final identity and cost evidence

- Private attempt / transaction evidence reference:
- Finalized success and slot evidence reference:
- Reviewed name/recipient matched registry owner: unobserved / pass / fail
- User primary record matched same name: unobserved / pass / fail
- Independent consumer name / version or observation date:
- Independent consumer result: unobserved / unavailable / unsupported / mismatch / pass
- Same-name resolution evidence reference:
- Any consumer freshness or listing/escrow caveat:
- Post-session accounting and independent sponsor-debit evidence references:
- Actual registration debit, fees and recovery in exact native units (private):
- Residual/recovery disposition and any unresolved reservation:
- Accounting discrepancy: unobserved / none observed / present

Keep the transaction/name/wallet mapping in restricted supporting evidence. A
public summary can report counts without linking participants to wallets.

## Baseline comparison, if actually observed

- Route and existing tools used:
- Same starting/ending conditions as First Bite? State each difference:
- Source funding/account/network prerequisites and blockers:
- Separate funded baseline approval reference, if execution required funds:
- Prior exposure / coaching / operator assistance:
- Discrete user tasks performed in order:
- Manual task count / wallet prompt count:
- Active interaction time / waiting time:
- Reached finalized ownership, primary and independent resolution? Evidence:
- Limits on comparison (including unobserved route or unequal conditions):

Do not infer a complete baseline from documentation, screenshots or a guessed
click count. Do not report conversion uplift from this observation worksheet.

## Issues and retest

| Issue reference | Observed behavior / impact | Critical? | Action and fix commit | Retest session / evidence | Status |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

- Pause/reconciliation actions if a critical issue appeared:
- Original failure retained and retest linked to the same participant ID:
- No additional pass/spend beyond approved allocation:
- Private evidence access owner / retention review date:
- Eligible for aggregate reporting? Explain exclusions without deleting failures:

Transcribe only supported observations into a private copy of
[pilot-input.template.json](pilot-input.template.json). Follow the
[record format](pilot-record-format.md) for its narrower outcomes, fields and
evidence references; retain additional context in these private raw notes.
Do not guess unobserved behavior to fill a required field.

Run `pnpm pilot:report --input PATH --out filename.json`. The new mode-0600 report
is written under ignored `artifacts/private/`, not published. Exit `2` records
missing evidence, `1` indicates invalid input or a command failure, and `0` only
satisfies the entered-record checklist. Even then `phase7Complete` remains false.
Review the aggregate and raw evidence manually. Schema validity is not
independent proof that a wallet, chain transaction or observation occurred.
