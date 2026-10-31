# Original large HTTP backup fixture: non-race comparison

One unchanged `TestBackupMultipartLargeArchiveAndEndpointDeadlines` passed on current source with **no race instrumentation**: test12.66s, native package12.701s, runner26.305s. Exit0; finished2026-10-24T02:34:19Z.

Command: `bash scripts/go.sh test -p=1 -count=1 -timeout=20m -run '^TestBackupMultipartLargeArchiveAndEndpointDeadlines$' -v ./internal/httpapi`.

Preserved300 large ledger records, >16MiB fixed-length archive,30s endpoint duration,50ms ordinary deadlines, all original sleeps/assertions and scrypt workFactor18. Compiler go1.27.2 linux/amd64; GOMAXPROCS2,GOMEMLIMIT768MiB, GOFLAGS=-buildvcs=false -p=1, original writable Go caches, offline module resolution and no row override. Native20m timeout unchanged; no automatic retry.

Passed the complete real encrypted journey: export Content-Length/completeness, preview manifest and300ledger count, unexpected-part400, restore201 to a new nonactivated store, exact last-record integrity and replay409. Current export policy reserves an error-only write allowance but tightens successful downloads to originalD before200; this run exercised that actual successful path without extending its deadline.

Source/test/docs hashes and modes remained identical before/after (generated/tool trees explicitly excluded in receipt). Key source bindings:

- `internal/httpapi/backup_stream_test.go`: `ce7bec6c8d2b80317636aa67b837c1b798aec6137cd7e61a118a10829fadffb8`
- `internal/httpapi/backup.go`: `bc17deaffa29b13c1462eb77a20199724e08c8e4f15e3d4f571b1f5c17435720`
- `internal/backup/backup.go`: `3d4ac2852c50b745a6af917e3b8a92cae0e406c8134a9edc47ed54183a58c0f7`
- `internal/backup/stream.go`: `0f61f184a97aa9ef09777923df1ee5a40304ab481c7b1be280bad397b4566847`
- `internal/store/backup_stream.go`: `0f94dea4a5ded5c0e45f56cf9aea770c724dbebe16bbbc737a3579b84072fabc`
- `go.mod`: `fc7cd5eed929e749b4ac5a6ec7efa17c561065dd121d964c46e1bf9f995afb78`
- `go.sum`: `e9607da6f8871b23a16810f88c0cf0031ee7f003e129c99585888ea5cbccf897`

Historical race-enabled30s attempts failed with initial export EOF and remain failed, with original fixture bytes unchanged. One diagnostic bracketed age.Encrypt at29.18s before validation deadline expiry and error-write timeout; it was not a pure KDF profile. Later error-delivery changes do not retroactively pass those attempts. No additional race/full backup run was performed here.

This single non-race pass is not a race-gate/full-aggregate pass, a production/default10minute SLO guarantee, stable speedup measurement or proof that the race detector alone caused failure. No ratio or causal attribution is warranted across different source versions/modes and one observation. No gate, fixture or security weakening follows from the result.

Evidence: backup-current-http-acceptance-20261024/nonrace-comparison/{receipt.json,http-original-acceptance.log,canonical-before.json,canonical-after.json,run.py}; historical original and phase results remain alongside it.
