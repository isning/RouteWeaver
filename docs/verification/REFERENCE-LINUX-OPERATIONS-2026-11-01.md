# Bounded Linux reference operations acceptance — 2026-11-01

This advances RUN04 / OPS02 / OPS03 / NET03 / NET04 with executable reference
observations. It does **not** close the chosen deployment's operational gates.
Production source: `0f3cc5ee699a4cbc9d261276c4c4437a770ea961`; all changes here are
verification-only. No live host, credentials, public listener, firewall, sysctl,
system security setting, sing-box process or browser was involved.

## Predeclared reference profile and invariants

- Ephemeral Debian 13.6 x86-64 container, Linux 6.18.57, one ordinary control-plane
  CLI, private synthetic account/database/feed, loopback listeners assigned by OS.
- `GOMAXPROCS=1` limits Go scheduling, **not CPU quota**. `GOMEMLIMIT=256MiB` is a
  soft Go memory target, **not an RSS ceiling**. CPU/memory cgroup limits are not
  exposed; hard host limits are unknown. Open-file limit is 16,384.
- Two fixed 30-second windows, one readiness request per second, separated by
  graceful SIGTERM and restart. Zero failed requests after initial readiness;
  startup within 20 seconds and shutdown within 15 seconds. Same persisted login
  and exact public feed bytes after restart without bootstrap credentials.
- Ordinary second CLI writer must fail visibly for both original DB path and a
  hard link. Parent directory, database and SQLite sidecars must remain private.
- Record startup/shutdown time, sampled RSS/CPU, readiness latency and DB/sidecar
  bytes. No resource figure is a capacity promise or an acceptable target SLA.

## Completed CLI observation

`python3 scripts/reference-linux-operations.py --binary bin/reference-control-plane --output bin/verification/reference-linux-operations.json`

Passed 60/60 readiness probes across 60.0008 observed seconds, both lock refusals,
private permissions, exact feed persistence, persisted-account login, restart and
clean shutdown. Maximum sampled RSS: 23,024 KiB. Maximum readiness RTT: 46.72 ms.
Startup: 0.114 / 0.076 seconds; shutdown: 0.0018 / 0.0032 seconds. Sampled CPU:
0.01 / 0.09 seconds across the windows. DB/sidecar byte totals were stable within each window
(242,896 and 205,264 bytes respectively; checkpointing across shutdown changes the
physical file layout). Readiness does not establish node or delivery health.

Independent review found and corrected stale-success receipt handling and a
startup-deadline acceptance gap. The receipt regression and complete 60-second
CLI observation were rerun successfully after those corrections. Pinned Gitleaks
8.24.3 passed using its supported explicit binary path.

Machine-readable evidence including binary SHA-256:
[evidence/REFERENCE-LINUX-OPERATIONS-2026-11-01.json](evidence/REFERENCE-LINUX-OPERATIONS-2026-11-01.json).

Focused existing CLI process-lock, SQLite alias, bounded recovery-password tests
passed (`go test ... ./cmd/control-plane`, 1.261 seconds). The new opt-in managed
observation duration validation test passed; blank retains default timing,
30–1,800 seconds is accepted, malformed/out-of-range values fail before launch.

## Opt-in managed reference observation

In these managed tests, `GOMAXPROCS=1` and `GOMEMLIMIT=256MiB` configure only the
parent test/CP process. The supervisor strips ambient Go settings and the trusted
managed adapter supplies only Xray resource roots, so the native core does not
inherit those settings. Its Go defaults are unmeasured; no native soft memory
limit, single-CPU constraint or hard resource cap is claimed. The ordinary CLI
script above directly supplies its environment and is a separate scope.

The existing real-managed-Xray single-flow continuous test now optionally accepts
`ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS`. Default CI timing and mandatory tests
are unchanged. The opt-in window runs **after** real payload crosses the original
aged instance lease expiry and before the existing revocation checks. Every second
it checks exact echoed payload (two-second I/O deadline), live unchanged native
identity, active service and a policy issued after the original lease. Every 30
samples it reports progress, maximum payload RTT, parent Go heap allocation and
agent-root regular-file bytes. Heap allocation excludes native child RSS; agent
root bytes include the staged binary and exclude the separate CP database.
Existing post-window checks require new revoked flows to fail, the original flow
to close within its bounded admission lease, and the runtime to remain live.
Existing cleanup cancels the driver, waits up to ten seconds and closes spool,
reconciler and transport; cleanup failure fails the test rather than being ignored.

