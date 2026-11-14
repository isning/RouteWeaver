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
