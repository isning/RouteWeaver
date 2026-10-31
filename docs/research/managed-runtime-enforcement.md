# Managed native-runtime enforcement

Status: **POSITIVE XRAY LOOPBACK PROOF; PRODUCTION INTEGRATION OPEN**. Researched 2026-10-19 UTC. This supplements [core-limit capabilities](core-limit-capabilities.md) and [airport implementations](airport-limit-implementations.md). It does not close RW-14/F05 or change the approved user × logical-entry, shared-UL+DL rate scope.

## Recommendation

Implement a separately identified managed Xray executable that embeds the **unmodified official core** and decorates its exported routing dispatcher. Keep its adapter ID, capability manifest and release lifecycle distinct from the stock downloaded Xray executable, whose API still lacks the required generic controls. Keep native dependencies in a separate Go module. This reuses the actual protocol/routing implementation rather than copying a dispatcher or adopting a core fork.

The exact proof pin is `github.com/xtls/xray-core v1.260327.0`, corresponding to release 26.3.27, SHA `d2758a023cd7f4174a5a5fa4ff66e487d4342ba0`. Go module origin metadata verified that SHA. sing-box remains pinned to 1.14.3, SHA `7054cac5124465ffdb145870d7c01885566711b1`, with source-level extension feasibility but **no runtime proof here**.

## Positive executable evidence

A standalone test module and logs are preserved at `/workspace/shared/routeweaver-xray-proof/`. It starts official embedded Xray on loopback, authenticates real VLESS requests using synthetic credentials and proxies real TCP bytes to a loopback echo server. It does not fabricate an authenticated dispatcher context.

- `TestNativeSharedRateIPAndRevoke`: the same authenticated account and source 127.0.0.2 at entry-a and entry-b count once; 127.0.0.3 is rejected with cap=1. The test authority is atomic **in-process**, not a demonstrated cross-node authority.
- Two simultaneous entry-a TCP flows share one limiter across both directions. 32,768-byte echo input per flow produces exactly 131,072 counted UL+DL bytes. At 65,536 B/s plus a 4,096-byte initial burst, the first run took 1.938151397s. Entry-b has a separate bucket. This is token-bucket behavior, not an instantaneous hard-rate claim.
- Revocation first denies new admission, then interrupts tracked links/closes direct TCP sessions. A subsequent payload on an existing connection fails; fresh authenticated dispatch also fails. First-run local revoke observation was 190.607 microseconds, **not a fleet latency promise**.
- `TestNativeMuxCachedAuthCannotResumePayload`: an authenticated VLESS mux carrier carries one successful inner stream. After revocation, a new-stream frame is still writable to the carrier, but upstream mux invokes the wrapped dispatcher and receives denial. The old logical link is interrupted; post-revoke metered delta is zero. Upstream then ends the mux worker following dispatch failure. This establishes payload enforcement despite cached authentication, not a generic per-user carrier-kick RPC.

Validation: `go test -v .` passed; `go test -race -count=3 -v .` passed both tests three times without a race report. Repeat shared-duplex timings were 1.9385–1.9393s; local revoke observations 0.349–0.493ms. IPv4 loopback only. Executor wall-clock log labels differ from the task clock; elapsed timings use Go monotonic duration.

Reproduction, allowing official Go module downloads if the temporary module cache is absent:

```
cd /workspace/shared/routeweaver-xray-proof
GOTOOLCHAIN=local GOPATH=/workspace/shared/routeweaver-tools/go-path \
GOMODCACHE=/tmp/routeweaver-xray-proof/mod \
GOCACHE=/workspace/shared/routeweaver-tools/go-cache \
/workspace/shared/routeweaver-tools/go/bin/go test -race -count=3 -v .
```

Proof source SHA-256 after gofmt: `39def3ecaa1ae922e76b2fbc1b90af8594fb5ecf3c359c56892135f3624b6611`. This is **not production code**: it has a test-only protobuf config/global construction pointer, simplified stream-reference cleanup, in-memory metering, no durable source/WAL, CP integration, quota or expiry scheduling. Reader leftover-buffer release, half-close, natural mux termination, partial write outcomes and concurrent revocation need production treatment.

## Fork-free Xray codepaths

