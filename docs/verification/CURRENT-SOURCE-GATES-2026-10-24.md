# Current-source independent verification — 2026-10-24

**Outcome: five stages passed; web behavior failed one original-budget test. This is not an official quick/full pass.**

One authorized, serialized run used an exact private freeze of the post-layout source. It ran 06:00:30–06:27:44 UTC on 2026-10-24, without retries, instrumentation, source edits, or an outer web timeout. The runner exited **1**; its QA lock was released at 06:27:44 UTC.

## Native stage outcomes

| Stage | Native exit | Result |
|---|---:|---|
| Read-only Go formatting | 0 | Passed |
| Root Go vet | 0 | Passed |
| Root Go functional suite, **NONRACE** | 0 | Passed within the scope and skips below |
| Web typecheck | 0 | Passed |
| Full unfiltered web behavior | 1 | **1,138 passed / 1,139 total; one failed** |
| Web production build | 0 | Passed after the independent web failure |

Web completed **105 test files: 104 passed, one failed**, with zero pending and zero todo tests. The JSON reporter lists 123 suites including nested suites; that is not a count of files. Native reported duration was 1,296.53 seconds. No uncaught/unhandled-error section was reported in the terminal log; the JSON report has no dedicated unhandled-error field, so no separate zero-error count is inferred.

### Remaining web failure

- File: `web/src/server-review-revision.dom.test.tsx:232`.
- Test: `requires explicit reload and fresh consent when the saved path changes after opening`.
- Native failure: **`Test timed out in 10000ms.`**
- The reporter displayed 16,667 ms for the failed test. This does not change its configured 10-second deadline or establish the underlying cause.

The failure remains unresolved by this run. No targeted retry or timing change was performed. Earlier full-web and instrumented diagnostic failures remain historical evidence; this result does not overwrite them.

## Backend scope and skipped work

The root-module command was:

```sh
go test -json -p=1 -count=1 -timeout=20m ./...
```

It emitted **1,163 passing test/subtest events and 21 passing package events**, with **50 skipped test/subtest events and three no-test packages**. These are event counts, not 1,163 distinct top-level tests. The no-test packages were `cmd/control-plane`, `internal/auth`, and `internal/entrypolicy`.

The skip inventory retains optional native validators/binaries, archive installation and native process integration, explicit Unix-socket transport, real local procfs, and workload/scaling characterization. Those capabilities were not enabled and are not passes. Nested module `runtimes/xray` was not included by root `./...`; its separate vet/tests/build and a root Go build were not stages here.

**This was explicitly NONRACE functional verification. The historical full Go race failure, including its HTTP 30-second case, remains failed.** A nonrace pass cannot upgrade it or demonstrate race safety.

## Unchanged execution budgets and environment

- Go: original **20-minute per-package** budget, `-p=1`, `-count=1`; no `-short`, targeted filter, or race instrumentation. Existing test-specific budgets, including the HTTP 30-second budget, were unchanged.
- Web: one worker, retry zero, unfiltered configured inclusion patterns, default plus JSON reporters; original **DOM 10 seconds / Node default 5 seconds**, with existing explicit per-test budgets unchanged. No observer/profile hooks, external kill deadline, or automatic retries.
- Offline toolchain/dependency policy: Go 1.27.2; `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, `GOMAXPROCS=2`, `GOMEMLIMIT=768MiB`, and `GOFLAGS='-buildvcs=false -p=1'`. Existing dependency trees/caches were used; no installs or fetches were requested.
- `CI=1` and `ROUTEWEAVER_WEB_TEST_WORKERS=1`; existing timezone/locale variables were preserved. Private HOME, TMPDIR, and npm cache were intentional and recorded. Native opt-in variables were not inherited.

The production build retained Vite's warning about chunks exceeding 500 kB after minification; a successful build is not a performance assessment.

## Source and dependency provenance

| Identity | SHA-256 |
|---|---|
| Approved source manifest, 1,101 files | `fac668d031e3056eca0fcdcefdf720b9ab3a1b264e93778fd38139a494750cdf` |
| Full dependency boundary binding | `f475cca09b5936fba119e0f1706e008a20cd956f1839cfb0fe49730ac53928c0` |
| Approved runner | `b63f834264d8f5ca02c9e316f061c72736d5a2d068aa1d21a4bed35168f21e11` |

Canonical source and private frozen source were unchanged before/after every stage; package-lock/tool/link bindings also matched. Whole-gate dependency bytes matched at both boundaries: Node dependency entries 25,015; Go module entries 9,229; Go toolchain entries 15,657. This is bounded before/after evidence, not continuous dependency observation.

Source provenance excludes `.git`, `.local`, `bin`, `scripts/__pycache__`, generated `.tsbuildinfo`, and `web/{node_modules,dist,coverage,playwright-report,test-results,.vite,.vite-temp,.vitest,.vitest-cache,.cache}`. Dependency byte binding excludes generated `.vite`, `.vite-temp`, `.vitest`, `.vitest-cache`, `.cache`, and lockfiles; writable compilation caches/GOPATH are not immutable dependency evidence. Built assets were separately inventoried.

These hashes identify the tested pre-template-fix source. Later code or documentation integration changes the current tree's identity; this report must not be presented as an aggregate test of subsequent changes.

## Certification limits and retained evidence

The official tracked-private-files guard remains blocked by **NoGit**; no Git index was synthesized and neither official `scripts/verify.sh quick` nor `full` is certified. This run provides no browser/E2E, native-core process/liveness/traffic, deployed enforcement, or deployment certification. No native opt-in, traffic application, publication, or live-system change was authorized by it.

Evidence reference: `current-source-gates-proposal-20261024/approved-run-20261024T060015/` contains native logs, exact commands/environment, stage receipts, raw web JSON, Go outcomes, source/dependency manifests, and build inventories. The companion `current-source-gate-summary.json` contains the exact failure and full Go skip/reason inventory. These are workspace evidence references, not public URLs; this report does not embed raw logs or imply that those separate artifacts accompany every copy.

**Staging note:** prepared outside canonical source for review and later approved checkpoint integration. Preparing this report did not rerun verification or modify the tested tree.
