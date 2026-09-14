# Durable execution and recovery

Phase 4 implements the signing engine, execution repository, RPC adapter,
submit/retry HTTP boundaries and a sequential worker. They are exercised with
ephemeral signers, a real local PostgreSQL database and the reviewed registry
executable in LiteSVM. Application signing remains **disabled** while the real
Nightly, funded-registration and pilot-budget gates are open.

`src/server/execution.ts` deliberately does not load a sponsor key or connect a
live execution service. Both new mutation routes return `EXECUTION_DISABLED`.
`RELAY_ENABLED=true` is still rejected. The RPC adapter also defaults broadcasting
off. `PREPARATION_ENABLED` enables only Phase 3's local unsigned preparation.
The ordinary `pnpm worker` remains the heartbeat entry point. The execution worker
is an injectable module, not an enabled process with access to real funds.

## One authorization, one stored transaction

The submit service first authenticates the capability, compares the exact stored
message and verifies the assigned wallet's signature. Sponsor and attempt-payer
signature slots must still be empty. It checks the reviewed quote, program/config
identity, original blockhash lifetime, current accounts, sponsor balance and exact
message fee. Simulation uses the original message with signature verification
disabled because the two server signatures are not present yet. It never asks
RPC to replace a blockhash.

Authorization takes the same campaign/invite locks as pause and revocation. It
rechecks the active campaign, invitation and session, wallet, policy, remaining
reservation, unsigned expiry and recent preflight evidence. It then commits all
three together: `prepared → signing`, encrypted user-signed bytes and a work item.
HTTP returns progress; it does not hold a database lock during RPC or broadcast.
Concurrent or repeated submissions resolve to the same registration operation.

A worker leases the job, reloads the authorized message, repeats preflight and
co-signs that exact message using S and the decrypted A. Fully signed bytes use
a separate authenticated envelope, bound to the operation ID and payload purpose.
The worker commits that envelope, transaction signature and `signed` state before
any send. The send path reloads the committed envelope under a current lease.
An unacknowledged persistence result sends nothing; a later worker discovers
whether it committed and continues with the original bytes.

A pause/revocation blocks new authorization. An operation whose signing transition
already committed can finish after either action. Policy/expiry failures encountered
while resuming it keep the hold for review. The original quote timer never releases
a signing or signed hold. A wall-clock timeout cannot prove a signed transaction
did not land.

## Leases, retries and finality

Jobs use `FOR UPDATE SKIP LOCKED`, 45-second leases and random lease-owner IDs.
Database mutations check the current lease before changing operation state or
settling amounts. Expired owners cannot persist a replacement or settle after
another worker takes over. A send may outlive a lease during a network pause;
both workers can only send the same committed transaction, so this does not
create a new signature or spend authorization. RPC calls have bounded deadlines.

The worker waits for each tick before beginning another. It writes its heartbeat,
skips work if that fails, processes one leased operation and scans pending initial
recoveries. Shutdown drains an in-flight tick and closes its connection. Failed
work is rescheduled with bounded backoff. Initial recovery scans claim at most
20 attempts and defer each selected attempt for 60 seconds, so persistently
blocked older recoveries cannot monopolize every scan.

`submitted` means the send returned the expected signature. A lost response or
send error becomes `broadcast_unknown`; neither is a terminal failure. While
valid, the worker can resend identical bytes. It checks signature history with
`searchTransactionHistory=true`. A confirmed error remains provisional. Settlement
requires a finalized transaction receipt matching the stored signed bytes and
message hash, followed by finalized account reads at or after the receipt's slot.

Missing history after finalized block-height expiry becomes `manual_review` and
retains the full remaining reservation. A finalized status without its receipt,
wrong accounts, inconsistent balances or corrupt encrypted payload also stays
held. There is deliberately no automatic signed-expiry release based on `null`
history. A retry requests reconciliation of the existing operation; it cannot
refresh a blockhash, generate another registration or clear a hold. A fresh
Phase 3 quote/attempt is possible only after a conclusively finalized failure,
with a new payer and new wallet signature. Safe proof of never-landed expiry
and operator abandonment are not automated in this checkpoint.

## Exact settlement

The verifier checks every account's pre/post balance, signature, message and fee,
including the user's unchanged funds. Successful registration must have the
expected final domain owner and primary name. Sponsor debit is the original
price allocation, domain rent, any primary rent and the actual transaction fee.
If the registry lowered its price after signing, the difference remains in A;
it is not an immediate refund. A finalized failed transaction must show only
the sponsor's fee and otherwise unchanged balances.

Settlement runs under campaign/invite/attempt/operation locks and the current job
lease. It writes unique append-only ledger events and updates counters atomically.
The invite is consumed only on verified finalized success. If A has no residual,
the unused reservation is released and its recoverable secret and encrypted
payloads are cleared. A finalized failure keeps its charged fee, releases the
unused reservation and leaves the invitation eligible unless it was revoked.

