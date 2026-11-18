# Core support audit — 2026-11-18

Scope: current workspace source, including existing uncommitted changes. Read-only product audit; no production implementation or live node configuration changed. This is not exhaustive upstream parity certification.

## Follow-up

Implementation and current verification are tracked in [the completion record](CORE-COMPLETION-2026-11-18.md). The gaps below describe the audit input before that follow-up; they are not a current all-or-nothing capability declaration.

## Conclusion

RouteWeaver implements bounded adapters, not the complete configuration surface of sing-box, Xray or Mihomo. Import, client generation, ordinary server generation and managed account enforcement have different contracts. A successful parser or unit test does not prove native traffic or deployed enforcement.

## Current matrix

| Surface | Current implementation | Important boundaries |
| --- | --- | --- |
| sing-box client | 1.14.3; SOCKS5, three AEAD Shadowsocks methods, VLESS, Trojan, VMess AEAD, Hysteria2, AnyTLS | Manual/URL-test groups; DNS, sniff, TUN; bounded native extensions; not arbitrary native connections |
| sing-box ordinary server | 1.14.4 and historical 1.14.3; same seven protocols | One listener per ServerProgram; principal-based multi-user provisioning limited to VLESS; no managed-sing-box equivalent |
| Xray ordinary server | 26.10.31, 26.10.29, historical 26.3.27; SOCKS5, Shadowsocks, VLESS, Trojan, VMess | Modeled TCP, WS, HTTPUpgrade, gRPC; bounded REALITY handling; no XHTTP form/render/import path |
| Managed Xray | 26.3.27-rw1; authenticated VLESS TCP with optional ordinary TLS | TCP payload/native mux; no Vision, REALITY, UDP or other entry protocols/transports; not stock-Xray capabilities |
| Mihomo client | 1.19.32; SOCKS5, Shadowsocks, VLESS, Trojan, VMess | No RouteWeaver Hysteria2/AnyTLS output; manual/URL-test/fallback/load-balance groups; no portable TUN capability (bounded native extensions differ) |
| Import | URI/base64, Mihomo proxies, sing-box outbounds | Connection extraction only; not lossless full-config import; unknown behavior fields reject the candidate |

## Prioritized gaps

1. **Agent verification failure (investigate before readiness claims).** `TestBoundedDriverReconcilesReportsAndStopsOwnedSession` fails with `no observed status report`. The four-package run failed in agent; isolated repetition failed all five runs. The test uses an 80 ms driver runtime; root cause is not established and no timeout/assertion was weakened. This is a reproducible verification failure, not evidence that a deployed native core has failed.
2. **Managed enforcement is not portable across cores.** Stock sing-box/Xray configurations must not be advertised as supplying the managed runtime's account-global admission, quota, rate and revocation enforcement. Managed entry remains VLESS/TCP only. Generic VLESS principal projection is not itself managed enforcement.
3. **Protocol import/output asymmetry.** `fromMihomo` recognizes only socks5/ss/vless/trojan/vmess; Hysteria2/AnyTLS are unsupported there and in Mihomo output, even though sing-box supports them. A subscription containing unsupported connections rejects the candidate rather than quietly losing those connections.
4. **Hysteria2 is a direct-only subset.** No obfuscation (including Salamander), port hopping, bandwidth settings or Hysteria2 connector detours. The earlier user-provided obfuscated HY2 sample is therefore not supported unchanged.
5. **AnyTLS supports bounded server detours, not arbitrary chains.** Current code allows one SOCKS5, ordinary TLS/TCP Trojan or restricted ordinary TLS/TCP VLESS relay, or two ordinary TLS Trojan relays. AnyTLS cannot itself be an upstream relay; arbitrary mixed/deeper chains remain rejected. URI import exists now. Earlier direct-only/no-URI prose is historical.
6. **Common advanced protocols/options are absent from the structured connection model.** TUIC, WireGuard, Tailscale endpoints, Naive, ShadowTLS, HTTP proxy connections, Shadowsocks 2022, XHTTP, VLESS post-quantum encryption options, and general per-connection multiplex/socket controls are not exposed as complete typed import/render/edit paths. Bounded native client DNS/routing extensions do not unlock arbitrary proxy connections. This list compares upstream surface, not an assertion that each feature is a required product commitment.
7. **Versions and documentation diverge.** Ordinary server catalog supports sing-box 1.14.4/Xray 26.10.31, while client output remains sing-box 1.14.3/Mihomo 1.19.32. That separation may be deliberate, but is not universal latest-version support. Package READMEs still describe older exact version gates and the importer README omits newer HY2/AnyTLS URI support. The chronological endpoint verification document contains superseding additions; its original limitations cannot be read in isolation.
8. **Full upstream routing/import parity is absent.** Portable rules cover domain, suffix, CIDR, resources and supported boolean expressions; Xray server policy is narrower. Native client extensions cover richer target-specific fields but deliberately protect generated identities/resources. Complete native program import, arbitrary listener management and automatic cross-core semantic translation are not implemented.
9. **Runtime acceptance remains separate.** Local documentation records sing-box netlink startup denial. This audit did not rerun native parser/traffic tests, OS TUN tests, CI or real VPS acceptance. The new public probe monitor measures ingress TCP/ICMP reachability, not authenticated proxy handshakes, UDP forwarding, correct exit selection or accounting.

## Evidence anchors

- `internal/render/client_singbox.go`, `client_mihomo.go`, `client_registry.go`: client protocols, strategies, versions and guards.
- `internal/render/server.go`, `server_policy.go`: server versions, principal roles and bounded detours.
- `internal/domain/models.go`, `profile.go`, `profile_validation.go`: modeled protocols/options and rejected combinations.
- `internal/importer/import.go`, `native.go`: URI support and format asymmetry.
- `internal/render/native_policy.go` and `docs/design/native-client-overrides.md`: bounded native additions.
- `runtimes/xray/README.md`: managed entry/enforcement limits.
- `docs/verification/ENDPOINT-CAPABILITIES-2026-10-29.md`: chronological protocol increments and native acceptance scope.

## Verification executed

`scripts/go.sh test -p=1 ./internal/domain ./internal/importer ./internal/render ./internal/agent`: domain/importer/render passed; agent failed the state-report test above. Log: `bin/core-support-audit-tests.log`.

Isolated `scripts/go.sh test -p=1 ./internal/agent -run '^TestBoundedDriverReconcilesReportsAndStopsOwnedSession$' -count=5`: failed all five repetitions. Log: `bin/core-support-audit-driver-recheck.log`.

Native environment variables were not requested; ordinary package success does not imply execution of optional native tests. No full repository gate, independent review, source publication or deployment was performed.

## Upstream comparison references

- https://sing-box.sagernet.org/configuration/outbound/
- https://sing-box.sagernet.org/configuration/endpoint/
- https://xtls.github.io/en/config/transport.html

Moving official documentation was consulted for broad feature categories, not used to confer compatibility with unverified versions.
