# Bounded managed dependency maintenance — 2026-11-01

Base: `0f3cc5ee699a4cbc9d261276c4c4437a770ea961`. This supersedes the
remaining-dependency disposition in the compiler-only review, not its historical
results. Linux/amd64, Go 1.27.3. No deployment or stock-core change.

## Actual dependency fixes

- Both modules: `golang.org/x/net` 0.60.0 → 0.62.0 fixes
  [GO-2026-6860](https://pkg.go.dev/vuln/GO-2026-6860) and
  [GO-2026-6866](https://pkg.go.dev/vuln/GO-2026-6866).
- Managed module: `github.com/klauspost/compress` 1.17.4 → 1.18.7 fixes
  [GO-2026-5841](https://pkg.go.dev/vuln/GO-2026-5841), malformed s2 dictionaries.
- Managed module: `google.golang.org/grpc` 1.79.3 → 1.83.2 fixes
  [GO-2026-6061](https://pkg.go.dev/vuln/GO-2026-6061),
  [GO-2026-6348](https://pkg.go.dev/vuln/GO-2026-6348),
  [GO-2026-6441](https://pkg.go.dev/vuln/GO-2026-6441) and
  [GO-2026-6443](https://pkg.go.dev/vuln/GO-2026-6443).
  The last advisory also affects 1.83.0–1.83.1, so 1.83.1 is insufficient.
  grpc requires genproto/googleapis/rpc 20260526163538-3dc84a4a5aaa; that
  transitive update is included. No unrelated dependency sweep or npm change.
- Updated managed linked-module notice inventory and copied changed dependencies'
  upstream license/notice files unchanged, including nested notices. Existing
  source retrieval/checksum instructions and Xray MPL/source identity remain.

## Xray pinning: closed capability, not a patched base

[GO-2026-6651](https://pkg.go.dev/vuln/GO-2026-6651) remains in the unchanged
`github.com/xtls/xray-core v1.260327.0`. The
[upstream advisory](https://github.com/XTLS/Xray-core/security/advisories/GHSA-5wf9-h793-w73c)
requires a CA pin and a missing certificate-verification name. It identifies
Hysteria and gRPC dialers that omit destination-derived names. Those transports
are rejected by the managed profile, but this alone was not sufficient evidence
to claim pinning safe: the TCP dialer also has a dynamic `fromMitm` name branch.

This change rejects **any explicit `tlsSettings.pinnedPeerCertSha256`** on managed
inbounds and outbounds before native construction, including case-insensitive
JSON spellings, empty strings and null. Root renderer/domain have no modeled certificate
pinning field; generated ordinary TLS configs do not change. A hand-authored
managed config using pinning is now intentionally rejected, never silently
weakened. It must migrate to ordinary verified TLS before a new activation.

The guard is covered at public `managed.Validate` and directly at `New` for both
directions and spelled-case variants; original `config.go` supplied through Go's
`-overlay` fails the new test, and the guard passes it. Separate negative tests
exercise gRPC/Hysteria ingress/egress and API/reverse paths. Existing real native
TCP/TLS and mux payload tests remain positive. This is a precise supported-profile
mitigation, **not** removal of vulnerable upstream code or a universal exploit proof.

No Xray base upgrade is needed to close this product capability under the stated
profile. Future support for pinning requires a fixed upstream base (official
26.7.11 or later), explicit ABI/config review, new descriptor/runtime identity,
journal ownership and recovery/stop compatibility, and destination/mux/accounting
regressions before rollout. This patch changes none of those identities, journal
formats, receipt history, meter versions or private-destination semantics.

## Reproducible scan result and residuals

`govulncheck` v1.9.0, Go 1.27.3, default Linux/amd64 tags, **source/symbol scan,
without tests**, official DB timestamp **2026-10-27T21:16:18Z**:

| Module | Unique advisory IDs | Disposition |
| --- | --- | --- |
| Root | GO-2026-5932 | OpenPGP module-only; command dependency lists import no OpenPGP package. No fixed version exists for the unmaintained package; it is not used. |
| Managed | GO-2026-5932, GO-2026-6651 | OpenPGP module-only; Xray advisory is module-wide and emits 159 package and 1,940 symbol records as well as its module record. Pinning capability is rejected as above, not filtered from the scan. |

Seven of nine managed advisory IDs and two of three root IDs are removed by
actual fixed dependency versions. Do not call either graph “zero findings”.
The module-wide Xray records cover many unrelated symbols; neither that broad
static trace nor the JSON-mode exit code proves exploitation or its absence.
Summary JSON records retain scanner config, raw-result SHA-256, counts and example
traces; complete raw results are retained in the workspace evidence directory.

## Verification scope

Evidence in `managed-dependency-maintenance-20261101/`:

- Managed `go test -count=1 ./...`: passed; native TCP/TLS/mux, rate/revocation,
  private destinations, diagnostics, counter/journal and command tests. No Skip
  calls exist in these managed test files.
- Focused race-enabled managed tests passed for pin/profile rejection, native
  TCP/TLS/mux, runtime reconstruction and journal behavior. The command package
  had no matching tests in this filtered race run (its full normal suite passed).
- Root render package full tests passed, then focused managed/journal/TLS tests
  for render/entrypolicy/agent passed. Entrypolicy has no test files. The first
  command mistakenly named nonexistent `internal/agentcore`; its setup failure
  was corrected to `internal/agent`, not counted as a pass.
- Original-source overlay pinning regression: fails as expected; changed source
  succeeds as part of the managed suite.
- Both modules passed `go vet ./...` and `go build` (root all packages; managed
  command rebuilt with `-trimpath -buildvcs=false`). Build information records
  exact selected versions and Go 1.27.3.
- Rebuilt managed executable passed the actual child broker-EOF lifecycle test:
  live payload stopped and the owned process persisted its 44-byte final journal.
  Meter cursor, managed retirement/reopen and withdrawn receipt tests passed.
- A separate **simulated historical managed journal** contains settings rejected
  by a deliberately stricter checker. Reopen/Recover preserves observation and
  identity; new activation is rejected; owned stop succeeds without re-validating
  old configuration. This fixture proves journal-policy behavior, not launch of
  an old vulnerable executable. Real child ownership/EOF is tested separately.

Independent review found no blocker: 24 cases compared the actual upstream
configuration decoder with public Validate/New (duplicate/nested/null/empty and
ASCII, escaped and Unicode aliases); ordinary TLS remained positive. Selected
MVS versions and all 17 new license/notice files were independently verified
against source bytes. Review matrix source/log are retained alongside this note.

These focused checks do not replace coordinator-owned exact-commit full CI,
all-platform acceptance, or the separately running reference-duration test. No
host setting, real credential, live node, external target or deployment changed.

## Follow-up: exact checksum false-positive and permanent regression

Whole-history scanning of the maintenance commit exposed a `generic-api-key`
match on the oauth2 0.36.0 module zip checksum in `runtimes/xray/go.sum`.
The exact source line was independently matched to the
[official Go checksum database lookup](https://sum.golang.org/lookup/golang.org/x/oauth2@v0.36.0)
and `go mod download -json` Sum metadata. Verification URL, lookup digest and
source-line digest are retained in `oauth2-verification.json`; the review does
not infer that arbitrary h1-shaped text is safe.

The existing false-positive mechanism gains only that path/rule/exact-line hash.
Scanner regressions prove a modified line at the same path and the same original
line at another path are still rejected. No broad go.sum exemption, scanner-rule
change or history exclusion is added. The independent 24-case decoder matrix is
now a permanent test in `runtimes/xray/config_test.go`, not merely an overlay
artifact. Source/index/history scanning is rerun after this correction; logs
record actual terminal results, not the earlier pre-maintenance pass.