- [Dispatcher](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/features/routing/dispatcher.go) explicitly exposes `Dispatch` and `DispatchLink`. Both must be gated/wrapped.
- [Config registry](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/common/type.go) permits an adapter-owned protobuf config creator. Inside that creator, `common.CreateObject(ctx, &dispatcher.Config{})` constructs the stock dispatcher with upstream dependency wiring. Return its decorator and register **only that decorator** as the Dispatcher feature. Use private context state with [core.NewWithContext](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/core/xray.go), not the proof's singleton.
- [Stock dispatcher](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/dispatcher/default.go): returned Dispatch link is client-facing (Writer=UL, Reader=DL); DispatchLink input is outbound-facing (Reader=UL, Writer=DL). Measure/wrap each direction once.
- [Session metadata](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/common/session/session.go) exposes User, Tag, Source and Conn. [VLESS authentication](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/proxy/vless/inbound/inbound.go#L530-L637) populates User before dispatch. [Inbound mux binding](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/app/proxyman/inbound/always.go#L79-L85) and [inner dispatch](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/common/mux/server.go#L230-L269) explain the positive cached-auth test.

### Splice and source identity are explicit safeguards

[CopyRawConn](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/proxy/proxy.go#L720-L777) can bypass ordinary byte wrappers via raw socket splice. Set `session.Inbound.CanSpliceCopy=3` before delegation for managed policy traffic. VLESS sets Vision eligibility before dispatch, so this hook is placed after that assignment. **Vision/REALITY were not executed**: keep their capabilities unverified until real tests demonstrate the prevention and its performance cost.

[Special mux metadata paths](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/common/mux/server.go#L163-L174) can replace inner Source/Local. Capture a trusted public-ingress peer, not an arbitrary inner-forwarded source. The proof uses Conn.RemoteAddr when present. Proxy protocol, CDN forwarding, reverse paths and UDP source provenance require separate validation. Transit listeners must not report VPS addresses as client devices.

## sing-box: available hooks, not yet verified

The pinned [Router/ConnectionTracker interfaces](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/adapter/router.go) expose TCP, PacketConn and `RoutedFlow` hooks. [Box.Router and its own tracker attachment](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/box.go) make a wrapper possible without a fork. [VLESS](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/protocol/vless/inbound.go#L168-L209) and [Hysteria2](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/protocol/hysteria2/inbound.go#L227-L268) supply user/source metadata for routed TCP/UDP; configure nonempty unique user names.

Tracker-only is not a universal policy gate: [DNS hijack returns before trackers](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/route/route.go#L140-L176), with a corresponding UDP early return. Initially reject such route actions. A fuller fork-free option decorates [InboundRegistry.Create](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/adapter/inbound.go), passing stock inbound constructors a Router decorator whose RouteConnectionEx/RoutePacketConnectionEx apply policy before native routing. Preserve upstream demultiplexing and prevent detour double counting.

[sing-mux](https://github.com/SagerNet/sing-mux/blob/caf09fe32475/server.go) and [Hysteria2](https://github.com/SagerNet/sing-quic/blob/75c3ac4fa12b/hysteria2/service.go#L261-L363) keep authenticated carriers distinct from logical flows. Gate each new logical flow and close all tracked active flows; do not claim closing one stream closes QUIC. UDP wrappers must preserve datagram boundaries and prevent optimized-copy bypass. No sing-box execution or retry around the known netlink sandbox denial occurred.

## Why V2bX is not the selected foundation

The existing report already establishes count-only global-IP admission flaws and UDP gaps. [golimit's pinned go.mod](https://github.com/golimit/V2bX/blob/a5108d1ba917a68197fd126bc3d1386be54eda8d/go.mod) additionally replaces both cores with forks: sing-box_mod SHA 533dad01b645 and Xray SHA 63db1dc9e9e2, not the required official pins. Its hook lacks sing-box 1.14's new RoutedFlow method; a dependency bump alone is not sufficient.

A bounded extra maintenance check inspected unarchived [ShylyPP](https://github.com/ShylyPP/V2bX/tree/8dcd092d52c4b7cd1df826dcd799d9e15a6930d1), [pkhosn](https://github.com/pkhosn/v2bx/tree/5dec4d0e8a8ae1b4d9fde939c02f96781b874bee) and [Sakawat-hossain](https://github.com/Sakawat-hossain/V2bX/tree/0fc2d5ed2fe1aaa9bf5b6eeb4850aad43918c9f4) HEADs dated 2026-04-30, 04-22 and 07-12 respectively. All still use older core versions/Xray replacements. Sakawat has useful synchronization/rate-update changes, but [its UDP hook](https://github.com/Sakawat-hossain/V2bX/blob/0fc2d5ed2fe1aaa9bf5b6eeb4850aad43918c9f4/core/sing/hook.go) still disables that IP-check branch and comments out packet rate limiting; [its limiter](https://github.com/Sakawat-hossain/V2bX/blob/0fc2d5ed2fe1aaa9bf5b6eeb4850aad43918c9f4/limiter/limiter.go) still consumes count-only AliveList. This is not an exhaustive fork survey. Replacing those mechanisms while rebasing forks offers less reuse than the directly demonstrated upstream seam.

## Smallest production integration

1. **Model authenticated principals.** ServerProgram's single Listener.Connection is not a multi-user platform model. Add a principal list binding authenticated email/name to stable AccountID, public-entry credential grants, logical EntryID, route binding and applied credential/policy revisions. Separate public and transit roles. Do not derive account identity from a user-editable label or conversion profile.
2. **Managed runtime/profile.** Adapter-owned protobuf config, official module pin, strict supported-profile validation, separate managed adapter/capability version. Begin with the demonstrated VLESS TCP paths. Do not silently claim SOCKS, UDP, Vision, QUIC or other protocols.
3. **Admission/revocation engine.** Atomically advance policy generation/deny state before canceling tracked flows. Recheck generation after delayed authority responses and during flow registration. Apply pause, expiry and quota denial through this same engine, driven by monotonic local deadlines and bounded persisted leases rather than only a remote poll. Report actual stopped/unknown observations separately from an allow/deny decision.
4. **Account-global IP authority.** Central transactional membership-before-cardinality check for AccountID × canonical IP; lease references keyed by node/epoch/session prevent stale disconnects deleting newer admissions. Same IP at a second entry does not consume a slot. Long-lived active sessions renew leases; fail closed after authority validity expires. Do not reclaim a partitioned slot while its old grant can still transmit. A transactional CP database can supply the initial authority; Redis is not inherently required.
5. **Shared rate object.** One stable bucket per account × logical entry, retained while any flow is active, updated in place and shared by UL+DL. Do not reset/delete on telemetry extraction. One owning runtime per logical entry initially: multiple replicas/processes do not magically share a process-local bucket.
6. **Durable once-per-route measurement.** Bind the selected public-entry payload boundary to AccountID, RouteID, counter epoch, cycle and immutable policy revision. Reuse MeterSample/MeterSpool after implementing a durable source; a durable outbox alone does not eliminate loss before enqueue. Persist epoch before admitting traffic. WAL/checkpoint and idempotent source sequencing must handle restart/crash. Strict admission-boundary recording can journal accepted byte chunks before forwarding with group-commit backpressure; periodic checkpoints instead require an honest uncertainty interval. Never sum user/inbound/outbound views or charge each relay hop. Payload bytes are not NIC/wire billing bytes.
7. **Quota allocation is separate.** Bounded centrally allocated byte budgets or an explicitly bounded lease allowance prevent unbounded cross-node overshoot. Keep reserved quota, measured usage and unresolved crash uncertainty distinct. Historical samples retain route multiplier/cycle identity; a current multiplier must not rewrite old usage.
8. **Integrated acceptance.** Add two-node concurrent IP arrivals, same-IP second-entry at cap, partition/restart/stale-release, delayed allow versus revoke, rate hot-update, blocked I/O, half-close, mux cleanup, durable crash/replay, native route attribution and expiry/quota tests. Add protocols only through their own real runtime evidence. This proof unblocks implementation; it does not close RW-14 or F05.

## Maintenance/license facts

[Xray's pinned LICENSE](https://github.com/XTLS/Xray-core/blob/d2758a023cd7f4174a5a5fa4ff66e487d4342ba0/LICENSE) is MPL-2.0; inspected V2bX roots are also MPL-2.0. [sing-box's pinned LICENSE](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/LICENSE) says GPLv3-or-later and adds a naming/association restriction. An embedding binary does not inherit only the wrapper's license. Distribution/combined-work review is required; these are source-file facts, not legal advice.

Pin module SHA, toolchain, build tags and capability version; compile and protocol-test proposed upgrades. Exposed Go hooks still have maintenance cost, demonstrated by sing-box's new RoutedFlow method. Per-user isolated cores multiply runtime/config/listener/restart costs by users × entries and still do not solve global-IP or durable accounting. No resource benchmark was performed and that architecture is not selected.
