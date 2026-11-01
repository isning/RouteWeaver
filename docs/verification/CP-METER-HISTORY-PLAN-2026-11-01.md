# CP meter history: reproduction and remediation decision

Source: `9f7c6120c31e978dd77d256c68d46eac6e31f07c`. Investigation only; no
production persistence changes, pruning, live data operation or raised limit.

## Reproduced lifecycle

`TestMeterTransportHistoryGrowthRepro` uses a private synthetic SQLite DB and
public store methods. 200 sequential managed admission-budget batches produce
200 inbox rows (72,961 logical JSON bytes), 200 receipt rows (2,290 bytes), one
stream row and zero ledger rows; full logical export emits 407 frames / 100,148
serialized frame bytes. These synthetic short IDs/digests are not native wire
sizes or a capacity benchmark. Reopening the DB preserves both FIRST and LAST
exact retries as successful no-ops; changed digests reject. Focused test passes.

`internal/store/counter_ingestion.go` atomically writes counter cursors, sequence,
full original envelope and receipt digest. Receipt lookup precedes sequence
checking. Every historical exact digest currently succeeds, including after
restart; conflicting digest rejects. The stream high-water mark alone contains
no digest. There is no CP pruning/acknowledgement maintenance hook.

`internal/agent/driver.go` sends oldest pending first, then calls local durable
`MeterSpool.Ack` before advancing to the next. `meter.go` verifies exact
sequence/digest, saves the ACK before discarding the pending batch, and preserves
LastReceipt. Lost response or failed local persistence leaves the same batch
available to retry. HTTP transport verifies returned scope/sequence/digest.
No explicit client-durable-ACK message reaches CP. Receipt of N+1 is an implicit
ACK of N only under this sequential agent contract, not proof for an arbitrary
API client or an agent restored from an older disk snapshot.

Managed journal retirement preserves unresolved reservations and explicitly
relies on raw meter evidence already being durable at CP. That is a reason not
to silently reinterpret original inboxes as disposable cache.

## Actual cadence and risk

Managed snapshot collection skips unchanged cumulative values, even at a newer
timestamp (`managed_xray_meter.go`). Zero baseline is recorded once. Production
polling is one second, fixture polling 50ms; neither means every poll emits a
batch. The native reference's one payload exchange/second explains its observed
one batch/second. No multiplication by 20 is appropriate.

Managed admission-budget samples do NOT write ledger rows. Accounting is from
positive admission settlement deltas (`admission_budget.go`). Native long-flow
renewal uses min(10 seconds, half remaining lease); low remaining byte budget can
force earlier renewal, and final closure settles too. Zero delta writes no
ledger row. Thus native 90-second growth of nine ledger rows is consistent with
a long, lightly loaded flow, not a universal per-node rate.

The private profile chooses one CP, Linux nodes and invitation-only service,
but no node/user count, traffic rate or retention period. It is consequently
impossible to certify a retention horizon for that profile. A concrete plausible
scenario, not a forecast: one continuously changing stream sampled at 1Hz and
one positive long-flow settlement every ten seconds yields 2.1 new rows/second.
Ignoring all other rows, the 2,000,000-row complete-backup cap is reached in about
11.0 days. At 0.1 ledger row/second the 1,000,000-row notification cold rebuild
cap is reached in about 115.7 days; its separate 512MiB ciphertext budget may
bind sooner. More streams, short flows or accelerated budget renewals shorten
these horizons; idle periods lengthen them. Event counts/rates, not initial
SQLite/WAL growth, underpin this scenario.

The 1GiB backup limit counts framed archive bytes (both plaintext and encrypted
writers are bounded), not SQLite file size. Native observed inbox+receipt JSON
is approximately 780 bytes per pair before frame/ID/encryption overhead; native
ledger rows approximately 560 bytes before overhead. Those figures establish
material byte pressure but are insufficient for an exact first-failure date.
The synthetic export above is deliberately not substituted for a native archive
measurement. Full backup fails rather than skipping historical records.

The 1M limit is NOT a cap on inbox rows or every usage query. It protects
notification cold reconstruction of the COMPLETE canonical ledger. General
Usage cold rebuild currently scans the ledger without that row budget. Warm
projection success does not prove cold restore/cycle-change reconstruction can
complete. Pruning transport rows alone cannot close ledger-history capacity.

## Minimal bounded transport design (requires decision)

Existing sequence high-water plus latest exact digest are enough for bounded
sequential-agent retry safety. In the SAME write transaction as a successful
new batch, retain latest inbox+receipt and sequence; retire older fully committed
transport pairs only. Never delete ledger, cursors, pending/history/resolutions,
holds, immutable bindings, budgets, unresolved reservations or audit records.
This bounds transport rows per stream, not the number of streams or billing
history. A separate bounded maintenance cursor can catch up existing rows in
small transactions after validating stream ownership and numerical sequence;
do not use lexicographic sequence comparisons or unescaped prefix SQL matching.

Explicit compatibility change: retain exact latest retry success and reject all
older sequences as stale (including changed-digest replays), never accepting or
charging them. Existing sequential agents continue; arbitrary historical retries
and older agent-disk restores no longer receive successful historical receipts.
An older CP binary must not overwrite/drop the retention floor; store-version
compatibility and rollback must fail closed if new metadata is required. A
plain sequence gap rejection already prevents double charging, but explicit
stale semantics and tests are preferable to a misleading recovery instruction.

This cannot be a silent default because raw inbox retention and historical retry
success are current behavior. Safest option is an explicit operator retention
choice with authenticated, durable, verified archive handoff before deletion,
plus a defined way to inspect historical raw evidence. A mere successful export
HTTP response or time-based TTL is not proof of durable archive custody. Missing,
changed or uncertain archive evidence must block retirement. Archive storage
itself remains growing history, not globally bounded storage.

If raw-history retention remains indefinite in the same database, do NOT delete
inboxes. A limited immediate mitigation is bounded inventory/headroom reporting
and preflight backup/cold-rebuild health, leaving capacity gates open. Raising
caps or silently moving records outside backup is not remediation.

Ledger history needs a separate approved historical storage contract. Removing
settled ledger, coalescing away exact interval/rate/history facts, auto-refunding,
or dropping holds is excluded. Archive/query federation or lossless historical
partitioning is larger than the minimal transport fix and needs backup/restore,
cycle/reset-window and user-history semantics specified first.

## Required tests before enabling maintenance

- Lost response; local ACK write failure; exact latest retry after CP/agent
  restart; old exact/changed retry stale rejection and unchanged accounting.
- Concurrent duplicate/new batch and maintenance, cross-process SQLite writer
  contention, transaction failure at every mutation, cancellation and restart:
  either old complete state or new complete state, never missing latest receipt.
- Legacy sequential agent, older disk snapshot refusal, migration catch-up with
  malformed/overlapping stream identifiers, restored pre/post-retention backup,
  downgrade guard, active/pending/uncertain streams never retired.
- Long synthetic stream reaches fixed transport-row bound while exact usage,
  ledger, holds, pending history and admission reservations remain identical.
- Archive failure/missing/changed content blocks retirement; no successful
  archive custody is inferred merely from a completed transport response.

No global boundedness claim follows from the transport design. Await an explicit
choice of raw-history and historical-retry compatibility before implementation.

Pinned project skills were absent at the supplied local path; official pinned
raw retrieval returned a cache miss. They are not claimed as executed.
