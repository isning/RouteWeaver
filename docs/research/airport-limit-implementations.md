# Airport panel and backend limit implementations

Status: **SOURCE INSPECTION, NOT RUNTIME VERIFICATION**. Researched and recorded 2026-10-19 UTC. This is a bounded examination of specific subscription-service panel/backend implementations, not a claim about all commercial operators, a backend selection, or proof that RouteWeaver implements these controls.

## Current product decision

The user approved this division of scope:

- **Account-global quota accounting and online-IP merging/deduplication** across platform public ingress nodes.
- **Rate limiting by user × logical ingress**, rather than a strict shared speed budget across every ingress/node.
- Subscription-conversion configurations, profiles and feeds remain separately modelled; they are not device identities or additional device slots.

Conversation evidence supplied for this decision, 2026-10-19 UTC:

- Assistant: “账号全局统计额度与在线 IP；限速按用户在每个逻辑入口执行，先不做严格的跨入口总限速。”
- User, message `Sentinel_c5001015d8548191a3423aa06cb13765`: “嗯，我同意”

Earlier scope evidence:

- User: “用在线 IP 数即可，这主要是机场的设备数限制需求 我们的多个订阅转换的配置另行建模”
- User, confirming cross-platform merging and deduplication: “是两边合并去重，和机场一样”
- User, when asked whether speed must also be globally pooled: “emm,看机场怎么做的吧，我感觉技术上这样很麻烦啊”

**Still pending:** the online/active window, enforcement lag, over-limit action, failure behavior, detailed upload/download and burst semantics, and quota reset-policy defaults. The user's scope approval does not resolve those details. No backend fork, distributed enforcement mechanism, or implementation task was selected by this research. The next reset-policy question was not yet answered when this document was recorded; no default is invented here.

## Main finding

The inspected implementations separate rate enforcement from online-IP coordination. Their Xray paths use process-local shared user buckets. Cross-node online-IP features use panel snapshots or an optional Redis-backed cache; neither path establishes strict, globally atomic admission merely because it is labelled a global device limit.

This supports the approved product scope without importing a requirement for cross-country real-time bandwidth coordination. It does **not** justify weakening account-global IP deduplication into unrelated per-node IP limits, nor treating a central display count as a demonstrated enforcement guarantee.

## Version and maintenance boundary

| Project | Source boundary | Role in this report |
| --- | --- | --- |
| cedar2025/Xboard | `4f48e61a2cbc6db5338872b6bdb45ef954ec1256`, 2026-08-30 | Panel fields, HTTP/WS device interfaces, Redis deduplication and deployment |
| wyx2685/V2bX | v0.4.1, `71277de69efbbc86c23ad8ae02b68efd174e5756`, 2025-12-03 | Detailed node-side rate/IP trace |
| golimit/V2bX | `a5108d1ba917a68197fd126bc3d1386be54eda8d`, 2026-07-20 | Maintenance-fork cross-check; specified enforcement files are unchanged |
| XrayR-project/XrayR | v25.3.6, `974abc9a98d8b64f7f0a7b7b3044140087a1bc4e`, 2025-03-20 | Historical alternative: local rate buckets plus optional shared Redis IP cache |

