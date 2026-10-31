# Node-agent runtime and outbound driver

This package is the local runtime/application seam, separate from `internal/render`. Shared wire values and integrity helpers live in pure `internal/controlprotocol`; the HTTP API must not import agent execution code. It is not a production deployment approval. Its registry keys are open adapter IDs plus exact versions, not a two-value engine enum.

## Implemented behavior

- One private state directory per enrolled node/instance/epoch, exclusive process lock, fsynced atomic journal replacement and durable highest-accepted generation.
- Immutable desired payload binding: lower generations are rejected; same generation with a different payload conflicts. A successful retry returns the existing observation, never repeats activation. A failed attempt remains failed; retry with revised intent requires a new generation.
- Private staged artifact files, path/digest/size checks, native validation before switching an active symlink, and explicit desired versus observed identities. State returned to callers contains no artifact bytes.
- A single serialized mutation lane including restart recovery and policy restrictions. Unknown native completion prevents the next mutation until actual quiescence/identity can be observed. Restart does not optimistically replay a pending activation.
- A known **not-applied** failure can restore the uncommitted file pointer. A deployment rollback is a new generation with an explicitly selected old artifact and current authorization. Atomic file pointer replacement is not atomic process replacement or a distributed transaction.
- Bounded native command execution without a shell, clean environment, exact runtime-version checks, capped output, timeout and stable-handle cancellation. Native error output is not exposed because it can contain secrets.
- `PolicyLease` checks access permission, quota certainty, explicit validity duration and observed clock rollback. Accepted denials supersede old allowed leases. Unknown first activation is still restricted on expiry. The stock process restrictor stops its whole owned instance; it is not per-account native session revocation. The separately identified managed Xray adapter adds the per-account enforcement path described below; stock adapters do not inherit it.
- A bounded durable meter outbox with explicit source/counter epoch, subject/route/policy/cycle attribution, decimal-string counters/sequences, digest-bound ordered ACK, restart replay and duplicate-last-ACK idempotency. It reports raw cumulative evidence, not quota debits. Limits: 128 pending batches, 1,000 samples/batch, 1 MiB/batch, 8 MiB total serialized outbox. Full queues reject collection rather than silently drop evidence.
- Concrete outbound HTTP transport: operator-supplied scoped bearer, node/epoch headers, verified TLS, redirects disabled, no ambient proxy, strict response decoding, 12 MiB body bound, finite context-aware backoff, idempotency keys for POSTs and meter receipt integrity checks. Literal loopback HTTP requires explicit test opt-in. No insecure-TLS mode exists.
- `RunDriver`: desired poll → reconcile → report; durable meter drain → exact ACK; independent lease timer unaffected by slow control-plane requests; bounded session by default or explicit continuous foreground mode, and cleanup on cancellation. Serialized bounded re-observation occurs before each outbound report and on the lease timer, including previously conformant runtimes. No network request happens merely by importing the package or starting the default fixture CLI.

## Exact native envelope

The checker paths are source-verified and executable versions are checked on every validation:

- Xray **26.3.27**: `version`; `run -test -format json -config FILE`. [Pinned source](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/main/run.go).
- sing-box **1.14.3**: `version -n`; `check -c FILE`. [Check implementation](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/cmd/sing-box/cmd_check.go), [flags](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/cmd/sing-box/cmd.go).

`NativeChecker` is validation-only. `ProcessSupervisor` is a separate explicit local opt-in: Xray `run -format json -config FILE`, sing-box `run -c FILE`. [sing-box run source](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/cmd/sing-box/cmd_run.go).

The supervisor starts direct child processes from explicit trusted executables and staged files. It observes Linux boot ID, PID, start ticks, resolved executable and process-group identity. Stop opens a **pidfd before final identity verification**, then signals only that stable leader, not a reusable PID/group. Unknown descendants block reconciliation, including leader exit/cancellation during startup grace; a direct child exit does not establish group absence. No service manager, host route, TUN, firewall or cgroup is modified by the supervisor. The supplied native configuration must itself be trusted and appropriate for the execution environment; this is not an OS sandbox for arbitrary native files.

`Descriptor.NativeValidation` describes native checking separately from observation evidence:

- `local_fixture_only`: actual atomic local files, not a native core or network.
- `native_check_only`: exact core accepted syntax/construction; not applied.
- `owned_process_liveness`: the agent's owned process is alive at its verified identity; not proof of egress, throughput, per-account limits or correctness of arbitrary routing.

The package trusts an explicitly supplied binary path. `scripts/native-cores.sh` additionally verifies release-pinned executable SHA256s before labeling repository native tests passed.

