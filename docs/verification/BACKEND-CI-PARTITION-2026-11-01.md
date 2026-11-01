# Backend CI partition

The single 45-minute backend job in run 41337032895 completed root race tests,
root build and managed-module vet, but timed out during managed race compilation.
This change separates complete package suites; it does not relax application
limits, package test timeouts, assertions or native requirements.

## Required gates

`backend` retains its job ID and check name, **Control plane, agent and managed
runtime**. It always runs and accepts only the exact five successful dependencies.
The unchanged top-level `verify` aggregate requires this backend aggregate.
Missing, failed, skipped and cancelled shards fail closed.

| Shared verify.sh stage | Scope | Job bound |
| --- | --- | ---: |
| backend_core | formatting, root vet, all non-heavy package race tests, root build | 30 min |
| backend_backup | complete internal/backup race suite | 35 min |
| backend_httpapi | complete internal/httpapi race suite | 35 min |
| backend_store | complete internal/store race suite | 35 min |
| backend_managed | runtimes/xray vet, complete race suite, build | 30 min |
| backend aggregate | exact successful dependency set | 5 min |

Root race calls retain `-race -p=1 -count=1 -timeout=20m`; managed retains
`-timeout=10m`. Job bounds include cold setup/compilation and are not application
or per-package test deadlines. `backend`, `quick` and `full` still compose the
complete backend contract. `managed` remains the separate native integration gate.

`go list ./...` supplies the actual root-module inventory. Each invocation checks
that all three heavy packages exist. All remaining packages, including future
packages and a future module-root package, default to core. Duplicate, empty,
foreign-module and incomplete inventories fail. No test-name filters are used.
On the base candidate, the inventory is 26 packages: 23 core and three heavy.

## Cost and timing envelope

All other jobs are unchanged. Counting the four browser matrix executions, the
whole workflow declares at most **425 runner-minutes**, including both aggregates.
At the coordinator's supplied $0.006/min rate that is **$2.550** compute maximum;
prior $1.086 compute plus this bound is **$3.636**, leaving **$1.364** of the $5
round cap for artifact storage and margin. Seven-day artifact retention is
unchanged. This is a declared compute envelope, not a provider billing quote.

Previous heavy-package test durations were approximately backup 9 min, HTTP API
15.4 min and store 12.4 min. Parallel shards remove their serial sum from a single
job deadline. Cold builds are duplicated, and new tests increase runtime: a
planning estimate is 110–150 total runner-minutes ($0.66–$0.90) and roughly
30–40 minutes wall-clock with available runner concurrency. Managed cold timing
and the new candidate's actual duration are unverified until CI; the bounded
425-minute cost calculation, not this estimate, is the spending reservation.

## Local evidence and limits

- Offline fixtures execute `verify.sh backend` and the five independent stages
  against a recording Go executable: the complete command sequences match,
  every inventory package is tested exactly once, format/vet/build remain, and
  failed inventory/test commands cannot print a pass.
- Negative aggregate fixtures reject every missing/cancelled/skipped/failed shard.
- Actual package inventory and pinned actionlint pass.
- Static gate passes (helper tests, architecture checks and pinned actionlint).
- No large Go suites, native processes, browser runs, remote CI or publication
  were executed for this change. Parent review and exact-source CI remain needed.
- AGENTS.md was read. Its pinned skill directory was absent; attempted official
  pinned reference retrieval returned no content, so no skill-read claim is made.
