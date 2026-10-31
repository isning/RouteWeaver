# Bounded node and managed-route diagnostics (K05 / RW-18)

A diagnostic is a separately authorized, immutable target plus a durable job for
one enrolled Core Instance on that target's physical node. It is not a shell
command, imported subscription URL, automatic route switch, or renderer result.

## Administrator and agent interfaces

- `GET/POST /api/admin/diagnostic-targets`: admin-only explicit authorization of
  `{id,name,nodeId,url,methods}`. URLs must be public HTTPS without userinfo, query
  or fragment. Methods are `connectivity`, `download`, `upload`. Target identity
  is immutable; a changed authorization requires a new ID. This does not fetch
  anything. Jobs cannot supply URL, headers, credentials, proxy or shell fields.
- `GET/POST /api/admin/diagnostic-jobs`, `GET /{jobId}`, `POST /{jobId}/cancel`:
  request `{id,targetId,instanceId,kind,maxBytes,timeoutSeconds,pathMode?,publishedRouteId?}`. Durable duplicate
  IDs accept only identical actor/request; conflicting reuse fails. The request
  captures the current node/instance/enrollment scope and target snapshot.
- `GET /api/admin/diagnostic-paths`: credential-free selectors for currently
  fully applied paths. Each contains `publishedRouteId`, `name`, entry `instanceId`
  and `nodeId`, and `managedPath` pins (deployment/fingerprint, entry/exit endpoint,
  connector and all-hop applied identities). No UUID, password or native artifact
  is returned. `pathMode: "managed_route"` requires that published route and its
  exact current entry instance. Omitting the mode keeps `node_direct` behavior.
- Enrolled agent only: `POST /api/agent/instances/{instanceId}/diagnostics/claim`,
  `GET /diagnostics/{jobId}`, `POST /diagnostics/{jobId}/result`. Claims and reports
  are fenced by exact job, enrollment and attempt. One running job per physical
  node across all its Core Instances, and at most eight pending jobs per node.
  Claiming reserves SQLite's writer before reading scope/queue. No generic task
  scheduler or shared mutable desired-state operation is added.

Node-agent outbound mode enables diagnostics by default; `--diagnostics=false`
turns that lane off. Only explicitly created administrator jobs cause traffic.
The lane is independent of deployment reconciliation and policy-lease timing.
A private journal lives under the existing agent state directory. Its filesystem
has the same private-local-storage, locking, fsync and atomic-rename assumptions
as the reconciler. A running attempt is never re-executed after a crash. A known
persisted result is retried unchanged; an interrupted attempt reports unknown
traffic cost. An expired queued request is `not_run`, not a successful test.

## Exact traffic semantics

Two explicit modes share the same bounded HTTP measurement adapter:

- **服务器→测试目标，直连出站** (`node_direct`) measures server-origin direct
  egress only. It does not validate a FRA→UK chain.
- **入口核心→已配置中转/出口→测试目标** (`managed_route`) enters the exact live
  managed core's selected immutable connector, traversing its configured transit
  and exit. A direct native default is never a fallback. This is an operational
  core-forwarding check, **not** a public-entry TLS, user-admission, client
  subscription or whole-client-to-exit test. It bypasses tenant admission only
  through an unexported in-process context created by owned private control RPC;
  network traffic cannot supply that context. Payload is not charged to tenant
  quota. Physical NIC/provider traffic still counts on every traversed link.

Both modes measure actual application payload rather than provider billable
traffic or a general line-rate benchmark. Direction is relative to the probing
entry node. The displayed payload bound counts a payload once, not the aggregate
of every hop's wire bytes. They never alter route revisions or exits.

- Connectivity: one HEAD, success only on 2xx, zero application body bytes. The
  observed total duration includes resolution, connection, TLS and HTTP response.
  Zero application payload does **not** mean zero network/provider cost.
- Download: GET with `Range: bytes=0-(maxBytes-1)` and identity encoding. The target
  must return a successful response whose Content-Length equals `maxBytes`.
  Unknown length, compression, redirects, oversize or a short body fail rather
  than becoming a benchmark result. At most the authorized body amount is read.
- Upload: PUT of exactly the chosen number of zero-valued application bytes, with
  explicit Content-Length, no compression and no secrets. The operator must
  authorize a dedicated PUT sink, not an arbitrary resource that PUT could
  overwrite. The operator should configure the sink to consume the request and
  return 2xx with an empty or small acknowledgement (at most 16 KiB). The executor
  waits for the standard HTTP transport's WroteRequest completion and error, not
  just reader consumption. Acknowledgement bytes are included in the estimated
  upper bound. Only complete local request write plus 2xx yields an upload rate;
  this is not proof of the target consuming or storing bytes, nor billable bytes.
  In managed mode this completion is the HTTP writer into the native stream,
  not a measurement of every hop's network writes.
  Failed/uncertain uploads mark actual cost unknown. Shutdown joins the bounded
  writer with up to a one-second cancellation grace, and never schedules retries.
