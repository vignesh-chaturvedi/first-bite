# First Bite operator runbook

Phase 6 is a local operational checkpoint. This repository has no active signer,
funded campaign or hosted service. All `pnpm ops` mutations still require a
loopback development/test database. The user will supply the remote and arrange
the live Nightly proof. These commands are not a production activation procedure.

## Inspect before acting

Use a dedicated server terminal with `DATABASE_URL` set privately. Never paste a
key, invitation or signed transaction into a ticket, screenshot or command log.

```sh
pnpm ops inspect --campaign CAMPAIGN_UUID
pnpm ops accounting --campaign CAMPAIGN_UUID --out accounting-before.json
pnpm ops readiness --campaign CAMPAIGN_UUID
pnpm ops execution --attempt ATTEMPT_UUID
```

Accounting export creates an exclusive mode-0600 file under ignored
`artifacts/private/`. Existing names are not overwritten. It reconstructs held
funds and spending from append-only events, compares campaign and attempt
counters, checks operation settlement evidence and invitation pointers, and
lists pending authorizations and aged/manual-review/residual attempts. It omits
wallet/name participant lists, token hashes, messages and encrypted secrets.
The report uses one repeatable-read database snapshot. It is **persisted
accounting evidence**, not an independent live bank statement. Default output
is bounded to 1,000 records per collection; a larger report fails explicitly.
The programmatic interface allows up to 10,000; exports never silently truncate.

Exit codes: `0` means the command/report succeeded, `1` means invalid input or
execution failure, and `2` means an accounting discrepancy or readiness denial.
An unhealthy report is still written for investigation. Readiness intentionally
returns `signer_disabled` today. No diagnostic command loads a sponsor secret.

## Readiness and alerts

The operator probe checks migrated storage, internally consistent accounting,
campaign schedule/policy, unresolved manual reviews and a recent **execution**
worker heartbeat. A bare foundation heartbeat does not pass. The future execution
wiring must call `upsertExecutionHeartbeat` with its process UUID only from a
functioning execution loop; it must not disguise the shell worker as execution.
The read-only chain probe checks genesis, executable/program-data hash and
authority, config/receiver, rent policy and finalized sponsor balance. All RPC
account evidence comes from one context and unsafe numeric values are rejected.

The balance floor covers holds across every campaign sharing the sponsor,
including paused campaigns. Funds already sent may still be reserved during
finality; this intentionally conservative check can pause new admission until
reconciliation catches up. `canPrepare` also requires one free user slot and
the maximum reservation in both remaining cap and sponsor balance. Exhausting
new-pass capacity does not invalidate an already reserved pass.

New `ExecutionService.submit` authorization requires a fresh bounded admission
result for the same campaign, strict approval and no failures. Missing, stale,
throwing, malformed or timed-out evidence rejects without signing. This is a
temporary admission block, not a campaign status mutation or a cancellation.
The existing database locks still serialize pause/revocation with authorization;
exact-message preflight and its freshness are rechecked at that boundary.
Already-authorized jobs and status/retry reconciliation do not depend on readiness.
Diagnostics are uncached point-in-time observations, not a guarantee that an
external RPC or sponsor balance cannot change afterward.

| Signal | Operator action |
| --- | --- |
| Database/migration/accounting mismatch | Stop new admission; inspect export and deployed version; preserve all holds. |
| Worker missing or older than 30 seconds | Check process, database and job age; restart compatible worker without clearing jobs. |
| Wrong genesis/program/config/rent | Pause; independently investigate upgrade/state; do not edit the policy pin to silence the check. |
| Balance below aggregate holds | Pause issuance; reconcile pending transactions before changing the finite budget. |
| Pending attempt older than 15 minutes | Inspect signature/finality and job lease; age alone never proves failure. |
| Manual review or residual | Inspect the original and recovery signatures; no manual refund credit without final evidence. |

`/healthz` is minimal process liveness. `/readyz` is foundation readiness and
explicitly says `sponsorship: disabled`; it does not publish campaign budgets,
wallet inventory or detailed probe failures. Hosting health checks must not
restart the reconciler just because sponsorship is paused. External alerting,
on-call destination and hosted uptime monitoring remain configuration gates.

## Pause, revoke and resume

```sh
pnpm ops pause --campaign CAMPAIGN_UUID
pnpm ops accounting --campaign CAMPAIGN_UUID --out accounting-paused.json
pnpm ops revoke --invite INVITE_UUID
```

Pause and revoke acquire the same locks used for entry into signing. An attempt
whose signing authorization committed before either action can still sign and
broadcast. The export's `alreadyAuthorizedOperations` lists the pending operations
to watch. Leave reconciliation running. Do not delete jobs, erase secrets, lower
reservations or mark an uncertain attempt failed. Revocation denies capability
access but does not retract signed bytes already delivered to a network.

After resolving the cause and rechecking evidence, `pnpm ops resume --campaign
CAMPAIGN_UUID` restores the campaign metadata. It neither restores revoked
invitations nor bypasses runtime/admission gates. Expired access for paused or
consumed invitations still needs operator inspection; there is no recovery
backdoor in the browser.

## Issue, expire and recover

```sh
pnpm ops issue --campaign CAMPAIGN_UUID --wallet PUBLIC_KEY --expires ISO_UTC --out recipient-pass.json
pnpm ops rotate --invite INVITE_UUID --expires ISO_UTC --out replacement-pass.json
pnpm ops sweep
pnpm ops recheck --attempt ATTEMPT_UUID
pnpm ops recover --attempt ATTEMPT_UUID
```

Distribute each private pass through the chosen channel only after the user has
agreed the allocation. Rotation revokes prior sessions and requires an eligible
unused invitation. Sweep releases only conclusively expired unsigned attempts
and removes abandoned quote keys. Recheck schedules the existing operation;
recover reads finalized residual funds and prepares a bounded A→S recovery job.
Both require a future connected execution worker to progress. They do not sign
or broadcast in the current runtime. No command discards uncertain signed holds.

After recovery, compare the new export: transaction fees remain debits, and only
verified recovered funds reduce spending. A proposed refund is never spendable
budget. A new registration after a finalized failure requires a new quote, payer
and user approval. Retrying an existing attempt never refreshes its blockhash.

## Restart, release and restore

Run the local test/build matrix before committing. The release checklist is in
[deployment.md](deployment.md); the isolated recovery drill is in
[backup-restore.md](backup-restore.md). Deploy compatible web and worker versions
against immutable migration history. Use a single direct-session migrator before
switching database-dependent traffic. Do not apply migrations on worker startup.

Drain on SIGTERM. Durable leases tolerate overlap and expired workers cannot
replace persisted bytes or settle after a new lease. Restarting a process must
never reset attempt state. Rollback changes application binaries, not the ledger,
database schema or wrapping-key availability for in-flight operations.

A stale backup can omit signed transactions that are still valid or already
landed. Restore into an isolated environment with signer/broadcast disabled,
preserve the original database, compare signature history and independently
account for all sponsor debits since the backup before allowing new authorizations.
The local drill proves bytes and database guards survive; it does not solve the
missing-history problem or certify a production recovery point.

## Key incident

Pause new authorizations, stop new signing access, preserve the execution inventory
and isolate the affected key. Previously signed transactions may still land.
Retain the wrapping key needed to reconcile held attempts under restricted access.
Do not rotate it in place: current envelopes are not versioned for online rotation.
Never destroy the only recovery copy until every residual and uncertainty is
accounted for. Use a finite dedicated sponsor balance with treasury elsewhere.
No automated movement of real funds is authorized by this runbook.
