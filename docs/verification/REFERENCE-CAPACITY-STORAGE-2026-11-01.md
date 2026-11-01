# Finite Linux CLI capacity/storage reference — 2026-11-01

Production source `4d384e2`; synthetic private state, normal control-plane CLI,
`127.0.0.1:0`, no HTTP mock, browser, external fetch, native proxy or deployment
in the CLI measurement. The source endpoint `192.0.2.1` is imported text, never
contacted. This is a **paced reference workload**, not a maximum-capacity test,
production SLO, multi-node certification or sustained service guarantee.

## Fixed profile and bounds

25 unique test users prepared offline through public store CreateInvite and
AcceptInvite APIs, then one real HTTP login per account outside timed windows.
This avoids benchmarking password hashing or the shared invite limiter (20
anonymous attempts per source/pair per five minutes); no limiter was disabled.
Each user owns one private source with one endpoint. Three 30-second windows use
1, 5 and 25 concurrent client threads, each scheduling 60 requests at 500 ms
intervals: nine source reads then one controlled source-name update, repeated six
times. Client requests are sequential, so overload can delay the schedule rather
than creating an unbounded queue. The 25-client point offers 50 requests/second.

Predeclared stops: unexpected response or tenant/source invariant; CLI RSS above
512 MiB; owned data above 512 MiB; 180-second benchmark watchdog; five-second
request timeout. Binary/fixture/receipts total 72 MiB before native observation;
no disk quota, CPU quota, sysctl or host setting was changed. CLI environment:
GOMAXPROCS=1 (scheduler parallelism), GOMEMLIMIT=256MiB (soft Go heap target, **not
RSS ceiling**). Hard CPU/RSS limits were not exposed. Shared-host interference,
Python client scheduling and instrumented read snapshots are included; results
are not isolated-machine performance estimates.

## Observed result

| Concurrent clients | HTTP 200 / errors | Updates | p50 / p95 / p99 ms | Max RSS KiB | CLI CPU s |
|---:|---:|---:|---:|---:|---:|
| 1 | 60 / 0 | 6 | 2.92 / 28.54 / 123.71 | 25,356 | 0.28 |
| 5 | 300 / 0 | 30 | 3.55 / 9.90 / 12.86 | 25,792 | 0.29 |
| 25 | 1,500 / 0 | 150 | 12.28 / 28.67 / 41.40 | 26,364 | 1.15 |

All 1,860 timed operations returned HTTP 200. Every returned source ID matched
its authenticated tenant's source; before/after source listings contained exactly
one own source per tenant. All final source names matched their last mutation when read back. CLI shutdown
was clean and temporary data removed.
Percentiles are nearest-rank across combined reads and updates, not endpoint-
specific SLOs. The non-monotonic p99 is an observed short-run result, not evidence
that more users improve latency. Source-record row count remained 25; total
records remained 127. Across all windows, DB+WAL+SHM grew from 905,496
to 2,157,976 bytes; encrypted record payload from 58,545 to 100,415 bytes. Source payload bytes increased with mutation history (bounded to 20 events
in production code), and measured file growth was in the WAL; a constant row count is not zero growth.

Machine-readable receipt: [CLI-CAPACITY-2026-11-01.json](evidence/CLI-CAPACITY-2026-11-01.json).
Reproduce from the repository root by building `./cmd/control-plane` and
`./scripts/capacity-fixture`, then passing their paths to
`scripts/reference-cli-capacity.py --binary ... --fixture ... --output ...`.
The helper is synthetic offline setup only, not a supported operator command.

## Agent cadence and storage interpretation

Production `cmd/node-agent/main.go` sets PollInterval=1 second and
LeaseInterval=250 ms. `internal/agent/driver.go` collects managed counters in the
poll worker (subject to work duration), sends observations and pushes durable
meter batches; service heartbeats have a separate five-second minimum spacing.
The existing native reference fixture instead uses 50 ms polling and 50 ms
lease checking. Do not treat its receipt growth per wall-clock minute as a
production rate or multiply it into a guaranteed retention estimate.

The updated 30-minute reference observed DB 4,096→2,748,416 bytes and WAL
1,924,072→4,152,992 bytes (SHM 32,768), but did not record table counts. Its
expired fixture data cannot be retrospectively attributed exactly. SQLite WAL
size is allocation/checkpoint behavior, not live payload bytes. The agent's
bounded outbox/epoch retirement is separate from control-plane meter history;
no unlimited control-plane history issue is declared fixed here.

## Remaining gates