- Speed payload: 1 KiB–16 MiB. Total request deadline: 1–30 seconds, additionally
  bounded by the two-minute queue expiry and the claimed execution window.
  A ten-second claim-delivery allowance leaves five seconds before the control
  plane releases a missing-result lane; expired claims do not start traffic. No retries to the target. One executor
  slot. Rate exists only for a fully successful transfer and is actual payload
  divided by the observed end-to-end elapsed duration, not an invented line rate.

Application payload counters deliberately exclude request/response headers,
TLS/TCP/IP overhead, retries below TCP, and receive/send buffering. The separate
node NIC/provider observation model owns those estimates. Unknown interrupted
cost must remain unknown, never display zero as a known actual cost.

## Network and cancellation controls

The executor reuses `resources.ValidateHTTPSURL` and `resources.PublicDialer`.
All DNS addresses are checked, the selected checked literal IP is dialed directly
or carried through the selected connector, and TLS verifies the original hostname.
The downstream proxy receives that literal destination, not an unchecked hostname. Private, link-local/metadata, loopback,
reserved and special-use addresses are denied. Environment proxies, redirects,
cookies, Authorization and imported source credentials are never used.

Synthetic loopback tests require an exact target-ID-to-URL map supplied only via
local executor/runtime construction, plus fixture records seeded by tests. Managed
route fixtures also require the runtime destination policy to allow that literal. The HTTP API
has no local/private target override and the production CLI exposes none.

Cancellation marks a queued job not run or a running job `cancel_requested`.
The independent agent lane polls its scoped status every 250 ms and cancels the
request context on cancellation, scope/channel failure or shutdown. Actual stop
and measured partial cost must be reported before the result becomes `cancelled`.
If the agent disappears, the control plane reports `unknown` after the execution
window plus a 15-second delivery allowance. It never reschedules the attempt.
A late, matching durable report may refine that missing result; already accepted
agent results are immutable. Dispatch/recovery timestamps are not measured latency.
Phase/code/action fields direct an operator to target methods, DNS/egress, TLS,
size limits, enrollment, or agent connectivity without echoing secret URLs or
raw transport errors.

## Managed path admission and process binding

The CP selects paths within the same SQLite transaction as job creation. Each
hop must have a known, quiescent, native-checked, conformant observation no older
than 60 seconds, a current enrollment, unexpired policy lease, and an exact
immutable published manifest. All hops share the deployment/fingerprint and
identical published path; the entry principal's connector mapping must be unique.
The job captures every hop's generation/revision/digest. Claim and status/result
checks repeat these fences. A changed queued path is `not_run`; an active changed
path becomes `unknown` and its polling agent cancels. Later measured payload can
be retained, but never becomes a successful validation of that changed path.
Exact original report replays remain idempotent after this CP downgrade.

The agent checks its effective `LastValid` deployment (not an inactive install
candidate), fresh exact known/quiescent native observation, staged artifact bytes,
policy lease and process-owned control session identity before RPC. Activation
closes the old process channel; releasing the reconciler lock cannot retarget an
old job to a newly activated process. No reconciliation lock is held for the HTTP
transfer. Registered managed Xray is the current supported entry adapter.

The runtime accepts only fixed `RunDiagnostic` / `CancelDiagnostic` operations
with exact job/attempt identities on inherited private control channels (64 KiB
request frame cap). It derives a unique route→connector mapping from the validated
renderer principal-rule prefix, cross-checking all descriptor bindings and native
outbound tags. Missing/ambiguous mappings reject; no default selection is inferred.
One bounded runtime slot and a bounded expiring result cache prevent simultaneous
or repeated payload. Private pipe EOF, runtime close and explicit cancellation
cancel and close native tunnels. A caller timeout without terminal remote evidence
is `unknown`, never a claim that traffic stopped. Unknown outcomes retain the
physical-node slot until the claimed timeout plus 15-second hard stop/delivery
horizon, so another instance cannot overlap a possibly live probe. Proven native
preflight rejection is instead `not_run`, with known zero application payload. Existing native destination
policy still applies after the target's public-address checks.

## Verification and limitations

Public seams are the RW-18 diagnostic job API and bounded diagnostics executor.
Tests exercise real synthetic HTTP target traffic and real authenticated CP/agent
transport, durable cross-handle SQLite claims, enrollment changes, exact result
replay/conflicts, queue limits, cancellation through RunDriver, forced subprocess
crash/recovery and lost result receipts. Adversarial tests cover private/metadata
URLs, credentials/query, exact fixture authorization, redirects, oversized and
unknown-length bodies, short transfer, deadline, cancellation and concurrency.
Shared resources tests independently cover mixed DNS answers and pinning/rebinding.

No external download, real VPS, public DNS probe, root/ICMP, provider billing test,
or production throughput/load claim is part of this evidence. Private-network
target probing and public-entry/client-admission diagnostics remain unsupported.
Selected managed connector-path traversal is positively tested; external VPS
throughput and multi-provider billing are not. Subscription-source credential-bearing probes are not
implemented. Monitoring thresholds, audience/deduplication and delivery adapters
remain the existing notifications module. Manual alternate routes use the normal
reviewed revision/deployment workflow; K06 automatic server exit switching is not
implemented.
