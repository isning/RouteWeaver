# Notification reads and bounded background work (D4)

Deployment scope: a single control plane with Linux nodes and private invitations.
All results below are local synthetic tests, not a capacity promise or production SLA.

## Read and evaluation contract

Personal GET only reads the existing recipient-indexed inbox. It does not evaluate
all users, decrypt the usage ledger or acquire the SQLite writer in modern state.
Legacy logical imports are detected in the read snapshot and migrated atomically;
a concurrent re-import returns a conflict rather than a misleading empty inbox.

Each background tick evaluates at most 100 users in ID-keyset order. A maximum
input page that exceeds its two-second sub-budget is retried with 10 users
inside the remaining evaluation budget. Enqueue commits in groups of at most
10 recipients, so interruption does not roll back an entire large page. On
partial enqueue, the cursor resumes after the last committed user, not after
the unprocessed input-page tail. The cursor
wraps; deleted IDs do not stall it and new lower IDs are picked up on the next
rotation. A failed page is retried on a later rotation rather than starving all
later pages. Announcements and quota/expiry notices are asynchronous. With the
normal minute tick, several pages require several ticks; slow work, errors and
retries can extend this. An inbox GET does not force immediate delivery.

Usage windows are the same committed immutable cycle windows used by admission,
including future committed meter observations and reset boundaries. Warm windows
read projections without ledger SQL. A cold page shares a streaming ledger pass;
metadata preflight itself examines no more than 1,000,001 rows. Current cold limits
are 1,000,000 ledger rows, 512 MiB aggregate encrypted ledger bytes and 1 MiB per row.
Exceeding them emits the sanitized `notification quota cold rebuild exceeds the background budget`
worker error instead of allocating/decrypting unbounded history or assuming zero
usage. Policy-only snapshots explicitly mark usage unknown: they may generate
expiry notices, but cannot evaluate quota thresholds. Existing warm accounts continue when their projection generation is valid;
a dirty generation cannot be partially acknowledged. Already queued deliveries
remain eligible even when evaluation fails.

`ROUTEWEAVER_NOTIFICATION_COLD_ROWS` and `ROUTEWEAVER_NOTIFICATION_COLD_BYTES`
allow an operator to lower these limits using positive decimal integers; values
above the reviewed defaults or invalid values refuse control-plane startup. The
per-record 1 MiB cap is not configurable. Metadata uses the configured row limit
plus one. The memory allocation remains bounded by the current page and one
ledger record, not cumulative ciphertext bytes. A larger accepted byte limit does
not extend any time budget.

These cold limits are an operational constraint, especially after restart (which
invalidates derived usage windows). Frequent sampling can exceed them even with
few users. Do not treat a quiet inbox as proof of no quota warning, delete history,
or generate fake admissions to warm projections. Capacity/recovery planning must
measure a cold rebuild against actual retained history before deployment/restart,
using synthetic or separately authorized recovery-copy rehearsal. Warm-up must
finish within the normal worker limits; this change provides no bypass command
for an over-budget ledger. Arbitrary-length cold-history recovery is
not established by this change. Reset-history scans, current announcement sets,
provider observations and the O(current users) dispatch recipient list also remain
costs; this is not a constant-time system.

## Time, cancellation and channel fairness

The worker tick has a 15-second total context budget, including waiting for the
Store mutex, SQLite writer reservation, evaluation and outbound requests. Input,
announcement and provider evaluation share a maximum five-second sub-budget;
its expiry does not cancel the remaining dispatch slice. Current host observation
reads also use a cancellable read snapshot. SQLite
busy waits are sliced to at most 100 ms and bounded by the remaining deadline.
A single JSON encode/decode is cooperative rather than preemptible.

Worker dispatch permits at most 1,000 rounds: 800 in-app, 100 email, 100 webhook.
Each channel receives one third of the dispatch time remaining at entry. In-app
runs first; a blocked email provider cannot consume webhook's entire slice.
Ordinary service Dispatch retains its 100-round compatibility limit. Claims
materialize at most 16 due candidates per transaction (diagnostic scoped reads
retain the 128-candidate default), rather than repeatedly loading 128 candidates
for every single delivered event. Completed
facts persist between ticks. Cancelled unknown sends retain their lease instead
of being falsely marked accepted; expiry/retry can duplicate external delivery,
so consumers must dedupe by event ID. No exactly-once transport claim is made.

Observe the control-plane notification error log: cold-budget and time-budget
failures are distinguished without leaking raw storage/provider errors. Repeated
failures require operator investigation, not an assumption that all reminders
have been sent. A process crash still loses an in-memory page cursor (safe restart
at the beginning, durable dedupe retained).

## Evidence

Official Go 1.27.3, GOMAXPROCS=2, serialized package builds, synthetic local SQLite:

- Driver-level statement/row observation: initial two-user rebuild uses one
  metadata query plus one ledger stream; warm ticks and cross-handle incremental
  ledger updates issue **zero ledger queries and zero ledger rows**.
- Personal HTTP GET succeeds with an unrelated malformed ledger row that broke
  the old global-evaluation path. Modern reads succeed while another SQLite
  handle holds the writer reservation.
- Keyset tests cover insertion below cursor, deletion, disabled users and wrap.
  A pending recipient outside the first 100-user page is not cancelled.
- A 30 ms deadline interrupts a contended SQLite writer in under one second;
  baseline waiting lasted about five seconds. Mutex wait and mid-ledger
  cancellation preserve rollback; retry rebuilds complete projections.
- A deterministic evaluation timeout still drains an already queued in-app
  delivery; a provider snapshot waiting on the Store mutex honors cancellation.
- A blocking email sender does not prevent an in-app notice becoming visible
  while email is blocked, or a healthy webhook succeeding afterward. Rerun does
  not resend completed work or an unexpired uncertain lease.
- Final one-announcement fixture: 5 users/1 page in 26.704651 ms;
  500 users/5 pages in 2.01874659 s. All 501 deliveries (500 users plus operator)
  were available, with first/middle/last recipient inbox visibility checked.
  These were manually consecutive batches, **excluding minute-ticker pacing**.
  Under race instrumentation the 500-user case needed 10 batches/56.3027534 s:
  committed events advanced 101→201→301→401→501 and available deliveries
  advanced 55→108→162→215→275→344→…→501. Partial deadlines were expected,
  retained progress was asserted, and no timeout or round limit was increased.
  These are representative development test points, not capacity/SLA promises.
- Final targeted HTTP race suite (deadline, cold refusal, partial cursor and
  representative sweeps): PASS (86.925 s). Full notifications race suite:
  PASS (9.325 s); focused store race suite: PASS (4.599 s); injected-budget and
  provider-boundary race tests: PASS (1.262 s). Control-plane and migration CLI
  race suites: PASS (11.238 s / 1.426 s). Vet and both command builds passed.
- Independent review found provider mutex waiting, shared-phase deadline
  starvation and partial-enqueue cursor issues; each was corrected and covered.
  The original 128-candidate claim also stalled the instrumented workload;
  smaller 16-candidate claims preserve progress without weakening eligibility.

No live recipients, production database, sustained production workload or
remote CI/deployment is represented by these measurements.