[Xboard commit](https://github.com/cedar2025/Xboard/commit/4f48e61a2cbc6db5338872b6bdb45ef954ec1256), [V2bX tag](https://github.com/wyx2685/V2bX/tree/v0.4.1), [golimit commit](https://github.com/golimit/V2bX/commit/a5108d1ba917a68197fd126bc3d1386be54eda8d), [XrayR source snapshot](https://github.com/XrayR-project/XrayR/tree/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e).

Maintenance facts checked during research:

- The wyx2685/V2bX repository page reports it was **archived on 2026-05-17**. It is useful implementation evidence, not automatically a low-maintenance new-deployment choice. [Repository status](https://github.com/wyx2685/V2bX)
- XrayR's official remote HEAD was `5ceba41540a479fb8f5d9196a8ca3c22ab9e390e`, dated 2026-07-03, with the message “Clear all files” and an empty tree. Its parent was not a usable full implementation either. This report deliberately inspects the pinned release above, not a supposed implementation at current HEAD. [Clear-all-files commit](https://github.com/XrayR-project/XrayR/commit/5ceba41540a479fb8f5d9196a8ca3c22ab9e390e)
- The golimit fork was not shown as archived at inspection. Byte-for-byte comparison found the following files identical to wyx2685 v0.4.1: `limiter/limiter.go`, `api/panel/user.go`, `node/task.go`, `node/user.go`, `common/rate/conn.go`, `common/rate/writer.go`, and `core/sing/hook.go`. That preserves the relevant limitations; an active fork name does not by itself establish corrected enforcement. [Pinned fork limiter](https://github.com/golimit/V2bX/blob/a5108d1ba917a68197fd126bc3d1386be54eda8d/limiter/limiter.go), [pinned fork sing hook](https://github.com/golimit/V2bX/blob/a5108d1ba917a68197fd126bc3d1386be54eda8d/core/sing/hook.go)

Dates and maintenance states are observations at research time, not promises of future maintenance. No market-share or production-deployment prevalence was measured.

## 1. Xboard → V2bX: rate-limit trace

### Panel output and node identity

Xboard's `getAvailableUsers` returns the user ID, UUID, `speed_limit` and `device_limit`. Its HTTP `/user` controller returns this collection with an ETag. V2bX's `UserInfo` accepts those fields. [Panel fields](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Services/ServerService.php#L90-L111), [HTTP user response](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Http/Controllers/V1/Server/UniProxyController.php#L24-L39), [node user model](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/api/panel/user.go#L18-L23).

Each V2bX logical node gets its own `Limiter`. The standard node tag combines API host, protocol type and node ID; the user tag is `tag|uuid`. `SpeedLimiter` is a process-local `sync.Map` keyed by this TagUUID. [Node-tag construction](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/node/controller.go#L125-L127), [user-tag construction](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/common/format/user.go#L7-L9), [limiter allocation and keys](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/limiter/limiter.go#L23-L70).

The exact source scope is therefore **user × logical inbound within one process**, not a universally shared VPS-wide or platform-wide user bucket. Multiple logical inbounds on one VPS can have separate buckets, as can separate processes handling the same logical configuration. RouteWeaver's approved logical-ingress identity still needs an explicit runtime mapping; an upstream tag is not automatically that domain identity.

### Units, bucket sharing and directions

`CheckLimit` chooses the minimum nonzero node/user rate, then calculates `Mbps × 1,000,000 / 8`. It creates a juju bucket with a one-second refill interval, capacity equal to that many bytes and refill quantum equal to that capacity. `LoadOrStore(taguuid, bucket)` returns the existing bucket to subsequent connections. [Bucket construction and reuse](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/limiter/limiter.go#L188-L199), [minimum-nonzero rule](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/limiter/dynamic.go#L19-L38).

For example, a nominal 100 Mbps setting produces 12,500,000 bytes per second of refill, with a one-second-sized capacity. This is a token-bucket rate with burst behavior, not a promise that every instantaneous measurement is below 100 Mbps.

In the inspected Xray path, the dispatcher obtains one bucket and uses that **same object for both uplink and downlink writers**. Each writer waits for the byte length it is about to write. Multiple connections for that TagUUID compete for the bucket rather than receiving separate complete allowances. [Both directions share one bucket](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/xray/app/dispatcher/default.go#L184-L216), [byte-based writer](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/common/rate/writer.go#L14-L27).

Consequences of this source path:

- It is not “100 Mbps for every connection.”
- It is not independently “100 Mbps upload plus 100 Mbps download.” The inspected Xray path is shared duplex.
- It is not “all FRA/UK/LAX usage together stays below 100 Mbps.” Different tags/processes/nodes do not share this bucket.
- The `nodeLimit` used here is a ceiling candidate applied to **each user's** bucket, not one aggregate node-egress bucket shared by all users. A differently implemented protocol-specific node bandwidth option is a separate feature.

Shared duplex is an observed implementation fact, **not an additional RouteWeaver product decision**. The user approved rate-limit scope; detailed direction and burst policy remains pending.

## 2. Xboard → V2bX: IP aggregation versus admission

### Panel-side cross-node deduplication is real

V2bX posts `UID → IP list` to `/api/v1/server/UniProxy/alive` and fetches `UID → count` from `/alivelist`. Xboard's config response defaults both push and pull intervals to 60 seconds. [Node fetch](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/api/panel/user.go#L93-L115), [node report](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/api/panel/user.go#L142-L154), [panel periods and endpoints](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Http/Controllers/V1/Server/UniProxyController.php#L55-L93).

Xboard's `DeviceStateService` stores a Redis hash under `user_devices:<userId>`. A field is `<nodeId>:<IP>`, with a report timestamp as its value. The current report replaces that node's prior fields for the user. Port suffixes are stripped and repeated addresses in the report are deduplicated. [Storage and normalization](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Services/DeviceStateService.php#L11-L47), [normalization helper](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Services/DeviceStateService.php#L173-L187).

`getDeviceCount` filters timestamps older than 300 seconds, strips the node prefix and counts unique IPs. `getUsersDevices` similarly returns a deduplicated cross-node list. This establishes actual account-level deduplicated aggregation in the inspected panel, not a simple sum of each node's counts. [Age filter and deduplication](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/Services/DeviceStateService.php#L110-L170).

### HTTP backend admission does not inherit every property of that aggregation

V2bX periodically retrieves the count map and puts it in `Limiter.AliveList`. `CheckLimit` consults that cached count while processing a connection. It also keeps node-local current/previous IP maps. It does not reserve a slot with the panel on every connection, and does not increment `AliveList` when admitting a newly seen IP. [Periodic retrieval](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/node/task.go#L52-L79), [cached-map replacement](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/node/task.go#L170-L173), [admission logic](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/limiter/limiter.go#L126-L186).

Source-path implications, not runtime reproductions:

1. **Count-only feedback cannot identify a globally known IP.** An IP already using FRA can be unseen by UK. If the global count is at the limit, UK can reject that same IP as a new one because its HTTP response does not include the global IP set. Correct panel deduplication therefore does not prove correct cross-entry admission.
2. **Stale-count overshoot is possible.** Different nodes can admit against the same earlier count. Multiple new addresses on one node can also pass while that cached count remains below the limit. This is not an atomic global hard cap.
3. **Request errors relax the view.** The examined `GetUserAlive` path returns an empty map on fetch failure or decoding failure, rather than establishing a fail-closed global cap. [Error handling](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/api/panel/user.go#L93-L115)
4. **Reported online state is not a demonstrated continuous-session heartbeat.** `GetOnlineDevice` resets the local current-IP map after extracting it. Records are created in the connection-check path; the report also filters according to a configurable traffic threshold. A continuously active long-lived connection without another relevant check is not shown to refresh this map indefinitely. The 300-second panel filter must not be promoted to a verified liveness guarantee. [Local extraction/reset](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/limiter/limiter.go#L202-L219), [report filtering](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/node/user.go#L25-L55)

Xboard has a newer WebSocket `sync.devices` path that returns complete merged IP lists. That is a useful panel capability, but the inspected V2bX integration uses the count-only HTTP path. No end-to-end claim about a WebSocket-capable backend is made here. [WS list response and push](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/app/WebSocket/NodeEventHandlers.php#L82-L119).

## 3. Multi-core hooks are not interchangeable

The same panel fields do not establish the same effective enforcement across all cores/protocol paths:

- **V2bX Xray:** the inspected dispatcher path checks the limiter and wraps both directions in the shared byte bucket, as traced above. The IP branch is gated by a transport-derived flag; this report does not infer universal protocol coverage from that one path.
- **V2bX sing-box TCP:** the hook uses `CheckLimit` and wraps the connection in `NewConnRateLimiter`. The wrapper's reads and writes both consume the supplied bucket. [TCP hook](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/sing/hook.go#L30-L44), [duplex connection wrapper](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/common/rate/conn.go#L9-L34)
- **V2bX sing-box UDP:** the packet hook calls `CheckLimit` with the IP-branch flag false. Its rate-wrapper line is commented out. That path therefore does not demonstrate the same IP admission or rate shaping as TCP. [Packet hook](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/sing/hook.go#L78-L92)
- **V2bX native Hysteria2:** event callbacks call `CheckLimit` but discard its bucket, retaining the rejection result as an `OverLimit` flag. The traffic callback can return false for that flag. This is not the same byte-writer shaping path or necessarily the same admission timing. Native Hysteria2 node-level `MaxTx`/`MaxRx` configuration is separate from this per-user bucket. [Connection/request hooks](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/hy2/logger.go#L49-L109), [traffic callback](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/hy2/hook.go#L28-L58), [native bandwidth configuration](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/core/hy2/config.go#L154-L164)

These findings explain why runtime adapter capability checks matter. A thin configuration renderer alone does not reproduce these backend hooks. They are not a decision to embed a particular core or adopt a fork.

## 4. Historical XrayR alternative

All references in this section point to the pinned official v25.3.6 source, not current empty HEAD. The limiter and rate-writer files were also compared with v0.9.4 and were identical in those two snapshots.

### Local shared-duplex rate buckets

The NewV2board adapter reads the panel's `speed_limit` and converts decimal Mbps to bytes per second. A positive local `ApiConfig.SpeedLimit` overrides that value. Its generated user email is based on the UUID. In this adapter, the device limit still comes from local configuration, not a demonstrated panel `device_limit` field. [User model](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/api/newV2board/model.go#L70-L74), [conversion and local overrides](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/api/newV2board/v2board.go#L240-L259).

The effective user identifier is `inboundTag|email|UID`. Each `InboundInfo` receives its own process-local `BucketHub`; `LoadOrStore` returns the same `*rate.Limiter` for later connections with that identifier. The rate and burst are both numerically the byte-per-second limit. Both dispatcher directions receive the same bucket. [User tag](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/service/controller/userbuilder.go#L162-L164), [controller wiring](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/service/controller/controller.go#L98-L115), [per-inbound allocation](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L53-L95), [shared bucket](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L208-L220), [both directions](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/app/mydispatcher/default.go#L148-L183).

`determineRate` takes the minimum nonzero node/user value. Again, the node value is applied to individual user buckets; there is no single shared total-egress bucket in this trace. No rate bucket is stored in Redis. [Rate selection](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L272-L291).

Implementation caveats prevent interpreting this design as a fully verified hard aggregate cap under every lifecycle:

- Periodic `GetOnlineDevice` clears admission-time IP records and deletes buckets for users missing from those records. Existing writer objects retain their old bucket pointers. From the source, a long-lived stream and a later new connection can potentially retain/use separate old/new buckets after cleanup; this was not runtime-reproduced.
- `RateWriter` uses `context.Background()` and ignores the `WaitN` error return.

[Cleanup](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L132-L155), [writer and bucket reference](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/rate.go#L12-L32).

### Optional shared Redis IP cache

`GlobalDeviceLimitConfig.Enable` creates a local go-cache followed by a Redis cache, with the local cache taking priority. Both use the configured expiry. The sample has the feature disabled, with a five-second request timeout and 60-second expiry. Nodes need access to the same Redis database for this sharing path. [Cache initialization](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L61-L83), [example configuration](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/release/config/config.yml.example#L41-L49).

The global cache key replaces the inbound tag in the composite user identifier with the configured device limit. The resulting identity is effectively `DeviceLimit|email|UID`; its value is an `IP → UID` map. This can deduplicate identical IPs across nodes only when the other identity components and Redis database agree. Different configured limits split the key. A panel/tenant namespace is not added by this transformation. [Key and map](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L227-L257).

The actual control sequence is a cache GET of the complete map, local comparison, local map modification, and asynchronous SET of the complete map. This path contains no atomic global check-and-add. Relevant consequences inferred from that code are:

- Concurrent writers can overwrite each other's additions; local-first caches can miss another node's new IPs.
- The comparison is `len(map) > deviceLimit` **before** inserting the arriving IP. A map with exactly N entries can admit another when the limit is N; once an oversized map is seen, even an existing IP is rejected before membership is tested.
- A missing cache entry is asynchronously initialized and allowed. Other GET failures are logged and allowed. SET failures are logged after admission has already proceeded.
- The value has no per-IP last-seen time or disconnect removal. Existing members do not trigger a write in this function, so this is a whole-map TTL rather than a demonstrated per-IP live-session lease.
- Checks occur while a link is dispatched. This is not evidence that all established connections are proactively terminated when a remote node changes the count.

[GET, comparison, asynchronous SET and failure behavior](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/common/limiter/limiter.go#L230-L270), [dispatch-time rejection](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/app/mydispatcher/default.go#L169-L183).

This is approximate anti-sharing logic, not evidence of strict global online-IP admission or distributed rate shaping.

### Panel adapter differences must not be hidden

The inspected NewV2board adapter's `ReportNodeOnlineUsers` is a no-op. One cannot assume every XrayR panel adapter reports online IPs just because another adapter does. [No-op method](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/api/newV2board/v2board.go#L302-L310).

The SSPanel adapter does report UID/IP pairs and uses panel-reported `alive_ip` to compute a node allowance from the account limit minus the panel count plus this node's prior reported count. This is another periodic-feedback pattern, not per-connection central authorization. The SSPanel server's own deduplication was not inspected here, so its global-count semantics are not asserted. [SSPanel report](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/api/sspanel/sspanel.go#L290-L315), [allowance calculation](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/api/sspanel/sspanel.go#L692-L730), [default refresh period](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/panel/defaultConfig.go#L23-L29).

## Deployment and license facts, not a stack decision

- **Xboard control plane:** PHP/Laravel, not Go/Rust. Its current dependency manifest includes Laravel, Octane, Horizon and Redis-related components. Adopting the whole panel would therefore be a distinct stack choice, not simply a Go/Rust library reuse. [Manifest](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/composer.json#L12-L38)
- **Xboard Redis:** the default image installs Redis and the supervisor configuration starts it. The inspected HTTP backend path communicates with the panel, not directly with Redis. Redis is a real component even when bundled in one container; this setup does not require a global Redis operation for every transferred byte. [Image](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/Dockerfile#L1-L13), [Redis service](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/.docker/supervisor/supervisord.conf#L43-L65), [compose example](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/compose.sample.yaml)
- **XrayR global-device mode:** adds node-side connectivity to a shared Redis instance/database and caching behavior. Adding that component does not turn its non-atomic algorithm into a hard cap.
- **Root license identifiers:** Xboard is MIT; the inspected V2bX and XrayR snapshots are MPL-2.0. This is a file-level observation, not a legal conclusion that an entire distribution has one license. Embedded cores, dependencies, frontend assets and any redistributed modifications require their own license review. [Xboard LICENSE](https://github.com/cedar2025/Xboard/blob/4f48e61a2cbc6db5338872b6bdb45ef954ec1256/LICENSE), [V2bX LICENSE](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/LICENSE), [XrayR LICENSE](https://github.com/XrayR-project/XrayR/blob/974abc9a98d8b64f7f0a7b7b3044140087a1bc4e/LICENSE), [V2bX core dependencies](https://github.com/wyx2685/V2bX/blob/71277de69efbbc86c23ad8ae02b68efd174e5756/go.mod#L7-L25)

Removing or hiding monetary billing from a complete panel, adopting its UI, or implementing conversion-profile management was not evaluated by this limit-focused inspection. No low-maintenance claim for such a migration is made.

## Remaining capability acceptance questions

The approved product scope can stay modest without pretending these examples already satisfy every requirement:

1. The same observed public IP using two platform ingresses must remain one account-level IP and must not be incorrectly rejected merely because it is locally new at the second ingress.
2. The active window, stale-report treatment, maximum intended enforcement lag, concurrent-arrival overshoot, and over-limit consequences need explicit product decisions. No window from an upstream implementation is silently adopted.
3. A rate policy must state user × logical-ingress identity, upload/download treatment and burst behavior. The sources' shared-duplex buckets do not resolve RouteWeaver's remaining direction/burst choices.
4. Each selected core/protocol/version must actually expose the hooks needed to enforce the chosen policy. Configuration output alone, a panel field, or a README feature checkmark is insufficient.
5. Account-global quota accounting remains separate from bandwidth shaping and online-IP admission. Reset cycles, measurement boundaries and existing-session consequences are not established by this report.

These are capability gaps and decision boundaries, not a new algorithm design or authorization to build distributed shaping. The current decision is **global account quota/IP accounting plus user-by-logical-ingress rate limits**, with no strict cross-ingress aggregate speed cap.

## Verification and exclusions

Completed: read pinned public source; trace panel fields, identity keys, bucket allocation and consumers; distinguish IP aggregation from cached admission; compare specified fork files; inspect root license and deployment files; record maintenance status and the later user-approved scope.

Not performed: compilation, proxy/core execution, network traffic tests, benchmarks, packet capture, real-account access, VPS changes, backend deployment, implementation changes, exhaustive dependency/license audit, or a survey of commercial operator behavior. Source-path failure scenarios above are explicitly inferences, not observed runtime reproductions. No backend fork has been selected.
