# Overview with grown canonical history — 2026-11-01

**Finding:** the earlier small-source CRUD reference did not establish overview
capacity. At production source `a26b9f95b0d10653a2a191df43bfff9a72209cc0`,
100,000 synthetic canonical ledger rows made an ordinary authenticated overview
roughly 0.6–0.7 seconds even after warm-up. Twenty-five concurrent clients' finite
50-request stage had p95 19.20 seconds. This is a material history-dependent
bottleneck, not a production SLO decision or a maximum-capacity claim.

## Fixed experiment

Same owned private database and 25 ordinary synthetic accounts, normal CLI on
`127.0.0.1:0`, no mock, native core, external traffic, browser or real credential.
Run the empty-ledger profile, stop CLI cleanly, append exactly 100,000 encrypted
canonical `store.MeterRecord` rows, then start a fresh normal CLI and repeat.
Accounts use public `CreateInvite`/`AcceptInvite` methods; bulk history uses public
`CompareAndPutRecords` batches of 200, not raw SQL writes. SQL is used read-only
to assert ledger count. This prepares canonical history without claiming to test
meter-ingestion protocol throughput, replay or bindings.

Each account has exactly 4,000 rows. For account number `i` (0–24), every row has
raw bytes `i+1`, provider bytes `2*(i+1)`, and rate 1,500,000 millionths. Expected
current overview totals are raw `4000*(i+1)`, provider `8000*(i+1)`, weighted
`6000*(i+1)`. Aggregate exact weighting differs from summing individually rounded
records for odd raw-byte values; assertions use the exact aggregate semantics.
Records are observed one hour before setup, in the account's default non-reset
cycle. There are no future rows or reset/cycle transitions in this measurement.
It does not establish those edge-case semantics independently of existing tests.

One login per account outside the timed requests. Each profile measures one
first overview and five serial warm overviews, then 1, 5 and 25 concurrent clients
making two calls each, with at least two seconds between a client's own request
starts. There is no unbounded work queue: slow requests delay that client's next
call. This is **not** the earlier 50 offered requests/second CRUD workload.
68 overview calls per profile; 136 total. Every successful call asserts all three
usage totals exactly, not just HTTP status.

Predeclared guardrails: 512 MiB sampled process RSS, 1 GiB owned data, 30-second
request timeout, 240-second measurement watchdog. Fixture setup has a separate
180-second watchdog. Owned fixture and timed CLI metrics are sampled every
250 ms; these are sampled stop guards, not OS-enforced hard limits and cannot
exclude a transient between samples. CLI startup/login resources are not covered
by that timed monitor. No host limit or setting was changed. GOMAXPROCS=1 and
GOMEMLIMIT=256MiB apply directly to the CLI/fixture; the latter is a **soft** Go
memory target, not an RSS cap. The host is shared, not an isolated benchmark
machine; quiet-window replication was not required to identify the large
observed difference.

## Results (all exact usage assertions passed)

| Profile | First ms | Five warm requests ms | Peak sampled CLI RSS KiB |
|---|---:|---|---:|
| Empty ledger | 3.63 | 1.84, 1.87, 1.60, 2.19, 2.95 | 24,756 |
| 100,000 rows | 671.56 | 627.17, 580.55, 592.14, 690.93, 615.84 | 437,220 |

| Ledger rows | Clients | Requests/errors | Stage elapsed s | p50 / p95 ms | CLI CPU s |
|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 2 / 0 | 4.01 | 2.06 / 4.08 | 0.00 |
| 0 | 5 | 10 / 0 | 4.01 | 4.98 / 8.07 | 0.02 |
| 0 | 25 | 50 / 0 | 4.03 | 29.08 / 77.51 | 0.16 |
| 100,000 | 1 | 2 / 0 | 4.00 | 616.99 / 678.21 | 1.30 |
| 100,000 | 5 | 10 / 0 | 8.51 | 4,032.57 / 5,198.83 | 8.57 |
| 100,000 | 25 | 50 / 0 | 34.50 | 16,100.63 / 19,197.70 | 34.87 |

Percentiles are nearest-rank, and sample counts are deliberately small. Stage
elapsed includes the finite pacing waits. CPU includes the CLI's background
workers, not only the endpoint. The grown profile used 48.55 CLI CPU seconds
across all measured requests. Its RSS ended at 61,040 KiB; the sampled peak was
approximately 427 MiB, below the 512 MiB stop but above the soft Go memory target.
The monitor did not retain per-request RSS timestamps, so the peak cannot be
attributed specifically to overview allocation versus concurrent notification
work. This result must not be used to pre-judge the separate notification
projection remediation.

100k-row setup took 30.52 seconds, sampled CPU 30.34 seconds, peak fixture RSS
21,920 KiB. Account setup took 2.77 seconds. CLI readiness after process start was
0.101 seconds empty and 0.807 seconds grown; neither is a cold OS-page-cache test.
Owned data (DB/WAL/SHM plus small startup logs) was unchanged during each read
profile: 575,964 bytes empty and 63,077,016 bytes grown. The script reports this
combined owned-data size, not a physical page-by-page DB growth attribution.
No resource threshold or timeout fired. Both CLI exits were clean; test-owned
temporary state was removed. Script exit 0 means assertions/guardrails passed,
**not** that 19-second responses satisfy any production requirement.

## Interpretation and next decision

`overviewContext` calls `UsageContext` for `[cycle/reset start, now + 1 ns)`.
`UsageContext` streams `SELECT id,data FROM records WHERE kind='ledger' ORDER BY
id`, decrypts every record, then filters user/time in the reducer. Streaming
bounds application record memory but leaves work proportional to **total**
canonical history for every user's overview. Warm repetitions and CPU growth
show that this is not merely a first-request cache/build cost.

The measured change is large enough to justify investigating a minimal,
semantics-preserving selective-history path rather than documenting the earlier
small-data result as sufficient capacity evidence. No index or projection was
implemented here. Any proposed acceleration must retain the current-time cutoff,
reset/window semantics, canonical correction/replay behavior and encryption/
privacy contract. The current-cycle notification projection is not automatically
interchangeable with this arbitrary cutoff. This experiment alone does not prove
which index design is correct or establish a production latency budget.

Remaining gates: realistic traffic and history distributions, reset/future-row
cutoffs under an accelerated path, concurrent canonical writes, cold-start and
background-worker interaction after notification remediation, longer load,
isolated/real host measurements and an owner-selected latency/error budget.
No 1-million-row fixture, extrapolated retention forecast or production-user
support limit is claimed.

## Reproduction and evidence

Build `./cmd/control-plane` and `./scripts/overview-fixture`; run:

```sh
python3 scripts/reference-overview-history.py \
  --binary /absolute/path/to/control-plane \
  --fixture /absolute/path/to/fixture \
  --output /absolute/path/to/result.json
```

- [Aggregate receipt](evidence/OVERVIEW-HISTORY-2026-11-01.json)
- [Source/binary hashes](evidence/OVERVIEW-HISTORY-HASHES-2026-11-01.json)
- Python compile, Go helper build/vet, helper package compilation, architecture
  check and `git diff --check` passed. No full suite/CI/push/deployment performed.
- This commit adds measurement helpers and evidence only; no production logic or
  storage schema change. Separate notification work remains owned by its worker.
