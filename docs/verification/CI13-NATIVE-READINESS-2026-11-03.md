# CI13 native client readiness diagnosis

## Finding and scope

The fixture treated a listening mihomo mixed port as proof that its tunnel was running. The pinned mihomo source creates listeners before it accepts ordinary tunnel traffic. A test-only startup synchronization fix now waits for the official `-post-up` hook plus the same TCP listener, within the existing five-second deadline. It never retries the actual user traffic request, changes downloaded configuration, or increases a timeout.

This is a confirmed fixture readiness defect and a locally reproduced explanation for the observed failure shape. CI13's original artifact does **not** contain its child-process log or relay counters, so the historical incident cannot be uniquely assigned to this mechanism. It is not being labeled an unexplained environmental fluctuation or a proven original-incident root cause.

## Original evidence

- CI13: remote `fb6cd7ab41683ed510e499a08c781a60f273a1e8`, canonical `eddb9bd19c71f1440ba3d93440d0f90a47e0e38c`, [run 41582547062 / native job 125740448727](https://github.com/isning/RouteWeaver/actions/runs/41582547062/job/125740448727).
- CI12: [run 41573808550 / native job 125712589777](https://github.com/isning/RouteWeaver/actions/runs/41573808550/job/125712589777). The same delivery test passed in 1.54 seconds. CI12 and CI13 used the same Go 1.27.3, mihomo 1.19.32, sing-box 1.14.3, core hashes, runner version, OS image, native harness and workflow. Their application delta was web code and layout documentation; relevant backend/render/test objects were unchanged.
- CI13's first IP-address request got status 502 and an empty response body after about 0.19 seconds of test runtime. `err=nil` was the error returned by `io.ReadAll`, not evidence of successful forwarding. The test did not reach delegated DNS, reject rules, rotation or peer-failure assertions.
- The target was an owned `httptest` HTTP server on loopback. The path was HTTP proxy mixed port → owned SOCKS peer → owned HTTP origin. The first request did not need DNS or an external destination. HTTP, SOCKS, startup and process deadlines were respectively 2, 3, 5 and 20 seconds; none explains this immediate response as an elapsed timeout.
- CI13's subsequent sing-box delivery and both configured-DNS native cases passed. This alone does not establish the earlier failure's cause.
- Artifact `13205589033` (`native-diagnostics`, 21,103 bytes) was retrieved through the GitHub artifact-download connector. ZIP SHA-256: `3bb964a3b28006434ff018c366043c01c2d8bd95979436fe5cb0ece3f073910f`. It contains bootstrap and parser/runtime JSON logs, but no child `native.log` or downloaded config. Runtime log SHA-256: `8236a8bc575a4d5562761d049fcf9d8c1c1e9e080867743acfe3209164fa17a7`.

## Pinned upstream lifecycle

1. [`executor.ApplyConfig`](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/hub/executor/executor.go#L79-L116) updates listeners, then enters inner-loading/provider initialization/GC, and only finally calls `tunnel.OnRunning`.
2. [`handleTCPConn`](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/tunnel/tunnel.go#L473-L477) closes ordinary connections while the tunnel is not ready. The HTTP listener's [internal pipe](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/listener/http/client.go#L24-L37) therefore fails and its [proxy handler](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/listener/http/proxy.go#L113-L116) emits an empty 502.
3. [`main`](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/main.go#L201-L219) runs `-post-up` synchronously after `hub.Parse`/`ApplyConfig` returns, hence after `OnRunning`. This is an explicit lifecycle signal, unlike a socket connection or HTTP/SOCKS CONNECT acknowledgement (which may be sent before tunnel handling).

## Controlled reproduction

Only pinned official Go and mihomo assets were installed in an independent worktree based on the exact canonical commit. No production binary, renderer, downloaded feed, business assertion or timeout was changed for the before run; added diagnostics captured process logs, exact binary/config hashes, phase, origin requests, relay counters and bounded handshake trace.

Command, with the exact pinned mihomo executable selected through `ROUTEWEAVER_MIHOMO_BIN`:

```sh
ROUTEWEAVER_CLIENT_PROCESS_TESTS=mihomo scripts/go.sh test -v ./internal/httpapi \
  -run '^TestNativeInvitedUserDownloadedClientTraffic/mihomo$' -count=20 -timeout=120s
```

The diagnostic-only run failed, rather than hiding or retrying failed assertions: 4 of 20 independent startup samples reproduced the same initial-IP empty 502; 16 completed all assertions. All four failures occurred 22–23 ms after process start, with zero origin requests and zero SOCKS connections/requests/accepts, and an empty relay trace. This narrows the reproduced failure to before relay ingress, consistent with the lifecycle ordering above; it does not recreate missing historical CI13 process evidence.

- Diagnostic-before log SHA-256: `94b0663bd6a5ea64cb31812c8360ded865ac84c333cca842c509b911c86c7c1d`.
- Go 1.27.3 archive SHA-256: `65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40`.
- Mihomo archive SHA-256: `306f81e723e60ce6b828899a6fe83e1d00e9ecefb2dc8d4d849312a5bc00efdc`.
- Mihomo executable SHA-256: `6de241191ca39f9ac1cd6e3194fc9303c19055d3549c8bdb4ff1349c89173819`.

## Change and regression contract

- Each mihomo child gets a freshly allocated, private marker directory within its private cwd. An old process's marker cannot satisfy a new instance, even if the parent cwd were reused.
- The fixed post-up shell command writes only `ready` to its quoted marker path. Paths containing spaces, quotes and shell metacharacters are covered. There is no downloaded script or untrusted command content.
- Readiness requires exact marker contents and a successful loopback TCP connection. Missing/partial/wrong markers, missing listener, early process exit and deadline expiration fail. Exit is a closed-channel broadcast, so readiness cannot consume cleanup's exit notification; an already-exited process cannot be accepted merely because its marker exists.
- The existing five-second startup budget, 20-second child budget and request timeouts remain unchanged. No readiness traffic reaches the SOCKS peer or HTTP origin; the original first business GET is still sent once and its exact relay-count assertions remain intact.
- The configured-DNS native test used the same defective TCP-only gate, so it shares the fixed helper. The mihomo hook is not applied to sing-box.
- Both native tests retain process logs, binary/config hashes, addresses, marker and fixture counters on failure. Delivery adds a bounded SOCKS trace. These diagnostics reach the existing runtime JSON artifact via normal test logging without publishing feed contents.

## Verification and limits

- Focused readiness, SOCKS destination-boundary wire and DNS fixture/publication tests passed.
- After the fix, 20 independent delivery starts and 20 independent configured-DNS starts passed, preserving the original positive/negative traffic assertions. Command:

```sh
ROUTEWEAVER_CLIENT_PROCESS_TESTS=mihomo scripts/go.sh test -v ./internal/httpapi \
  -run '^TestNative(InvitedUserDownloadedClientTraffic|DownloadedClientConfiguredDNS)/mihomo$' \
  -count=20 -timeout=120s
```

- Repetition is bounded regression evidence, not a proof over every process schedule. The lifecycle signal, not repetition count, is the reason for the fix.
- The same focused readiness/SOCKS/DNS fixture suite passed under `-race -count=5` (11.340 seconds).
- After-fix native log SHA-256: `3738ca52b3e0a242ad8ed66b84e4d788d5b0c963bfb70e95f095597e179973e3`.
- Independent read-only review found no blocking defect in marker ownership, quoting, exit notification, timeout preservation or request semantics; the review is bound to the tested file hashes below.
  - `client_readiness_test.go`: `30f817da987710a1b238c228cc89771985ad293b89db80bc540bc0db8aec77a6`.
  - `client_delivery_native_test.go`: `ca6e85bb78e47997b8b931bd8d3b2448fbbc34e429d2dbfff9216368a77a0f0c`.
  - `client_dns_native_test.go`: `ebcb864538dfb23ac7a28015321a0ed9773fe6c424a25b31aa934a0876565576`.
- No local sing-box process/netlink startup was attempted, and no host network/security setting, live node, deployment, credential or remote branch was changed. Full native CI, including sing-box, remains the coordinator's next verification step on the integrated exact commit.