If a successful registration leaves funds in A, its actual debit is recorded and
the recovery allowance Q remains reserved. The user slot is consumed, but the
attempt stays `finalized` and holds its name/invite pointer until residual
accounting is complete. A durable scan finds this state after a crash between
registration settlement and recovery preparation.

Recovery has its own operation, message, signature, encrypted payload, job and
finality lifecycle. Its only action is `A → S` for the exact observed residual,
with S paying a capped fee and a fixed 20,000-compute-unit limit. It accepts no
user-supplied destination. Revalidation uses the persisted recovery blockhash
and expiry, checks the original message fee and simulates that exact message.
Additional recovery fees must be reserved under the campaign cap before signing.

A verified finalized recovery credits the returned amount once, charges its fee,
releases unused Q and erases A's recoverable secret. A finalized failed sweep
charges its fee, retains the residual and remaining allowance, and requires
operator attention before another recovery. Uncertain sweeps retain their hold.
No expected refund is counted as spendable campaign budget.

Ledger conservation is expressed in native units:

```text
spent = registration debits + all transaction fees - finalized recovered funds
held  = reserve events - release events - registration debits - all transaction fees
available = campaign cap - spent - held
```

Recovered funds reduce `spent`; they do not create a negative reservation.
Amounts use bigint in memory and exact decimal strings in the database/API.
Database checks reject negative or nonfinite values. Both execution audit and
ledger tables reject UPDATE, DELETE and TRUNCATE; database owners remain trusted.

## Interfaces and local operation

Migration `0002_execution_recovery.sql` adds execution operations, leased jobs,
append-only audit events, remaining reservation, actual cost, residual, signature
and verification fields. It backfills existing active Phase 3 reservations and
advances readiness to schema version 3. Earlier migration SQL remains unchanged.

| Interface | Contract |
| --- | --- |
| `POST /api/attempts/:id/submit` | Strict `{userSignedTransactionBase64}` and capability cookie; returns status/signature only |
| `POST /api/attempts/:id/retry` | Strict `{}` and capability cookie; requests reconciliation of the same operation |
| `GET /api/attempts/:id` | Adds signature, verified slot, actual cost and residual to private attempt status |
| `ExecutionService.submit` | Validate/preflight and commit durable authorization; no immediate send |
| `ExecutionService.processOne` | Claim, sign/persist, observe/send, and reconcile one operation |
| `ExecutionService.recover` | Prepare a bounded residual recovery with its own reservation and work item |
| `runExecutionWorker` | Sequential heartbeat/tick loop with connection cleanup and safe error logging |

Submit/retry enforce exact origins, 4 KiB JSON bodies, a five-second read deadline,
capability cookies and global → IP → session → authenticated wallet/attempt rate
limits. The shared submit/retry limits prevent switching endpoints to evade the
global signing limit. Responses omit encrypted envelopes, payer keys and fully
signed bytes. Neither logs nor audit records contain request bodies or capabilities.

Run the local proof against the dedicated test database:

```sh
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm test:execution
DATABASE_TEST_URL='postgresql://first_bite:first_bite_local_only@127.0.0.1:55432/first_bite_test' pnpm phase4:proof
```

The flow proof needs the reviewed `.cache/registry.so`, obtained through the
read-only `pnpm phase0:inspect` command. Signers and funding exist only in its VM;
the test adapter never connects to a live RPC. Each database test suite uses
random private schemas. Run suites serially because migration locking rejects
overlapping migrators. CI separates the offline execution checks from the job
that fetches the reviewed ELF and runs the database/VM proof.

Local operator commands expose public accounting/progress and prepare bounded recovery:

```sh
pnpm ops execution --attempt ATTEMPT_UUID
pnpm ops recheck --attempt ATTEMPT_UUID
pnpm ops recover --attempt ATTEMPT_UUID
```

`recheck` schedules existing work; a connected execution worker is needed to process
it. `recover` rechecks finalized payer funds through the configured Cookie RPC,
reserves any additional capped recovery fee, and stores a sweep job. It neither
loads a signer nor broadcasts; an unresolved prior recovery cannot be replaced.
The default heartbeat process does not execute these jobs. Runtime signer
custody, enabled service/worker wiring, live Nightly evidence and a finite funded
campaign remain activation requirements. Do not add a sponsor secret to the
current `.env`; it is not read by this checkpoint. Production readiness still
reports foundation health only; full chain/worker/funding readiness is Phase 6.

Primary references: [signature history](https://solana.com/docs/rpc/http/getsignaturestatuses),
[transaction receipts](https://solana.com/docs/rpc/http/gettransaction),
[simulation](https://solana.com/docs/rpc/http/simulatetransaction),
[broadcast semantics](https://solana.com/docs/rpc/http/sendtransaction),
[PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html).