The 120-second smoke passed in 141.75 seconds including original-lease expiry,
revocation and cleanup: 120 successful payload samples, maximum RTT 18.05 ms,
parent Go heap samples 2.6–3.1 MB, and four bytes of agent-root growth. Evidence:
[evidence/MANAGED-REFERENCE-120S-2026-11-01.jsonl](evidence/MANAGED-REFERENCE-120S-2026-11-01.jsonl).

After that success and resource review, a 1,800-second local observation started
at 15:33:53 UTC and passed at 16:04:17 UTC. Before launch it added explicit synthetic-reference
failure guardrails: sampled parent Go heap above 128 MiB or agent-root file growth
above 16 MiB fails. These are bounded fixture expectations, not target operating
limits. The test was compiled first so subsequent wait4 CPU/maximum-RSS accounting
excludes compilation. That maximum RSS is not summed concurrent process RSS.

The full observation passed **1,800 exact payload exchanges over 1,800.001 seconds**
with unchanged native identity and nine observed policy issuance timestamps.
Maximum payload RTT was **919.26 ms** (under the existing two-second I/O deadline).
This shared reference executor also ran other authorized work; this is not an
isolated latency benchmark. Maximum sampled parent Go heap was 4,008,216 bytes;
agent-root maximum growth was 723 bytes. Neither fixture guardrail fired. New
revoked flows were denied; the existing flow closed within its own admission
lease while the native runtime stayed live. Driver cancellation/cleanup passed.
Total test time was 1,823.48 seconds (wrapper wall time 1,823.54 seconds).

After precompilation, wait4 child accounting recorded 183.64 user CPU seconds,
55.70 system CPU seconds and maximum RSS 122,860 KiB. CPU includes the test harness
and native child; maximum RSS is not their summed simultaneously resident memory.
This is a bounded one-flow continuous-renewal observation, not load/capacity,
notification-provider progress, backup-under-load, or target-host soak evidence.

- [Full 30-minute progress/test log](evidence/MANAGED-REFERENCE-1800S-2026-11-01.log)
- [Resource/identity receipt and executable hashes](evidence/MANAGED-REFERENCE-1800S-2026-11-01.json)

Reproduce after building the real managed binary and test executable:

```sh
GOMAXPROCS=1 GOMEMLIMIT=256MiB \
ROUTEWEAVER_MANAGED_XRAY_BIN="$PWD/bin/reference-managed-xray" \
ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS=1800 \
bin/reference-httpapi.test -test.v -test.timeout=32m \
  -test.run='^TestNativeContinuousManagedServicePreservesPayloadAndRevocation$'
```
 No remote CI dispatch is
part of this evidence. This single synthetic echo flow is not representative load.

## Still dependent on the actual deployment

- Real host/kernel distribution security support and patch provenance; recording
  a kernel version is not a vulnerability/security-status certification.
- Actual hardware/quota, user/node/concurrency counts, acceptable latency/errors,
  availability and RTO/RPO; representative sustained load and target resource cap.
- Operator key custody, durable storage, HTTPS/public origin and proxy trust,
  invitation/MFA/recovery operations on the chosen host.
- Real node/client topology, enrollment, reconnect/restart behavior and failure
  observability under actual network loss; external provider delivery progress.
- Fresh encrypted restore, obligations and configuration on the target storage,
  measured recovery and reviewed core upgrade/rollback procedure. The separate
  backup CLI fixture and prior genuine two-release upgrade evidence are not
  duplicated or promoted to target-host certification here.

The pinned engineering skill copy was absent at the documented shared path and
its official pinned raw-GitHub fallback was unavailable (cache miss); no claim of
having executed that unavailable skill is made. Repository AGENTS and release
acceptance instructions were read and followed.
