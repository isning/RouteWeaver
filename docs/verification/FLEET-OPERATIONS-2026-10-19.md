# Fleet/change operation evidence, 2026-10-19

Scope: RW-15/K03 and RW-16/K01, local implementation only. See
[`internal/fleet/README.md`](../../internal/fleet/README.md) for the public contract.

## Verified slices

- Encrypted retained plans with explicit target/stage/version/assigned-user
  impact and redacted before/after configuration preview.
- One atomic per-target generation + desired + immutable manifest + attempt +
  audit transaction. CAS failure/serialization failure consumes no generation.
- Exact observation stage gates, partial failure history, request-key replay,
  failure-only retries that preserve successful targets, concurrent command
  rejection, enrollment replacement/revocation and tenant/anonymous denial.
- No-report lease expiry is unknown, superseded requests are distinct, historic
  success remains durable while current runtime state can independently change.
- Configuration rollback uses a new generation and current grants/credentials/
  account permissions. A revoked user's credential and another user's rotated
  old credential are absent; the current credential remains. Revocation after
  review prevents enqueue.
- Stop remains operable from the accepted package when the mutable draft is
  invalid. Only the owned scoped process is restricted.
- Official release catalog IDs and digest-bound installation evidence; no arbitrary
  archive URL. Upgrade envelope carries exact prior observed identity, new pinned
  version and executable digest. Same-version and uncertain-source upgrades fail.

## Commands executed successfully

- `./scripts/go.sh test ./internal/fleet ./internal/store ./internal/httpapi ./internal/controlprotocol ./internal/agent`
- `./scripts/go.sh test -race ./internal/fleet ./internal/store ./internal/httpapi`
- `./scripts/go.sh vet ./internal/fleet ./internal/httpapi ./internal/store`
- `./scripts/go.sh run ./scripts/check-architecture`
- `ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray ./scripts/go.sh test ./internal/httpapi -run TestNativeFleetConfigureStopStartAndRollback -count=1 -v`

The native test installs exact official Xray archives into immutable private paths
for two scoped targets, validates them without activating, configures native
processes, proves HTTP/SOCKS loopback traffic, stops and restarts both, applies a
reject-forwarding configuration, then restores traffic with a new-generation
historic configuration rollback. It checks that local success without a received
agent report is not control-plane success.

## Red-before-green and scope limits

Planner test first failed with no fleet implementation; transactional-generation
test first failed with the missing repository method. Historical-success test
failed when later shutdown erased earlier success; corrected by a durable
per-operation success archive distinct from current state. Invalid-draft stop test
failed because rendering blocked stop; corrected to reuse the accepted package.
Host grouping test failed before the validated fields were implemented. The first
HTTP compilation was temporarily blocked by an unrelated concurrent render edit,
not counted as a behavior failure.

Browser acceptance was not executed by this backend lane. Sing-box process
acceptance is restricted by the already-known host netlink denial and is not
claimed. The current upstream catalog has one version per adapter, so the API
old-version fixture is explicitly synthetic, and native upstream version-to-version
upgrade remains unverified. The installer worker separately owns immutable artifact
and actual process transition tests. No actual VPS, account or credential changes,
external publication or GitHub authorization were performed.

These findings are implementation evidence, not permission to mark RW-15/RW-16
or their prerequisites verified. Full feature evidence, browser acceptance and
independent standards/spec review remain delivery gates.
