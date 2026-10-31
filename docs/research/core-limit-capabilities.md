# Core limit capabilities: source findings

Status: **SOURCE INSPECTION, NOT RUNTIME VERIFICATION**. Researched 2026-10-19 UTC. This is a bounded primary-source report for the next product decision, not an exhaustive repository audit, implementation plan, deployment approval, or claim that RouteWeaver already enforces these controls.

Device visibility, connection visibility, device limits, concurrent-connection limits and speed limits remain target capabilities. The user has now selected **online source-IP count as the device-limit proxy**, with **account-wide merging and deduplication across platform nodes**. Named device-credential slots were not selected. Subscription-conversion configurations, profiles and feeds are modelled separately and are not counted as devices under this limit. This choice does not turn observed IPs into physical-device identities.

**Still pending:** exact enforcement delay, over-limit behavior, concurrent-connection semantics, and speed-limit scope/behavior. A globally shared speed budget is **not approved**. Research into how subscription-service panels and their backends implement speed limits is pending separately; this report does not duplicate or prejudge it.

Conversation evidence supplied for this context update, 2026-10-19 UTC:
- User: “用在线 IP 数即可，这主要是机场的设备数限制需求 我们的多个订阅转换的配置另行建模”
- User, confirming account-wide IP merging/deduplication across platform nodes: “是两边合并去重，和机场一样”
- User, when asked about global speed scope: “emm,看机场怎么做的吧，我感觉技术上这样很麻烦啊”

## Version boundary

