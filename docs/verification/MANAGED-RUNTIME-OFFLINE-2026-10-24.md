# Managed Xray adapter: dependency recovery and offline verification

## Result and scope

On 2026-10-24, an isolated copy of the current source passed the three official managed-adapter stages below, with only `runtimes/xray/go.sum` extended by 238 checksum lines. There were no checksum removals, changed existing checksums, `go.mod` changes, declared dependency upgrades, or compiler upgrades. The reviewed checksum-only change is now integrated alongside this report; runtime source and tests are unchanged.

| Command | Result |
| --- | --- |
| `scripts/go.sh -C runtimes/xray vet ./...` | Exit 0 |
| `scripts/go.sh -C runtimes/xray test -race -count=1 ./...` | Exit 0; adapter package 13.039s; command package has no tests |
| `scripts/go.sh -C runtimes/xray build ./...` | Exit 0 |

The run used Go 1.27.2, `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, `GOMAXPROCS=2`, `GOMEMLIMIT=768MiB`, and `GOFLAGS='-buildvcs=false -p=1'`. No test timeout was increased. The QA lock covered candidate preparation, execution, and before/after checks, from 2026-10-23 23:55:05 UTC through 2026-10-24 00:01:05 UTC. Canonical source, candidate source, module-cache contents (excluding lock files), and compiler hashes stayed unchanged during this run.

This establishes managed-adapter vet, race-test, and build results, not standalone native-process lifecycle, live traffic, deployed enforcement, browser coverage, or a complete quick/full-gate pass. No canonical runtime rerun is implied by integration.

## Why the earlier run failed

The earlier independent aggregate's managed vet/race/build stages stopped immediately because the selected offline cache lacked exact dependencies, initially reporting Xray v1.260327.0, x/time v0.12.0, and protobuf v1.36.11. `GOPROXY=off` was a reproducibility setting, not proof of network denial. Local inspection found 31 missing declared external modules; archived license copies were not recoverable module source.

An attempted supported permission escalation failed during runner initialization, before the command launched, owing to a restricted session-path mount error. That path was neither inspected nor modified, and the escalated runner was not retried. Subsequently, an authorized ordinary-sandbox request to the exact official proxy metadata endpoint succeeded. An authorized normal-sandbox download then used only `GOPROXY=https://proxy.golang.org`, without direct-VCS fallback, with `GOSUMDB=sum.golang.org` and `GOTOOLCHAIN=local`. No manual alternate-host route or network workaround was used.

## Checksum and integrity evidence

The isolated cache contains the original graph's exact 155 selected external module/version pairs. All 22 root and 36 external runtime declared requirements retain their versions. All 31 initially missing declared modules matched both original checksum fields: 62 matches.

The 238 runtime checksum additions have two distinct sources:

- 35 were already recorded in the canonical root `go.sum`.
- 203 were newly recorded across the canonical root/runtime checksum union and matched standard Go-fetched signed `sum.golang.org` lookup records. They are SumDB-attested graph closure, not previously recorded canonical attestations. Download used an explicitly configured checksum database; effective `GONOSUMDB` and `GOPRIVATE` were empty.

The official project `go mod verify` command **exited 1**, reporting only:

```text
routeweaver v0.0.0: missing ziphash: open hash: no such file or directory
```

The local replacement `routeweaver => ../..` resolved correctly. The installed verifier checks every selected graph module and collects all errors, but its cache-verification path did not exempt this true local replacement. All 155 external modules had their archives, matching ziphash records, extracted directories, and go.mod files present; none were absent and skipped as undownloaded. No external-module integrity errors were reported. This supports scoped external-cache integrity, while the original project verification command remains nonzero. It is not an aggregate `go mod verify` pass, and the Go tool was not patched.

## Evidence references

Evidence names below are relative to the retained verification evidence root; they are not deployment paths or a claim that raw external caches are bundled with source:

- `integrated-independent-resume-20261023T2215/05.log`, `06.log`, `07.log`: original offline failures.
- `managed-runtime-cache-proposal-20261023/`: exact missing-version/checksum manifest, runner failure receipt, and successful metadata receipt.
- `managed-runtime-cache-materialization-20261023/external-integrity-receipt.json`: scoped integrity and provenance.
- `managed-runtime-cache-materialization-20261023/runtime-go.sum-additions.diff`: exact additive checksum diff.
- `managed-runtime-offline-candidate-20261023/terminal-receipt.json`: three stage results and before/after invariance.
- `managed-runtime-canonical-integration-20261024/`: integration preimage, source manifests, and receipt.

Future offline gates must select the complete verified module cache recorded in the internal integration receipt; the previous partial cache remains insufficient. No machine-specific cache path is embedded in this portable report.