This supports a modest **reference envelope** of 25 synthetic tenants / 25 source
rows / 50 offered requests per second / 30 seconds for this exact API mix only.
No maximum users, nodes, flows, endpoints, throughput or retention period is
established. Large datasets, output rendering, imported remote sources, operator
bulk changes, auth bursts, simultaneous managed traffic, WAN/TLS/proxy behavior,
real host resource quotas, multi-flow/native accounting throughput and sustained
load/soak remain separate gates. Production latency/error budgets, host sizing,
retention requirements and expected traffic must be chosen before a capacity
acceptance test can be specified. No test changes production policy.

Verification: CLI run exit 0; Python compile; Go helper build; focused
TestManagedObservationWindowBounds passed; git diff --check. Pinned project
skills files were unavailable at the supplied local path and official raw
retrieval failed; they are not claimed as executed.

## Bounded native storage attribution follow-on

An additional 120-second run reused the existing real managed-native fixture,
with observation-only public `Store.List` counts and aggregate logical JSON bytes
for nine history/state kinds at 0/30/60/90 seconds. No values/credentials were
reported, no HTTP mock or new server endpoint was introduced. Production source
remains `4d384e2`; test instrumentation and binary hashes are in
[STORAGE-ATTRIBUTION-120S-2026-11-01.json](evidence/STORAGE-ATTRIBUTION-120S-2026-11-01.json).
This measures the same fixture's growth categories, **not exact retrospective
attribution** of the earlier 30-minute database. Counts across kinds are separate
public reads, not a cross-table transactional snapshot.

| Record kind | Rows at 0 → 90 s | Logical JSON bytes at 0 → 90 s |
|---|---:|---:|
| meter-inbox | 2 → 92 | 1,421 → 65,653 |
| meter-receipts | 2 → 92 | 132 → 6,072 |
| ledger | 1 → 10 | 559 → 5,609 |
| meter-streams | 1 → 1 | 16 → 17 |
| admission-budgets | 1 → 1 | 542 → 545 |
| entry-admission-leases | 1 → 1 | 624 → 624 |
| agent-desired | 1 → 1 | 2,687 → 2,687 |
| agent-observations | 1 → 1 | 1,485 → 1,485 |
| meter-pending | 0 → 0 | 0 → 0 |

The fixture retained one incoming meter batch/receipt per second of payload and
periodic admission-settlement ledger records. Do not infer 20 batches/second
merely from its 50 ms polling. DB grew 4,096→221,184 bytes; WAL
1,874,632→4,120,032 bytes, reaching that allocation by the 30-second sample and
holding through 90 seconds; SHM remained 32,768 bytes. Logical JSON excludes
encryption/SQL/index/page overhead. The sampled nine kinds are not a full DB
inventory, so their bytes are not equated with physical file growth.

All 120 exact payload exchanges passed; max RTT 54.50 ms; unchanged native
identity, renewed service, revoked-new-flow denial, closure of the existing flow
within its admission lease, still-live native runtime and bounded cancellation/
cleanup all passed (test exit 0, 141.97 seconds overall). Sampled native RSS
33,668→35,160 KiB, FDs=12 throughout. Parent test/CP alone received
GOMAXPROCS=1/GOMEMLIMIT=256MiB; native Go defaults were unmeasured and neither
process had an established hard CPU/RSS cap. Existing parent-heap/agent-root
bounds remained enabled. No multi-flow capacity claim is made.

The retained CP meter inbox/receipts/ledger history is an open retention/sizing
consideration. Agent-side retirement does not prove CP history bounded. No
pruning policy, unlimited-growth fix or linear production forecast is asserted.

Native command (built test binary; the managed binary is the already-verified
updated-dependency reference, not an external download):

```sh
GOMAXPROCS=1 GOMEMLIMIT=256MiB \
ROUTEWEAVER_MANAGED_XRAY_BIN=/absolute/path/to/reference-managed-xray \
ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS=120 \
./httpapi.test -test.run '^TestNativeContinuousManagedServicePreservesPayloadAndRevocation$' \
  -test.v -test.timeout=200s
```

The complete gate, release packaging and CI were not run by this measurement;
the coordinator owns those separately. No production files, remote state,
credentials, billing, GitHub publication or real VPS were changed.

The final table is the full repeat after adding explicit persisted-update and
redirect-refusal assertions. The initial complete run is preserved separately in
[CLI-CAPACITY-INITIAL-2026-11-01.json](evidence/CLI-CAPACITY-INITIAL-2026-11-01.json).
Both passed; short-run/shared-host percentile variation is visible, not hidden
by selecting the faster run. Neither is a statistically established SLO.
