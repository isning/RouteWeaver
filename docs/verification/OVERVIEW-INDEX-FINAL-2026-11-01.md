# Corrected owner-history index reference — 2026-11-01

Production source **`c0581ab`**, including exact validation of all nine required
trigger definitions. This is the final corrected-source repeat, not the earlier
`a4e2072` intermediate. Normal CLI, synthetic private accounts/data, owned
loopback only; no mock, native proxy, browser, real credentials or deployment.
Root/author held large local checks during the run; the host was not globally
isolated. No production code was changed by this measurement worker.

**Outcome:** all original **136** overview requests, plus **six separately
reported zero-history probes**, returned HTTP 200 and exact raw/provider/weighted
usage. The grown-history slowdown is substantially reduced in this bounded
reference. This is not a production SLO, maximum capacity or permission to claim
support for a particular production user count.

## Comparable profile and qualifications

The original 100,000 canonical ledger rows remain distributed across 25 users
(4,000 each), with the same exact fractional aggregate-weighting expectations,
first + five warm requests, and 1/5/25 concurrent-client stages of two calls each.
Each client's own request starts remain >=2 seconds apart; slow calls delay the
next request rather than spawning an unbounded queue. One additional ordinary
account has **zero** ledger history; three probes per profile are kept separate
from the original 136 requests. Setup uses public encrypted store APIs, not raw
SQL writes, and does not measure the real meter-ingestion protocol.

Read-only dbstat inspection and startup/login precede the first HTTP overview;
this is not an OS cold-cache experiment. The old baseline source `a26b9f9` differs
by both the owner-history index and resumable notification work. Therefore do
not attribute all memory/latency improvement solely to the index. Every measured
row, including the slower empty-profile result, is retained rather than selecting
the fastest run. Only this corrected-source repeat is used in the final table.

## All measured stages

| Ledger rows | Clients | Requests/errors | Stage elapsed s | p50 / p95 ms | CLI CPU s |
|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 2 / 0 | 4.01 | 3.20 / 3.20 | 0.00 |
| 0 | 5 | 10 / 0 | 4.05 | 10.25 / 106.91 | 0.08 |
| 0 | 25 | 50 / 0 | 7.53 | 74.53 / 2,377.99 | 2.87 |
| 100,000 | 1 | 2 / 0 | 4.00 | 41.04 / 90.27 | 0.21 |
| 100,000 | 5 | 10 / 0 | 4.01 | 199.57 / 260.56 | 0.57 |
| 100,000 | 25 | 50 / 0 | 4.03 | 953.12 / 1,171.02 | 2.39 |

Percentiles are nearest-rank on small, finite samples. CPU includes background
CLI workers; zero rounded CPU is below the sampling resolution, not zero work.
The empty 25-client stage was slower than the grown stage. Its exact cause was
not isolated by this instrumentation: shared-host/client scheduling, background
work and contention remain possible, not proven explanations. This variability
prevents treating one short-window percentile as a stable SLO or claiming that
more history improves latency. No extra load was run to cherry-pick this away.

| 100k-row comparison | Old a26b9f9 | Corrected c0581ab |
|---|---:|---:|
| First loaded overview ms | 671.56 | 65.85 |
| Five serial warm calls ms | 580.55–690.93 | 36.55–59.11 |
| 25-client p95 ms | 19,197.70 | 1,171.02 |
| 25-client elapsed s | 34.50 | 4.03 |
| 25-client CLI CPU s | 34.87 | 2.39 |
| Timed CLI peak RSS KiB | 437,220 | 97,856 |
| CLI startup/readiness s | 0.807 | 4.004 |

Zero-history account with 100k **other users'** rows returned exact zero in
2.58 / 1.60 / 1.66 ms. Empty-profile zero probes were 1.78 / 2.45 / 1.64 ms.
The empty profile's first loaded-account call was 4.70 ms; warm calls were
2.17 / 2.95 / 2.21 / 3.02 / 3.49 ms. Grown final RSS was 40,164 KiB;
empty-profile timed peak was 25,908 KiB. No attribution of the whole-process RSS
reduction to the index alone is established.