## Managed account enforcement

`routeweaver/managed-xray@26.3.27-rw1` is a separate executable embedding the
unchanged pinned Xray module, not a capability of stock Xray or sing-box. Its
positively tested Linux-amd64 entry envelope is authenticated VLESS raw TCP,
optionally TLS, with TCP payload and independent native mux streams. Vision,
REALITY, UDP and other entry protocols/transports are rejected, not silently
weakened. See `runtimes/xray/README.md` in the repository, or `MANAGED-XRAY.md`
in the application package, for the exact profile and destination policy.

The agent supplies inherited private pipes and exact immutable principal/route
bindings. The control plane transactionally admits account-global normalized IPs
and logical streams across entries, and reserves weighted quota before granting
absolute per-presence raw-byte ceilings. The runtime enforces those ceilings,
selective account revocation and a shared upload-plus-download rate bucket per
account × logical entry. Per-account leases last at most 30 seconds and renew at
most every 10 seconds; local monotonic expiry interrupts payload independently
of slow polling. Authority loss cannot create new grants or extend the last valid
lease/budget. This is bounded enforcement, not instantaneous global revocation.

The managed runtime emits binding-attributed cumulative counters with genuine
zero baselines and a final snapshot after quiescence. The agent durably spools
these through the existing exact-ACK meter outbox. Admission-budget counters are
observations, not a second quota debit. There is no per-byte native WAL: a crash
can leave unacknowledged bytes and unresolved reservations, which remain held
for explicit reconciliation rather than being automatically refunded. Provider
NIC/statement accounting remains separate from admitted user payload.

Real local CP → scoped agent → private pipes → native ingress/transit tests cover
published principals, TLS, shared finite quota, group-derived policy and TCP/mux
stream caps. Independent Store and child-process tests separately cover atomic
last-IP/last-stream/last-byte claims; these are not native traffic or exhaustive
multi-control-plane proofs. Exact reports are `GROUP-AND-CONNECTION-LIMITS-2026-10-19.md`,
`MIGRATION-RESERVATION-REVIEW-2026-10-19.md` and `integrated-8685726/README.md`, under
`docs/verification/` in the repository or `verification/` in the package. The
packaged quickstart links these records. No real VPS or sustained-load capacity
acceptance follows from them.

## Outbound wire contract

All requests bind one scope, derive the instance from that scope and carry `Authorization: Bearer …`, `X-RouteWeaver-Node` and `X-RouteWeaver-Enrollment`.

- `GET /api/agent/instances/{instanceId}/desired?after={generation}`: raw `Desired` JSON, or HTTP 204 when unchanged.
- `POST /api/agent/instances/{instanceId}/observations`: raw redacted `State`; HTTP 200/204 receipt. Reporting does not manufacture application success.
- `POST /api/agent/instances/{instanceId}/meter-batches`: raw `MeterBatch`; exact `MeterReceipt {streamEpoch,sequence,digest}` after durable acceptance.
- POST `Idempotency-Key` is SHA256 of the exact immutable request bytes. The server must bind/deduplicate that key and authenticate the scope independently of these headers.

No user-session credential is implicitly reused as an agent token. Tokens are neither created nor persisted by this package. Actual enrollment, external credentials and deployment remain separately authorized operational work.

## Verification evidence (2026-10-19)

Run local seams, CLI and race tests:

```sh
scripts/go.sh test -race ./internal/agent ./cmd/node-agent
scripts/go.sh vet ./internal/agent ./cmd/node-agent
```

Pinned native checks and selected real runtime fixtures:

```sh
ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores \
ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray \
scripts/go.sh test -race -v ./internal/agent
```

Executed successfully in this workspace:

- Xray and sing-box native parse checks with exact binaries.
- Fixture executable exact-argv/version-mismatch/timeout/output-limit/error-redaction tests.
- Fencing, same-generation conflict, serialized late activation, restart/lost-ACK recovery, known-not-applied pointer restoration, fresh-generation rollback, scope/path/digest/drift checks, clock rollback, denial/expiry restriction (including unobserved first activation), private summaries and exclusive-writer tests.
- Durable meter sequence/receipt/restart tests; outbound TLS/auth/scope/retry/redirect/strict-JSON tests; full synthetic TLS desired → reconciliation → observed report → meter ACK driver test; slow-control-plane lease-expiry test.
- **Real Xray** process start, observe, restart/recover, generation replacement and verified cleanup.
- **Real Xray two-hop loopback SOCKS**: fixture-authenticated client → owned core A → owned core B → local TCP echo. Stopping B makes a fresh flow fail rather than silently bypassing it. These smoke configurations are handwritten runtime fixtures, not evidence about the server renderer or complete product deployment path.
- **Separately joined managed CP/native path**: `TestNativePublishedManagedPrincipalEndToEnd` provisions principals through the real local API, applies immutable rendered artifacts through the agent, and measures actual native payload and exact quota settlement, including packaged TLS and group/stream limits. The integrated managed gate also covers selective principal paths and broker-EOF shutdown/final journal. This is stronger than the handwritten stock smoke fixture, but still not real-VPS acceptance.

