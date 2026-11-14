# Node resources and provider allowances

This is the K04 resource/allowance observation slice and the K05 allowance-notification source. It does not implement remote speed tests or provider-account integrations.

## Data path

An enrolled node-agent explicitly started with `--observe-node` reads Linux procfs through `NodeCollector`. It sends authenticated, scoped, sequenced reports to `/api/agent/instances/{instanceId}/node-observations`. The control plane accepts only the administrator-designated Core Instance for the physical VPS Node. Other cores on that node do not contribute a second report or double its traffic. Changing an enrollment, moving the instance to a different host, or revoking it fences old reports.

The collector reads only `stat`, `meminfo`, `loadavg`, `net/dev`, and `sys/kernel/random/boot_id`, with each read capped at 256 KiB and at most 128 named interfaces. It uses neither shell commands nor netlink, and cannot modify networking. Linux guest CPU time is not counted twice. Available memory is Linux MemAvailable, not an invented zero or a sum of unrelated memory fields. CPU percentage is null until a valid counter interval exists.

Authenticated admin reads use `/api/admin/nodes/{nodeId}/observability`. Configuration changes use `PUT .../config` with the revision from the read. Provider statement entry uses `POST .../provider-statement`; NIC reconciliation uses `POST .../baseline` with the latest report digest. All snapshots/configuration/baselines/statements are persisted in the existing encrypted SQLite record store. Mutations obtain a database write reservation before reading inputs, so separate Store handles cannot overwrite deltas, bypass configuration revision checks or interleave enrollment revocation with ingestion. No broker or second service is introduced.

## Accounting meaning

- The collector reports each NIC name and separate received/transmitted cumulative byte counters. It never sums every interface or treats loopback/container counters as provider usage.
- The administrator explicitly selects provider-facing billed interfaces. Only their IN+OUT deltas enter the NIC estimate. NIC link bytes are not tenant payload bytes; route/user multipliers and usage ledgers are never read here.
- `GB` and `TB` are decimal, `GiB` and `TiB` binary, and `bytes` exact. Integer allowance plus unit is explicit. No UK/FRA/LAX resources, quotas, provider cycle dates, or credentials are seeded.
- For limited allowances the current cycle ID, start and end are operator-entered. An unlimited provider need not invent a reset cycle. A counter interval crossing a boundary is not split by interpolation. The next cycle requires explicit configuration and reconciliation; no reset day is inferred.
- Observed NIC bytes are only a partial lower bound until an operator reconciles usage at an exact current snapshot. Initial cumulative counters are not assigned to the current cycle. The operator baseline supplies prior usage explicitly and records actor, time, reason and report digest.
- A provider statement is entered independently with its provider reference and observation time. It is labeled separately from the NIC estimate. There is no automated provider portal fetch, and entering a statement does not fabricate node resource measurements.
- Missing NICs, counter reset, sequence gaps, enrollment/stream change, and observation intervals over 15 minutes invalidate reconciled NIC completeness. Known partial bytes remain visible; remaining allowance becomes null until reconciliation. Exact duplicate retries do not add bytes. Conflicting duplicates and out-of-order reports are rejected.
- Provider exhaustion defaults to advisory. Explicit `suspend-managed` opt-in gates managed connection admission/renewal: exhausted or expired providers and unknown, incomplete or stale selected evidence fail closed. Existing flows close when their bounded lease expires, not by stopping the whole node. It does not enforce stock cores/external credentials, change exits/routes or alter user accounting/quotas. Incomplete coverage does not manufacture a full or zero remaining budget. An operator-configured unlimited provider has no numeric remaining allowance. See `provider_admission.go` and `../httpapi/provider_native_test.go`.

## Notification and runtime behavior

Only a specifically enabled source with current cycle, complete coverage and observation no older than 15 minutes reaches `notifications.EvaluateProvider`. Notification text names the NIC-estimate or operator-entered-statement source. Stale or partial data stays contextual in the node detail instead of becoming a global health warning.

