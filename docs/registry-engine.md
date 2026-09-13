# Registry client and transaction engine

Phase 2 prepares unsigned sponsorship quotes and verifies their fixed message
structure. It is not exposed by a public route. `RELAY_ENABLED=true` is still
rejected. No sponsor key is loaded, no attempt secret is stored, and no network
transaction is signed, simulated or sent.

The Phase 0 real-wallet/funded-registration gate remains open. Continuing this
phase while the user arranges the wallet produces a local integration checkpoint,
not authorization to operate a campaign or a replacement for Nightly evidence.

## Reviewed registry policy

`src/lib/chain/policy.ts` pins the genesis, registry/config addresses, loader,
program-data address, deployment slot, upgrade authority, ELF hash/size, complete
config hash, fee receiver, rent sysvar hash and tested rent values to the committed
Phase 0 observation. Any changed policy fails closed. A changed price is a config
change too: review it, rerun the local proof and deliberately update the policy
before offering another quote. Do not automatically replace the baseline from RPC.

`createRegistryClient` uses a narrow read-only connection. It reads all eleven
relevant accounts in one finalized `getMultipleAccounts` context, verifies live
rent RPC values against the reviewed rent policy, then fetches a subsequent
blockhash. `observedSlot` records the account context; `blockhashContextSlot`
records the later blockhash context. Fee results must be at least as recent as
that blockhash. A client instance rejects context rollback, including across
requests. Concurrent reads can conservatively reject an older result; retry the
whole unsigned observation instead of accepting stale evidence.

The HTTP transport aborts after four seconds, and each logical RPC operation has
the same deadline. Automatic rate-limit retry is disabled. RPC failures expose
only enumerated codes without URLs, server text, values or original causes.
RPC monetary values must be safe non-negative integers before conversion to
`bigint`; values that web3.js cannot represent exactly are rejected. Instruction
arithmetic and JSON output never round through floating-point amounts.

The injected connection/policy options are for trusted server code and tests.
Never populate them from browser request data. The server-only wrapper checks
that configured genesis matches the reviewed policy before constructing a client.
An RPC observation is evidence from the configured endpoint, not an independent
cryptographic proof of chain state. The registry can still upgrade after a read;
the later signing phase must revalidate and simulate, with that trust limitation
documented for the operator.

## Account eligibility

- Only normalized 4–32-character names in the existing ASCII tier are accepted.
- Any existing domain allocation means unavailable, including malformed or legacy
  accounts. An RPC error never means the name is available.
- Sponsor, attempt payer and user must be distinct on-curve signers with no
  protected-account aliases. The sponsor/user may be absent or empty system accounts.
- The attempt payer account and its primary must both be absent. Checking the
  chain does not establish that its secret was freshly generated or never used;
  the future durable attempt service must generate and bind a unique identity.
- An existing user primary is accepted only if it is a valid cleared registry
  record with enough rent. A nonempty primary is ineligible for this newcomer flow.
  This is not proof that the user has never owned another domain.
- A missing primary receives its full rent allocation, regardless of the user's
  other COOK balance. A valid funded cleared record receives no top-up.

## Exact quote contract

`prepareSponsoredQuote(request, client, limits)` returns a frozen JSON-safe record:
name, public identities, policy/config/program fingerprints, both observation
slots, unsigned bytes, message hash, blockhash/last valid height, expected final
owner/primary and decimal-string costs. The caller must provide explicit price,
fee, recovery and total caps; there is no default funded campaign budget.

`maxSponsorDebit = registrationPrice + domainRent + primaryRent + transactionFee`.
`maximumReservation` adds the separate recovery allowance. Preparation requires
the observed sponsor balance to cover the full reservation. That balance check
does not lock campaign capacity or protect against concurrent spending; Phase 3
must reserve it transactionally before any message becomes signable.

The unsigned lease is 1–60 seconds as selected by the operator, counted from the
start of preparation. A slow RPC cannot extend it. Blockhash validity ends after
the inclusive `lastValidBlockHeight`. `assertUnsignedQuoteFresh` checks only this
unsigned lease/height. It must never release a signed or uncertain reservation.

The engine copies public keys, values and serialized messages before handing data
across asynchronous adapter calls. Mutating a caller request, account observation
or fee-message object cannot alter the recorded review or transaction bytes.

## Independent message validation

`validateSponsoredMessage` parses legacy bytes directly with a bounded canonical
short-vector reader. It does not validate by rebuilding the message. The expected
input must come from the server's validated quote. It enforces:

- Exactly three writable signers, sponsor first, ten canonical account keys and
  exactly four readonly unsigned accounts.
- A 200,000-compute-unit limit and no priority-price or extra instruction.
- Exact S-to-A allocation, A-only registration payer, registry recipient, A-to-U
  ownership transfer, optional primary-rent transfer and set-primary action.
- Literal instruction discriminators/data, exact account indices/order, blockhash,
  bounded integer amounts and a packet of at most 1,232 bytes with signatures.
- No trailing bytes, noncanonical vector lengths, additional privileges or aliases.

Tests include fixed golden encodings, both primary-rent branches, every single-byte
mutation and every truncation of those valid messages. The original exact-message
user-signature verifier remains available for the later wallet flow.

## Verify and inspect

```sh
pnpm test:registry
pnpm phase2:inspect
pnpm test:proof
```

`phase2:inspect` reads the public RPC using fresh unfunded public identities, checks
a random diagnostic name and writes `.cache/phase2-observation.json`. An optional
bare name can be supplied as its argument. It checks the message policy and live
fee but intentionally does not return an eligible sponsor quote: its sponsor is
unfunded. It never retains secrets or signs. The reviewed observation is separately
saved under `docs/evidence/`; refreshing the command does not overwrite it.

`test:registry` uses deterministic synthetic RPC fixtures. `test:proof` needs the
previously hash-checked `.cache/registry.so` and executes the actual deployed ELF
inside LiteSVM, with local signers/funds. Neither test establishes network finality
or Nightly behavior. Run `pnpm phase0:inspect` to fetch the pinned ELF if missing.

Sources: [multiple-account context](https://solana.com/docs/rpc/http/getmultipleaccounts),
[blockhash expiry](https://solana.com/docs/rpc/http/getlatestblockhash),
[exact message fees](https://solana.com/docs/rpc/http/getfeeformessage), and
the committed [upstream IDL provenance](../vendor/cookie-domains/README.md).
