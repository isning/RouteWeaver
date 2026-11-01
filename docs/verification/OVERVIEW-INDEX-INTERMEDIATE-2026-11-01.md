# Intermediate owner-history index measurement — 2026-11-01

**Not final corrected-source acceptance.** This exact production `a4e2072` run
completed before independent review found that trigger-name-only validation did
not reject same-name no-op trigger replacements. The author is correcting exact
trigger-definition validation. Preserve this measurement, but repeat against the
corrected production commit before using it as final performance evidence.

Independent run used the retained `afb8b8a` harness on `a4e2072` production plus
harness/docs cherry-pick `4ecd81e`; `git diff a4e2072 -- internal cmd go.mod go.sum`
was empty. Root and author held large local jobs for a quiet reference window;
the shared host was not globally isolated. No production logic was modified by
the measurement worker.

The original 136 requests and 100,000 canonical ledger rows distributed across
25 loaded users are unchanged. One additional ordinary user with no history was
added; three probes per profile (six total) are separate from the 136 requests.
All 142 responses returned HTTP 200 with exact raw/provider/aggregate-weighted
usage. Added read-only SQLite dbstat inspection precedes HTTP measurements;
first-request numbers are not OS cold-cache measurements. No derived-table writes
or hostile-trigger probes were performed by this load harness.

| Metric, 100k-row profile | Earlier a26b9f9 | Intermediate a4e2072 |
|---|---:|---:|
| First loaded overview ms | 671.56 | 41.91 |
| Five warm overviews ms | 580.55–690.93 | 33.69–74.18 |
| 1-client p95 ms (2 calls) | 678.21 | 39.62 |
| 5-client p95 ms (10 calls) | 5,198.83 | 196.16 |
| 25-client p95 ms (50 calls) | 19,197.70 | 976.81 |
| 25-client stage elapsed s | 34.50 | 4.03 |
| 25-client stage CLI CPU s | 34.87 | 1.97 |
| Whole timed CLI peak RSS KiB | 437,220 | 73,336 |
| CLI startup/readiness s | 0.807 | 2.115 |

Pacing remains two calls/client with >=2 seconds between that client's request
starts, not a saturation test or the earlier 50-rps CRUD profile. Zero-history
account probes with 100k **other** rows returned exact zero in 2.34, 2.53 and
5.32 ms. Source differences include both the history index and the resumable
notification worker; do not attribute all RSS/latency changes to the index alone.
No production latency budget or supported user limit follows from this short run.

## Startup and disk tradeoff

Fresh 100k-row setup through the indexed public store took 44.64 seconds (sampled
CPU 44.55 s, max fixture RSS 22,292 KiB), versus earlier 30.52 seconds. Startup
rebuild cost is included in the 2.115-second CLI readiness measurement. Read-only
SQLite page allocation after startup:

| Object | Allocated bytes |
|---|---:|
| usage_history | 16,429,056 |
| sqlite_autoindex_usage_history_1 | 18,378,752 |
| usage_history_owners | 4,096 |
| sqlite_autoindex_usage_history_owners_1 | 4,096 |
| usage_history_state | 4,096 |
| **Total** | **34,820,096** |

The empty index occupies 20,480 bytes. The grown index contains 100,000 membership
rows, 25 owner counts, and one global state row; the extra empty account is proven
absent rather than receiving a fabricated nonempty membership. DB/WAL/SHM after
startup were 97,435,648 / 35,065,352 / 98,304 bytes. WAL includes rebuild/write
allocation and is **not** additional live logical index content. Earlier owned
DB/WAL/SHM plus startup logs was approximately 63.1 MB; file-size delta is not
exactly equivalent to live B-tree allocation or a retention forecast.

No sampled 512-MiB process or 1-GiB owned-data guard fired; request timeout remained
30 seconds, measurement watchdog 240 seconds, fixture watchdog 180 seconds.
GOMAXPROCS=1 and GOMEMLIMIT=256MiB are scheduler/soft Go settings, not hard limits.
The amended harness also checks resource bounds during readiness polling and
between logins, while the continuous 250-ms monitor covers timed requests. All
owned processes exited cleanly and temporary state was deleted.

Receipts: [aggregate run](evidence/OVERVIEW-INDEX-INTERMEDIATE-2026-11-01.json),
[source and binary hashes](evidence/OVERVIEW-INDEX-INTERMEDIATE-HASHES-2026-11-01.json).
The original baseline remains in `OVERVIEW-HISTORY-CAPACITY-2026-11-01.md`.
Python compile/diff checks and helper/CLI builds passed. No CI, publication,
deployment, native proxy, browser, real account or external traffic.