Node collection/reporting runs in the driver's existing network worker, not the mutation or lease-enforcement lane. It is optional and does not stop runtime policy enforcement on collection errors. Retries preserve a sample's digest/sequence until acknowledgment. A resource sample stranded by an outage over 15 minutes rotates to a new stream, explicitly breaking coverage rather than retrying stale data forever. Resource observations are not the durable tenant accounting outbox.

## Verification

Tests cover pure continuity/budget calculations, bounded synthetic procfs reads, persisted state after reopening SQLite, duplicate/conflict/scope fences, HTTP authentication and administrator authorization, two cores on one physical node, provider notification input, and the actual driver-to-HTTP-to-store path. `ROUTEWEAVER_LOCAL_PROCFS=1` additionally runs a read-only check against this execution environment's procfs; it does not contact or configure a VPS.

The focused race gate is:

```
scripts/go.sh test -race ./internal/observability ./internal/store ./internal/httpapi ./internal/agent -run 'Test(Node|Provider|DriverCollects|Replay|Config|Cycle)'
```

These are local/synthetic and loopback transport results, not evidence of deployment on the user's real VPS nodes, exact provider billing equivalence, provider-account access, or production traffic throughput.

## Resource history

The administrator resource-history endpoint retains **real** CPU, memory and
selected-NIC rate snapshots, not averages, peaks or billing totals. The first
accepted snapshot in each five-minute bucket is kept; a discontinuity can
replace that bucket once so a restart cannot disappear behind downsampling.
Missing derivatives remain null. Charts must not bridge discontinuities or
missing intervals. Changing the designated observer or selected interfaces
clears the incompatible history; changing only provider allowance does not.

Storage uses two independent encrypted records per node: at most 288 five-minute
points (80 KiB new writes) and 168 hourly points (48 KiB new writes), with a
global limit of 256 distinct nodes across both tiers. Normal collection writes
only changed tiers: the daily tier once per five minutes and the weekly tier
once per hour, plus bounded discontinuity updates. Each report reads/decrypts
bounded records, but does not re-encrypt an unchanged hourly tier. Both updates
share the accepted-observation transaction. A damaged optional tier stays
unavailable without rolling back authoritative observations or blocking cleanup
of other records. Changing observer/NIC scope clears both tiers atomically.

The control plane prunes at startup and each minute in bounded per-record
transactions. Reads always hide data outside the selected window. Legacy daily
records (up to their original 128 KiB read limit) and backups remain readable;
they have no hourly tier until new reports arrive. There is no backfill, average,
peak or forecast. Offline backups retain their own copies.

Capacity counts distinct nodes, not records: a full store does not stop latest
resource observations or provider accounting. The endpoint reports unavailable
capacity for new nodes. New-write live ciphertext is bounded by 32 MiB across
both tiers, excluding SQLite/WAL, freed pages and backups. Theoretical full-cap
scheduled rewrites are 5.625 GiB/day daily plus 0.28125 GiB/day hourly (rather than
9 GiB/day for a combined 128 KiB record); discontinuity, retention and WAL writes
add overhead. This is a conservative allocation bound, not measured SSD writes.
This small-fleet store is not a time-series database for thousands of hosts.

## Advisory exhaustion projection

The resource view computes a constant-rate projection only for the current,
fresh, reconciled NIC-estimate allowance. The numerator is the actual cumulative
selected-NIC IN+OUT increment since the latest operator reconciliation; the
denominator is its exact observation interval, which must cover at least 24
continuous hours. A reboot, missing sequence, long report gap or selected-NIC
counter reset invalidates the baseline and therefore the projection. A new
reconciliation starts a new 24-hour qualification period. Single manual bills
cannot establish a rate. Zero observed traffic does not imply infinite service.

The result is restricted to the current cycle or earlier service-expiration
boundary, with explicit insufficient/stale/unsupported states. It assumes the
observed average persists; it is not a confidence interval, billing guarantee,
peak forecast or short-term burst model. It does not change notifications,
admission policy, suspension or any user setting. The frontend hides the date
after read failure or staleness. Computation is read-only O(1) over existing state:
no new agent reports, history scans, records, encryption writes or SSD write
amplification are introduced.
