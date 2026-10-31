# K04 node observation and provider allowance slice

Date: 2026-10-19. Scope: resource observation, explicit provider IN+OUT allowance configuration/reconciliation, and K05 allowance-notification source. This is not a claim that all K04/K05 diagnostics or live operations are complete.

## Implemented

- `internal/observability`: pure identity/report/configuration models and continuity, CPU interval, selected-NIC IN+OUT, finite/unlimited allowance, baseline and provider-statement calculations. Imports only the domain layer, not the transport protocol, SQL, HTTP, OS or engine SDKs.
- `internal/agent/node_observer*.go`: bounded Linux procfs reader with synthetic filesystem seam; observer stream/retry behavior; authenticated HTTP transport implementation. CLI `--observe-node` is opt-in, and driver collection uses the network worker rather than the runtime mutation or lease lane.
- `internal/store/node_observations.go`: encrypted persisted snapshot/configuration/baseline/statement; same-transaction observer-host/enrollment recheck; SQLite write reservation before read-modify-write across all mutation methods and separate Store handles.
- `internal/httpapi/node_observations.go`: designated-observer ingest and admin-only read/configure/baseline/provider-statement endpoints. Existing notification refresh and background dispatch evaluate only a fresh, current, complete explicitly configured source. Notification text distinguishes NIC estimates from operator-entered provider statements.
- Frontend is a separate implementation lane consuming these real endpoints; its verification is reported separately.

## Observable invariants

A physical node has one designated observing core, not one node report per runtime family. All NIC names/counters remain visible but only explicit provider-facing NICs count. Loopback/container selections are refused. First CPU utilization and unestablished provider remaining allowance are null, not zero. Replays are idempotent; conflicting duplicates/out-of-order reports are rejected. Gaps, restart, interface reset/disappearance and cycle-boundary ambiguity invalidate NIC-baseline completeness. Provider statements never derive from user/route accounting or multipliers. A missing reset cycle is not invented, including for unlimited providers.

Finite units are explicit decimal GB/TB or binary GiB/TiB (or bytes); cycle boundaries are explicit. Partial observations are advisory, not a fabricated full/zero remaining budget. There is no provider-driven automatic route/exit switch or runtime restriction. A provider portal value is explicitly operator-entered, not a claim of fetched authoritative data.

## Red-before-green evidence

1. Initial pure snapshot test failed with no production package; implementation then passed and proved first CPU/remaining null and 2 TB = 2,000,000,000,000 bytes.
2. Procfs collector seam failed to compile before the collector existed; it then passed known CPU/memory/load/NIC literals, guest exclusion, malformed/missing data and bounded-read negatives.
3. Persistence seam failed before repository methods existed; after implementation it passed duplicate ingestion, observer scope and reopen persistence.
4. Root review identified that the first store implementation protected only one handle. New `TestNodeObservationWritesSerializeAcrossStoreHandles` failed with both same-revision writes succeeding. After the SQLite write-reservation transaction fix, it passed repeated cross-handle CAS, exact retry/delta counting, concurrent baseline+statement preservation and revoked-enrollment fencing.
5. `TestUnlimitedProviderDoesNotRequireInventedResetCycle` failed because unlimited mode required cycle dates; after the targeted correction it passed without a numeric limit or invented reset period.

## Final verification

Passed on the final files:

- `scripts/verify.sh static`: private-file exclusion, ticket traceability and negative fixtures, architecture negative fixtures and production import direction.
- `scripts/go.sh test ./internal/observability ./internal/agent ./internal/store ./internal/httpapi ./internal/notifications ./cmd/node-agent`
- `scripts/go.sh test -race ./internal/observability ./internal/store ./internal/httpapi ./internal/agent -run 'Test(Node|Provider|DriverCollects|Replay|Config|Cycle|Unlimited)' -count=1`
- `ROUTEWEAVER_LOCAL_PROCFS=1 scripts/go.sh test ./internal/agent -run '^TestLocalProcfsResourceReadOptIn$' -count=1`

HTTP tests verify administrator/tenant/anonymous authorization, enrollment replacement, cross-host configuration rejection, two enrolled cores on one physical node, unknown initial values, baseline digest conflict, separate provider statement, notification delivery, and the actual `RunDriver` → synthetic procfs → HTTP transport → encrypted repository path.

The optional real read touched only this cloud execution environment's local procfs. No user VPS, provider account, external credentials, OS/network settings, runtime enforcement, real subscription traffic or public deployment was used. An intermediate full-suite failure coincided with the runtime worker's intentional zombie-liveness red-test window; the corrected final full relevant suites pass.

Root independently inspected calculation/parser semantics and found the cross-Store atomicity issue above, which was fixed with failing-then-passing evidence. Broader full-harness, browser and production operational conclusions remain the parent integration review's responsibility.