**Blocked, not passed:** sing-box actual `run` in this workspace fails before listeners with `initialize network: create netlink socket: operation not permitted`. Native `check` does pass. No privilege/network-setting bypass was attempted. Select sing-box runtime tests only in a permitted environment using `ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray,sing-box`.

**Unrun:** real VPS installation, public network paths, production enrollment/credential issuance, external control-plane/node connectivity, sustained-load capacity and broad OS/host failure injection. Real local CP/native enforcement and bounded store performance characterizations have run; neither is a production deployment, a fleet SLA or a formal proof.

## Release gates and explicit limitations

1. Authenticate and scope production enrollment, token/certificate lifecycle and operator-supplied endpoint identity; exercise the production CP/agent wire lifecycle under security review. The tested real local CP/agent lifecycle uses synthetic credentials and does not establish production enrollment.
2. Measure supported native configuration, reload/restart downtime, process startup readiness and end-to-end route probes. A process alive for a startup grace period may still fail later. The driver observes/restricts locally; it does not assert arbitrary services are healthy.
3. Isolated sing-box runtime evidence is blocked here. Verify it in a permitted environment before enabling that target for production.
4. Durable launch intent is recorded before spawning. A crash between spawn and completed PID journal leaves an explicit unknown/pending record, not permission to spawn another core. Parent-death signaling limits direct-child survival but is not a proof covering all OS crashes or descendants. Resolve the birth window and descendant model before production supervision.
5. Private local POSIX storage, working fsync/atomic rename/locking, Linux `/proc`/pidfd availability and a trusted binary/root are assumptions. Network filesystems, administrator out-of-band edits, disk corruption, process-ID identity guarantees across hostile OS behavior and unbounded artifact retention are not solved.
6. Stock Xray/sing-box process supervision supplies whole-instance restriction, not managed per-account termination or quota enforcement. The managed adapter has positive native per-account revoke, local expiry, shared rate and finite-ceiling evidence within its explicit VLESS TCP/TLS envelope. Its at-most-30-second leases are distinct from the configured instance `PolicyLease`. Production enforcement latency, reboot/clock behavior and the wider OS/crash envelope still require acceptance; no unlimited offline authorization or instant fleet-wide effect is claimed.
7. The managed adapter has an actual attributed native counter/journal path and authoritative CP account-global IP/stream admission; stock adapters do not gain those capabilities merely by exposing a meter outbox or an alive process. Admitted payload, canonical quota settlement and provider IN+OUT remain distinct. Counter resets/gaps and crash uncertainty retain conservative holds; no per-byte WAL, remote-receipt meter, automatic uncertain-byte refund or arbitrary multi-control-plane availability is claimed.
8. Unknown or unsupported runtime behavior blocks; no alternate exit, silently dropped policy, optimistic green state or automatic replay is substituted.

## Immutable official core lifecycle

The opt-in `CoreInstaller` resolves a release ID through the build-reviewed
`controlprotocol.OfficialCoreReleases` catalog. Current installable entries are
stock Xray 26.3.27 and sing-box 1.14.3 on Linux amd64. Unsupported adapter,
version, platform and archive formats fail with actionable errors. Mihomo's
client checker is not a server runtime adapter. The managed RouteWeaver/Xray
adapter is a different capability identity and has no invented upstream release
URL; use its separately built/reviewed local package until distribution exists.

`Prepare` accepts no control-plane URL, path or shell. Default retrieval has
bounded HTTPS/public-address-pinned connections, no ambient proxy, exact official
GitHub redirect-host allowlisting and compressed size limits. An explicit local
archive-source callback supports verified offline caches. Both release archive
and executable SHA256 pins must match. Every zip/tar member is checked for path
traversal, duplicates, links, special types, counts and expansion bounds. Only
the reviewed executable is retained; archive-selected paths are never extracted
to the filesystem. The exact native version is checked before an fsynced private
preparation directory is atomically published under release ID plus executable
digest. Existing paths are verified, not overwritten. Archive hashes are content
pins, not a claim of publisher signature attestation.

