# Frontend CI runtime and complete-shard verification

## Scope and cause

The unsharded frontend job for `df1ff56` (job `130812547424`) was cancelled near its 20-minute job limit. Its log records behavior tests from 21:53:22 to cancellation at 22:13:07 UTC on 2026-11-11, with no assertion failure, final test summary, or production-build completion. This was not a passing frontend gate.

Local implementation commit `09a4db8` was published with the same source tree as `2f5291ba3fbc419d90d7d2963d9094af77056cd2`. The existing `web` job now uses two native Vitest shards. Each retains the 20-minute limit, one worker, file isolation, typecheck and production build. No assertions or test files are omitted. Matrix `fail-fast: false` retains both results; the required repository aggregate still depends on `web` and rejects a failed, skipped or cancelled matrix. Both entries must succeed.

## Coverage and failure checks

`node scripts/check-web-shards.mjs` uses the installed Vitest discovery and configured sequencer, rather than a second handwritten glob/hash algorithm. On this source it verified all 343 files exactly once across 172 + 171 files. Tiny real CLI fixtures independently verified disjoint complete execution and assertion-failure propagation in both shards. `vitest list --filesOnly` ignores shard selection and is deliberately not used as partition evidence.

The shell contracts cover shard validation, unsharded defaults, preservation of typecheck/build, propagation of failures, and rejection of partial web selection in `full` and `quick`. The combined web, CI-aggregate and browser-shard regression command passed 23 tests. Independent source review and a separate execution of the helper found no remaining blocking findings. Bash syntax and `git diff --check` passed. Local actionlint was unrun because no Go compiler or actionlint binary was available; the existing CI static/actionlint gate was preserved.

## Actual execution evidence

Both local shards ran sequentially against `09a4db8` and exited zero, including typecheck and production build:

| Shard | Passing files | Passing tests | Vitest duration |
| --- | ---: | ---: | ---: |
| 1/2 | 172 | 2,197 | 566.95 seconds |
| 2/2 | 171 | 1,976 | 540.23 seconds |
| Combined | 343 | 4,173 | 1,107.18 seconds, sequential |

These are Vitest durations, not complete job wall times. Session-local evidence: `/tmp/rw-frontend-shard-results.json`, `/tmp/rw-frontend-shard-1.log`, and `/tmp/rw-frontend-shard-2.log`. These temporary files are not durable repository artifacts. The local minimal reporter emits no per-file completion lines; silence before the final summary alone does not establish a stalled run.

For published commit `2f5291ba3fbc419d90d7d2963d9094af77056cd2`, [repository workflow run 43112451115](https://github.com/isning/RouteWeaver/actions/runs/43112451115) reports both frontend entries successful, including the partition preflight and web gate:

- [Frontend 1/2, job 130831748145](https://github.com/isning/RouteWeaver/actions/runs/43112451115/job/130831748145).
- [Frontend 2/2, job 130831748111](https://github.com/isning/RouteWeaver/actions/runs/43112451115/job/130831748111).

At this observation, backend backup, backend HTTP API and native verification were still in progress. This document establishes frontend completion only, not a successful required repository aggregate, deployment, or acceptance of all product stories. Future suite growth can require renewed budget measurement.

## Reproduction

Run from the repository root with locked dependencies installed:

```sh
node scripts/check-web-shards.mjs
PYTHONPATH=scripts python3 -m unittest scripts/test_web_shards.py scripts/test_ci_gate.py scripts/test_browser_shards.py
ROUTEWEAVER_WEB_SHARD=1/2 scripts/verify.sh web
ROUTEWEAVER_WEB_SHARD=2/2 scripts/verify.sh web
```

Each shard reports partial scope. For the unchanged complete local frontend gate, use `env -u ROUTEWEAVER_WEB_SHARD scripts/verify.sh web`. `full` and `quick` reject a nonempty `ROUTEWEAVER_WEB_SHARD` rather than claiming a partial suite is complete.