## Setup, startup and index disk cost

Preparing 100k records through the corrected indexed store took **60.69 s**, with
sampled CPU **61.53 s** and peak fixture RSS **22,416 KiB**. The earlier no-index
setup was 30.52 s; the intermediate name-only index setup was 44.64 s. These are
synthetic bulk setup costs, not real ingestion-throughput guarantees. Exact
trigger validation has a measured cost worth retaining alongside faster reads.
Account setup took 2.26 s. Grown startup was 4.004 s; empty startup 0.102 s.

Read-only SQLite B-tree page allocation after grown startup:

| Object | Allocated bytes |
|---|---:|
| usage_history | 16,429,056 |
| sqlite_autoindex_usage_history_1 | 18,251,776 |
| usage_history_owners | 4,096 |
| sqlite_autoindex_usage_history_owners_1 | 4,096 |
| usage_history_state | 4,096 |
| **Total** | **34,693,120** |

The empty index occupies 20,480 bytes. Grown membership rows=100,000, owner
counts=25, state rows=1. The additional zero-history account does not create
fictional history. After startup and at the end of requests, grown DB/WAL/SHM
were unchanged at **97,308,672 / 34,937,632 / 98,304 bytes**. WAL includes startup
rebuild/write allocation, not an additional 34.9 MB of live index payload.
The approximately 34.7 MB allocated index is a real disk tradeoff; physical
file differences versus the earlier run also include WAL/checkpoint/layout
behavior and must not be extrapolated into a guaranteed retention forecast.

During grown requests, combined owned-data bytes increased 132,345,200 →
132,347,024. Stable DB sidecar sizes plus the retained process log identify this
1,824-byte difference as log growth, not new index/ledger data. The final log was
2,348 bytes with 15 identical bounded-rebuild continuation messages:

> notification quota totals are rebuilding in bounded steps; expiry and retained outbox processing continue

No other background error text occurred. This explicitly means notification
quota projection was still rebuilding during the finite window; **completion
was not established** by the overview test. Correct overview totals do not prove
notification projection completion. No pending notification is declared healthy,
completed or lost by this report. Private process logs were retained outside git
for coordinator inspection; aggregate counts are included in the receipt.

## Bounds, source binding and verification

Same fixed guards: 512 MiB sampled process RSS, 1 GiB owned temporary data,
30-second per-request timeout, 240-second measurement watchdog, 180-second
fixture watchdog. No guard or timeout fired. Sampling is every 250 ms during
fixture/timed measurement; readiness polling and between-login checks add setup
coverage, but are not hard OS limits or guarantees against between-sample peaks.
GOMAXPROCS=1 and GOMEMLIMIT=256MiB apply directly; soft memory target is not RSS
ceiling. No host quotas/sysctls were changed. Both CLIs exited cleanly; temporary
fixture state was deleted. Exit 0 means correctness/guardrails passed, not SLO
acceptance.

Production directories and module files were verified identical to `c0581ab`.
The receipt's source_commit names the measurement merge HEAD; companion hashes
bind the log-retention working-tree instrumentation and actual binaries. The
measurement changes only helpers, reports and receipts.

- [Final aggregate receipt](evidence/OVERVIEW-INDEX-FINAL-2026-11-01.json)
- [Final source/binary hashes](evidence/OVERVIEW-INDEX-FINAL-HASHES-2026-11-01.json)
- Baseline: `OVERVIEW-HISTORY-CAPACITY-2026-11-01.md`.
- Superseded intermediate: `OVERVIEW-INDEX-INTERMEDIATE-2026-11-01.md`.
- Reproduce using `scripts/reference-overview-history.py` with freshly built
  `./cmd/control-plane` and `./scripts/overview-fixture` binaries.

Python compile, helper/CLI build, receipt/hash consistency and diff checks passed.
Independent index correctness/race review is separate author/reviewer evidence;
this worker did not run CI, the full suite, push, native traffic or deployment.
Future acceptance still needs sustained and varied workloads, real-host limits,
owner-selected latency/error budgets and separate notification readiness proof.