- **Xray v26.3.27**, commit `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`: GitHub's latest non-prerelease at inspection. [Release](https://github.com/XTLS/Xray-core/releases/tag/v26.3.27), [tag reference](https://api.github.com/repos/XTLS/Xray-core/git/ref/tags/v26.3.27).
- **Xray v26.10.17**, commit `92ccc939aaf4f8965f369cf0b142e005aeaa11d5`: also inspected because current documentation and integration code refer to newer APIs. It is explicitly a **prerelease**, not the stable boundary above. [Release](https://github.com/XTLS/Xray-core/releases/tag/v26.10.17), [release metadata](https://api.github.com/repos/XTLS/Xray-core/releases/tags/v26.10.17).
- **sing-box v1.14.3**, commit `7054cac5124465ffdb145870d7c01885566711b1`: current stable, released 2026-10-09. [Release](https://github.com/SagerNet/sing-box/releases/tag/v1.14.3).
- **3x-ui v3.10.2**, commit `608ef4e4010bf83e2e78328e08f77efc051ad4d7`: integration example only, not evidence of identical native behavior in every core. [Release](https://github.com/MHSanaei/3x-ui/releases/tag/v3.10.2), [tag reference](https://api.github.com/repos/MHSanaei/3x-ui/git/ref/tags/v3.10.2).

Moving documentation pages are supplementary. Commit-pinned code below controls the source findings. No core binary was run and no network behavior was tested.

## Keep the semantic units separate

- **Registered device credential:** a separately identifiable credential issued for a named slot. Counting or revoking slots does not prove each credential is used on exactly one physical device.
- **Observed source IP:** a network address seen by the core. Several devices can share it through NAT; one device can use several addresses or change networks. It is not a device identity.
- **Logical connection:** a routed TCP stream, UDP association or another explicitly defined tracked flow. Multiplexing means several logical streams can share one outer TCP/QUIC transport.
- **Authenticated transport/session:** a longer-lived authenticated carrier that may create additional streams. Closing one stream is not necessarily terminating that carrier.
- **Physical device:** requires a separately specified enrollment/binding guarantee. Generic reusable proxy credentials and IP observations do not establish it. This is an inference from the exposed identities and protocol behavior below, not a claim of hardware attestation.

## Counters, reset and route attribution

### Xray

User uplink/downlink counters are keyed by `user>>>email>>>traffic>>>direction`; separate counters exist for inbound/outbound tags. The dispatcher uses the email alone, so a reused email aggregates across inbounds. These counters do **not** supply a user-by-route matrix. [Statistics documentation](https://xtls.github.io/en/config/stats.html), [pinned dispatcher](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/dispatcher/default.go).

Counters are created in memory. A reset atomically swaps each individual counter to zero and returns its previous value; a multi-counter query is not one atomic accounting transaction. The API exposes service uptime, not a durable per-counter epoch or monthly quota cycle. [Counter implementation](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/stats/counter.go), [manager](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/stats/stats.go), [query/reset implementation](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/stats/command/command.go).

The newer `GetUsersStats(include_traffic=true)` only includes currently online users and only resets counters for those included users. It is **not** a complete replacement for `GetStats`/`QueryStats` quota collection. [Pinned implementation](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/stats/command/command.go).

### sing-box

The V2Ray-compatible StatsService supports opt-in inbound-tag, outbound-tag and user-name uplink/downlink counters. User identity comes from nonempty `metadata.User` matching the configured list. Identical names aggregate across inbounds. Counters are lazy, in-memory atomic integers; reset uses `Swap(0)` per counter. No durable billing epoch, quota ledger or automatic monthly cycle is provided by this API. [Pinned statistics](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/experimental/v2rayapi/stats.go), [StatsService registration](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/experimental/v2rayapi/server.go).

The Shadowsocks-specific SSM API is a distinct exception: it offers user/global traffic counters and optional cache persistence. It saves periodically and at shutdown, which is not an exactly-once quota ledger. `tcpSessions`/`udpSessions` count session starts and do not decrement on close; they are **cumulative counters, not concurrency gauges**. [Counters](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/service/ssmapi/traffic.go), [save lifecycle](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/service/ssmapi/server.go), [cache](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/service/ssmapi/cache.go).

### Product implications, not an implementation decision

Per-user/per-route multipliers need an explicitly attributable user-by-route measurement and a chosen accounting boundary. Independent user totals and inbound totals cannot simply be joined to recover that matrix. The ledger must distinguish reset/restart epochs and state the treatment of unobserved intervals. Do not add user, inbound and outbound views together or inadvertently bill each relay hop. Core counter bytes also must not be presented as verified VPS NIC/wire billing bytes. These are requirements inferred from the source limitations, not a selected ledger design.

## Live IP and connection visibility

Xray's online map counts **unique active source IPs** per email. Its internal references are added on dispatch and removed when the context ends; the exposed count is not the number of references/streams. Last-seen advances on an added dispatch, not every payload packet. Both inspected stable and prerelease source use this reference-counted behavior. [Stable online map](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/stats/online_map.go), [prerelease dispatcher](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/dispatcher/default.go), [API schema](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/stats/command/command.proto).

**Source/documentation mismatch:** the [official policy page](https://xtls.github.io/en/config/policy.html) still describes online status as connection activity within 20 seconds. That prose does not match the pinned implementations above. Do not hard-code that window from the prose or label Xray's IP count as physical devices/concurrent streams.

sing-box 1.14 adds `SubscribeConnections`, with connection ID, source, inbound, user, outbound, timestamps and byte totals, plus connection/closure/traffic events. The initial snapshot includes retained closed records, so inspect `closedAt`. It supports deriving live routed-connection counts and unique observed source addresses by user, not physical-device counts. `CloseConnection(id)` and `CloseAllConnections` exist. The older Clash `/connections` serializer omits authenticated user, so the API choice matters. [Schema](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/daemon/started_service.proto), [implementation](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/daemon/started_service.go#L791-L1114), [Clash serializer](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/experimental/clashapi/connections.go).

## Revocation is not established-session termination

- **Xray VLESS:** `RemoveUser` removes the validator entry; that ordinary path does not cancel established sessions. Reverse-proxy behavior is a special case, not a universal disconnect promise. [Handler](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/proxy/vless/inbound/inbound.go#L237-L246), [validator](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/proxy/vless/validator.go).
- **Xray `sib`:** the command adds a source-IP routing rule. It is not evidence of an existing-session kill RPC, despite documentation wording suggesting disconnection. [Pinned command](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/main/commands/all/api/source_ip_block.go).
- **sing-box:** SSM user CRUD is specific to managed Shadowsocks, not generic user CRUD for every inbound protocol. Deletion replaces authentication maps but does not close existing TCP connections. SS2022 TCP keeps derived session keys; incoming UDP packets recheck the user map. [SSM deletion](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/service/ssmapi/user.go), [pinned SS2022 dependency](https://github.com/SagerNet/sing-shadowsocks/blob/65740e0f0e3e/shadowaead_2022/service_multi.go).
- **sing-box Hysteria2:** authentication is retained on a QUIC session and reused for later streams. Closing a tracked stream is not necessarily closing the authenticated QUIC carrier. [Pinned dependency](https://github.com/SagerNet/sing-quic/blob/75c3ac4fa12b/hysteria2/service.go).

Adapter acceptance must distinguish **block new authentication**, **close active logical flows** and **terminate authenticated transports**. Polling, removing a credential and closing a snapshot is not a demonstrated atomic block-and-kick guarantee; new flows may race that snapshot.

## Generic concurrency and speed gaps

No generic stock per-user concurrency cap, device cap, or aggregate per-user speed/quota setting was found in the inspected policy/user schemas and control APIs. This is a bounded negative finding, not proof that every possible extension is impossible. Required capabilities stay in scope; adapter/enforcement work and verification remain necessary.

- Xray user policy contains timeouts, statistics and buffering, not subscriber concurrency or bandwidth budgets. [Policy schema](https://github.com/XTLS/Xray-core/blob/92ccc939aaf4f8965f369cf0b142e005aeaa11d5/app/policy/config.proto).
- Xray mux `concurrency` limits sub-connections per mux carrier; a full pool can open another carrier. It is not a per-user cap. [Official explanation](https://xtls.github.io/en/config/outbound.html#muxobject).
- sing-box HTTP2/QUIC maximum-stream parameters and outbound multiplex pool settings likewise are not a per-subscriber aggregate cap. [HTTP2 definition](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/docs/configuration/shared/http2.md), [multiplex definition](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/docs/configuration/shared/multiplex.md).
- sing-box Hysteria2 `up_mbps`/`down_mbps` are inbound-level settings applied through per-QUIC-connection congestion handling. Users contain name/password only; multiple connections must not be assumed to share one user bandwidth budget. TCP Brutal parameters are also not generic per-user quotas. [Hysteria2 options](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/option/hysteria2.go), [Hysteria2 dependency](https://github.com/SagerNet/sing-quic/blob/75c3ac4fa12b/hysteria2/service.go), [Brutal handling](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/common/mux/router.go).
- Xray REALITY fallback speed limits apply to traffic that fails verification, not authenticated subscribers. [Official documentation](https://xtls.github.io/en/config/transports/reality.html#realityobject).

## 3x-ui integration examples, not native-core guarantees

- The IP-limit job polls online-IP statistics and uses fail2ban. It explicitly says temporary credential removal refuses new handshakes while fail2ban is what ends live traffic. Its polling and IP-based scope must not be relabelled physical-device or atomic concurrency enforcement. [Pinned job](https://github.com/MHSanaei/3x-ui/blob/608ef4e4010bf83e2e78328e08f77efc051ad4d7/internal/web/job/check_client_ip_job.go).
- HWID enforcement reads client-supplied `X-HWID` and device metadata on subscription requests. This demonstrates subscription enrollment/gating, not physical hardware attestation or proof that copied proxy credentials cannot work. [Subscription gate](https://github.com/MHSanaei/3x-ui/blob/608ef4e4010bf83e2e78328e08f77efc051ad4d7/internal/sub/controller.go#L705-L723), [slot records](https://github.com/MHSanaei/3x-ui/blob/608ef4e4010bf83e2e78328e08f77efc051ad4d7/internal/web/service/client_hwid.go).
- Traffic polling uses non-destructive reads and deltas; the first call establishes baselines, and backwards counters are treated as restarting from zero. This is an integration strategy with its own gap assumptions, not an exactly-once guarantee. [Pinned collector](https://github.com/MHSanaei/3x-ui/blob/608ef4e4010bf83e2e78328e08f77efc051ad4d7/internal/xray/api.go#L815-L874).

## Historical alternatives: not current product decisions

These alternatives were proposed before the user's online-IP decision. They are retained as historical context, **not a current recommendation to replace that decision**. The user's account-global IP deduplication choice does not approve either node-local or globally pooled speed/concurrency limits.

1. **Named credential slots plus node-local limits: former lower-maintenance recommendation, not selected.** This alternative defined a device as a named, separately revocable credential slot; logical TCP streams and defined UDP associations as concurrent units; and speed as aggregate upload/download across credentials on one ingress node. Those definitions are not adopted by the online-IP decision.
2. **One pooled budget across UK/FRA/LAX: not approved.** This alternative combined credential slots with globally pooled concurrent connections and speed. Three independent node-local limits could permit up to three times an advertised global limit. This remains a scope distinction, not an approved coordination design or a conclusion about subscription-service practice.
3. **Physical-device/anti-sharing binding through supported clients: not selected.** This alternative required enrollment, supported clients, credential binding and anti-copy guarantees. Ordinary IP counts and subscription HWID headers do not establish strong binding. The selected online-IP proxy does not make that stronger promise.

The settled product meaning is an **account-global online-IP deduplication limit**, with conversion configurations outside that model. Next acceptance questions include enforcement delay and over-limit behavior; separate connection-counting units and scope; speed scope, upload/download and burst definitions informed by the pending panel/backend research; revocation of existing sessions; and quota measurement boundary. Required controls still need measured acceptance for each core/protocol/version profile. Unsupported policy must not be silently omitted. No enforcement mechanism, exact interval, rollout order or implementation task is approved by this report.

## Verification and scope of this report

Completed: read official documentation, version/release metadata and pinned source; separated facts from inferences and proposals; saved this documentation-only report and updated its product context from the later user replies. The pinned research findings were not changed or re-researched during this context update. Not performed: core execution, traffic/load tests, packet capture, deployment, credential access, VPS changes, implementation/prototype edits, external publication, or exhaustive repository audit. Runtime acceptance and the remaining product definitions remain open; online-IP meaning and account-global deduplication scope are settled as above.