`Desired.action=install` validates the prepared executable and configuration,
then reports `phase=installed`, `code=artifact_installed` and exact `installation`
metadata. This does not switch configuration, start a core, or mark the new core
observed. Existing runtime identity and lease remain separate. A later confirmed
runtime restriction retains this installed result with denied/expired access and
no observed process; an uncertain restriction still becomes unknown. The latest
non-install policy lease is durably retained, so preparing another binary cannot
erase a revocation or extend the active generation's authorization. A durable
policy-issuance high-water mark also prevents an equal-time or backdated denial
from enabling replay of an older allowed lease; restoring access requires a
newly issued current lease. An expired active lease is enforced during slow
retrieval or native validation, not deferred
until installation completes.

Adapter/version changes require `transition.from` to equal the exact prior
runtime identity, including node/instance/enrollment, generation, revision,
operation and artifact digest. Official upgrades additionally bind release ID
and executable digest. Native validation and immutable-byte checks finish before
the old adapter is allowed to stop its own process. Only that old adapter performs
its existing pidfd/executable ownership checks. Absence/quiescence is observed
before new activation, and only exact new observation is conformant. Recovery
uses only the explicitly known old and new adapters, never a relaxed executable
identity comparison. Uncertain stop/activation is not green or automatically
replayed. Old immutable binaries, revision files and release manifests remain.
If retrieval fails before a target adapter exists, the durable absence of a
candidate stage permits exact old-owner recovery and lease-expiry cleanup.
A missing adapter after staging stays unknown rather than assuming it is absent.
Rollback is another higher generation with the current source identity and a
fresh current policy lease, not a generation rewind or authorization replay.

A private, reconciliation-local native validation receipt binds checked
configuration identity/directory and executable SHA256 before and after native
checking. Both inputs are rechecked before stopping the source and again before
launch. This avoids a second slow parser pass in the activation lane without
letting the wire manufacture a receipt. Direct supervisor callers without a
receipt still receive normal validation. Retrieval/checking retain the mutation
lane while evaluating active policy every 25 ms. Native process stop and startup
remain synchronous and bounded by configured stop timeout/startup grace; this is
not a claim of zero-delay session revocation or OS-sandbox protection against a
hostile administrator replacing trusted files.

Additional verification commands:

```sh
scripts/go.sh test -race ./internal/agent ./internal/controlprotocol ./cmd/node-agent
ROUTEWEAVER_CORE_BIN_DIR=/workspace/shared/routeweaver-tools/cores \
  scripts/go.sh test -race ./internal/agent -run 'TestNative(CoreInstaller|Install)'
```

Positive evidence: official Xray and sing-box archives prepare into new immutable
temporary roots and pass exact native configuration checks; installation preserves
an active runtime and survives restart; held archive/native-validation work does
not extend an old lease; revoked policy remains denied after installation.
Adversarial evidence covers corrupt hashes, root replacement, archive traversal,
links, duplicate entries, expansion metadata, changed checked binaries, stale and
cross-instance transition identities, and uncertain old-process stop. Separate
synthetic version-1/version-2 native executables exercise actual Linux owned
process replacement, recovery and explicit fresh-policy rollback.

There is currently one reviewed upstream release per server adapter, so these
results are **not** a positive native Xray/sing-box cross-version upgrade proof.
A production upgrade requires source-verified adapter registration for the old
version and a reviewed target release. No existing binary is relabeled as a new
version. Real VPS installation, a production managed-runtime release and the
previously documented sing-box process-start restriction remain outside this
local evidence.


## Production lifecycle remediation (2026-10-31)

R01–R03 add explicit continuous foreground operation without weakening bounded
local test sessions, fresh observations of owned-process loss, and conservative
startup descendant handling. See the [operator lifecycle/runbook](../../cmd/node-agent/README.md#continuous-service-operation-and-recovery).
Clean restart preserves generation fences: a stopped runtime needs a newer
control-plane Desired generation, not automatic replay. Manual deployments require
reviewed operator action; explicit Fleet continuous-service intents permit bounded,
revalidated CP recovery and identity-bound lease refresh. `--service` alone does
not grant ongoing authority. See the paired [CP acceptance](../../docs/verification/CONTINUOUS-SERVICE-CP-2026-10-31.md). Early launch identity
failure retains pending ownership and requires investigation. Local signal and
benign-process tests are not production deployment or sustained-soak evidence.
