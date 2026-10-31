# CI and package quality recovery — 2026-10-31

## Basis and scope

Implemented against recovered **WIP51 source v60**, locally initialized at `9094fe74545c48092e745e5cd2086b4625740fd1`. This is not the original WIP51 commit, recovered WIP52/53 source, or historical Git continuity. The following evidence covers the named local changes while the integrated worktree was being edited; final source-bound aggregate evidence must be recorded separately.

## Concrete improvements

- CI now separates source contracts, pinned secret scanning, backend/race, frontend, real HTTP API, Chromium, native and package jobs. The final aggregate rejects missing, failed, skipped or cancelled jobs. All external Actions retain full commit pins, checkout credentials are not persisted, and token permissions are read-only.
- Shared setup pins Node 24.22.1, reads Go from `go.mod`, caches both Go module lockfiles and the npm lock. Dependabot now includes the managed-runtime Go module.
- `verify.sh` exposes the same named local stages. Static verification includes pinned actionlint; secret-scanner regressions belong to the independent required secrets stage, not an optional static skip.
- The pinned Gitleaks wrapper scans current Git-visible files, index blobs and every reachable commit's blobs, without relying on text diffs. Actual-engine tests cover deleted/binary-attributed/merge-only/non-HEAD history, staged-overwritten and untracked source, prior broad-path exemptions, large and BOM-encoded content, redaction and failure-closed prerequisites. See `scripts/security/README.md` for the bounded scope and exact false-positive review policy.
- Package source manifests bind file content and mode plus actual Git identity. Ignored build-affecting source is not silently excluded; concurrent source mutation is rejected. Clean source is mandatory in CI. Go's implicit VCS stamps are disabled in favor of this whole-source manifest.
- Tar/gzip order, ownership, mode and timestamp are normalized. The package gate compares two builds on the same host/toolchain before smoke. Archive checksum/provenance and a separate hash-bound smoke receipt are emitted; rebuilding removes stale smoke success. No signing/attestation is implied.
- Extracted-package smoke uses disposable loopback state: static assets/login, missing-key startup rejection, non-demo source→collection→profile→publication, anonymous feed, process restart without bootstrap credentials, rotation and old-link denial, and clean teardown. It does not start Chromium, a core or node agent.
- Distribution notice collection now retains conventional `THIRD-PARTY-LICENSE`/`THIRD_PARTY_NOTICES` files unchanged (previously omitted). The inventory remains best-effort, not legal clearance.

## Recorded local checks

- **Static r3 passed:** 22 offline Python helper tests, architecture rejecting fixtures/import direction and actionlint 1.7.7. `bin/static-restored-r3.log` (local, ignored).
- **Actual Gitleaks regressions:** 22 tests passed; full current/index/reachable restored-history scan passed. This does not inspect unavailable historical WIP52/53 objects. Final staging/commit requires a rerun.
- **API-only real HTTP:** initial run 16/17 passed, one test created a separate context at the obsolete Vite origin. Corrected to use the configured base URL; rerun **17/17 passed, 5.5 seconds**. `bin/api-restored.log` and `bin/api-restored-r2.log` preserve the distinction. No Chromium/Vite was used.
- **Build:** control plane, agent, managed Xray and web production output passed.
- **Initial package and durable smoke passed** for an earlier dirty worktree, archive SHA256 `3965de2e7df1ed7b8148499c7f58810032c2ceaf75ab943538d56330c7d1eb10` (48,555,776 bytes). This deliberately is **not final combined-source acceptance**: later edits exist. Final clean-source double-build/smoke must supersede this scoped trial, not relabel it.
- Red→green helper evidence includes missing workflow gates, nondeterministic/unbound package scaffolding, ignored build-affecting source, operator-state manifest rejection, and omitted third-party notice filenames. Initial failures were fixed without reducing assertions.

## Remaining acceptance

No current-source full frontend, native-process, Chromium or remote GitHub Actions pass is claimed by this report. The coordinator owns the full aggregate and final clean-source package. Historical host security denials do not authorize retries with weaker sandboxing or privileges.

The initial installed-npm notice superset reported missing text candidates for `@rolldown/binding-linux-x64-gnu` and `@rolldown/binding-linux-x64-musl` 1.2.14. The package does not copy `node_modules` or these native bundler binaries. A production-dependency superset is not a precise bundle inclusion map; retain the warning for distribution review rather than inventing license text or compliance.

See [release gates](RELEASE-GATES.md) for the separation between mature repository delivery and operator-authorized deployment.
