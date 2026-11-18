# Three-network ingress monitoring — 2026-11-18

## Delivered behavior

An administrator opens **Servers → a server → Connectivity (连通性)**. The feature measures **China Telecom / China Unicom / China Mobile → the server's registered public address** using Globalping public probes. It supports TCP port reachability or ICMP, configurable 5/10/15/30/60-minute scheduling, manual checks, recent latency/loss, a shared gap-aware latency comparison chart, per-carrier observation availability for the displayed window and three aligned 48-observation status strips in a single compact panel with a keyboard-accessible history table.

Settings default to disabled. Opening the page performs no public measurement. Saving an enabled schedule or explicitly requesting a check authorizes disclosure of the server address and selected port to Globalping. Proxy credentials, subscription tokens, private TLS material and arbitrary user-supplied probe commands are never sent. The feature does not change routes or exits, and TCP results do not assert UDP/proxy-protocol health.

## Contracts and seams

- `internal/httpapi/network_monitor.go`: admin-only server-scoped reads, CAS settings, bounded intervals/ports and durable manual queue. Target identity comes from registered hosts, not request JSON. Changed host addresses require review and a new save; old measurements are not relabeled for a new target.
- `internal/httpapi/network_monitor_worker.go`: the HTTP adapter owns Globalping interaction, DNS/public-address checks, scheduling and persistence. It stays in the existing `httpapi` architecture classification; no networking is added to domain policy and no new package or framework is introduced.
- Production uses the fixed HTTPS Globalping API. HTTP client/base injection is private to local test fixtures, not an operator or public API option.
- Probe selection requires country `CN` and one recognized carrier ASN. The returned probe country/ASN, measurement identity, target and finite statistics are verified before accepting an observation. A missing carrier or offline probe yields unknown, not a node outage. Finished zero-reply statistics or an explicitly classified target/network-path failure yield down; unspecified/internal/resolver failures remain unknown.
- POST measurements are never automatically replayed after ambiguous transport failures. GET polling waits one second after each completed request, uses ETag/If-None-Match, and has bounded response sizes/timeouts.
- One durable three-probe reservation per round, maximum 80 rounds/hour across the control-plane store (240 potential probe tests). Provider `429` pauses until Retry-After; provider backoff is persisted. No API key or paid-credit option is added.
- Claims persist before measurement creation; stale interrupted claims become unknown and are not immediately replayed. Cross-handle CAS fences prevent duplicate claims. Results are committed only against the claimed settings and unchanged host identity.
- Retention is the last 288 rounds per server. Availability counts observed up/down samples and excludes unknowns; it is not a time-weighted SLA. The displayed target, method and observation timestamp remain visible. Visible sample-count copy is omitted; a common chart compares the three carriers on the same time/latency axes, with color and line-style distinctions, hover readout and a keyboard sample slider. Old results are marked expired.
- Three consecutive accepted down observations open a per-carrier incident; unknowns reset the failure streak. Only a completed up observation resolves an incident. Durable pending notification events are deduplicated into administrator-only in-app inbox entries, honoring the global in-app setting. No external email or Webhook delivery is implied.

The ASN preference list and public probe coverage can change. Results identify the actual selected city/ASN and do not represent all customers of an operator or a fixed residential vantage point.

## References

- [Globalping API contract](https://github.com/jsdelivr/globalping/blob/master/public/v1/spec.yaml)
- [Measurement/probe schema](https://github.com/jsdelivr/globalping/blob/master/public/v1/components/schemas.yaml)
- [TCP Ping](https://blog.globalping.io/run-ping-with-tcp-or-icmp/)
- [Free quota](https://globalping.io/credits)

## Verification

Local HTTP fixtures cover the actual client request/response surface without sending measurements to third-party or live user nodes. Backend checks include admin authorization, explicit queueing, bounded settings, disabled schedules, target changes, missing probes, durable quota/backoff, result mismatch/incompleteness, persistent history, incident/recovery deduplication and administrator-only notification visibility. A failing CAS persistence regression was reproduced before fixing the claimed-state snapshot to avoid shared map mutation.

Frontend checks cover no automatic measurement on page entry, explicit save/check, failed-write input retention and uncertain-result recovery, uninterrupted partial input under background refresh, unknown versus failed states, availability denominators, initial read retry and existing server workspace navigation.

- Backend focused HTTP/provider/worker tests passed with `-race -p=1` (`TestNetworkMonitor*`); log: `bin/network-monitor-backend-tests.log`.
- 48 focused frontend regressions passed across five files, including server navigation and notification discovery; log: `bin/network-monitor-web-tests.log`.
- Typecheck and production build passed; log: `bin/network-monitor-web-build.log`.
- Production architecture imports and ticket DAG checks passed; RW-18 records this bounded evidence without changing feature prerequisites or declaring a new full-suite pass.
- Chromium visual checks covered empty, observed and missing-carrier states at 1440/390/320 px in light and dark themes (18 states), plus open history tables. No page-level overflow or JavaScript page errors were observed. Artifacts and fixture script: `bin/network-monitor-review/`. These are read-only browser fixtures, not live measurements.
- The local demo backend was updated, and its authenticated monitor route was checked. Its inventory was empty before the update. Monitoring remains disabled until an administrator explicitly configures it.

No live user node, native proxy protocol or deployed three-network traffic acceptance is claimed. The earlier broad UI-review full-suite failures remain separately recorded; this feature does not claim a passing whole-repository gate. Independent review was not performed.
