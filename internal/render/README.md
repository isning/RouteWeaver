# Compilation contracts and evidence

This package has three separate interfaces:

- `DefaultClients().Render(ClientProfileIR, Target, OutputMode)` generates a full client configuration or an explicit nodes-only fragment. It never constructs server topology or deployments.
- `DefaultServers().Render(ServerDeploymentIR)` generates one config per managed instance. Canonical adapter IDs are `routeweaver/xray` and `routeweaver/sing-box`, matching the runtime registry. Named connectors form a directed acyclic graph; rules and default actions refer to stable connector IDs. The earlier ordered `Egress` field is a compatibility adapter and cannot be mixed with named connectors.
- `Default().Render(Route, []Node)` is a temporary compatibility interface for the old **client-chain preview**, not server deployment. It no longer imposes a two-hop limit.

Adapters are registered through interfaces, not a closed family enum. Exact version gates currently are Xray 26.3.27, sing-box 1.14.3, and Mihomo 1.19.32. An unknown version cannot silently inherit another version's support. The synthetic third-adapter test proves registration extensibility only, not a third production implementation.

## Native-checked positive slice

`TestNativeClientFixtures` compiles full profiles with nested selection, ordered and logical rules, external local rule files, DNS and sniffing. Mihomo includes all four strategies (select, URL test, fallback, load balance); sing-box includes TUN. Readable labels with parentheses/brackets/commas are exercised. `TestNativeVLESSClientFixtures` covers both clients with VLESS TCP + REALITY/Vision, WebSocket TLS, gRPC TLS and HTTPUpgrade TLS, preserving explicit XUDP. `TestNativeServerFixtures` covers both server adapters with authenticated SOCKS, Shadowsocks and VLESS REALITY listeners, three ordered egress connectors, ordered domain/IP policy; sing-box also uses an external rule file. Native config checks do not exercise remote handshakes, TUN OS privileges, rule-network semantics, or production deployment.

Tests require `ROUTEWEAVER_XRAY_BIN`, `ROUTEWEAVER_SINGBOX_BIN`, and `ROUTEWEAVER_MIHOMO_BIN`. Ordinary tests explicitly skip native checks when binaries are not requested; the full verification harness requires them. Fixtures under `testdata/` contain only synthetic public-documentation IPs and test credentials. `ROUTEWEAVER_UPDATE_FIXTURES=1` writes regenerated examples only after native validation succeeds. Frozen full-profile inputs reproduce the checked output without timestamps or mutable lookups.

## Naming

Unique labels remain readable and unchanged. Actual collisions and native reserved names get a deterministic short suffix, never a full internal ID. Persist `ClientResult.NameAllocations` per output and pass it in `ClientProfileIR.NameAllocations` for stable choices when collision sets change. Explicit display renames reallocate and update all generated references. Input order does not choose a collision winner. sing-box preserves punctuation. Mihomo's comma-delimited action grammar requires representing ASCII commas as fullwidth commas in output names; its groups and rule actions use the same allocated names. Source/profile display names are not changed.

## Rule resources and deliberate limits

Resource bytes are not flattened. Local paths and remote follow-update references remain first-class dependencies in `ClientResult.Resources`. The caller must supply accepted local files or an authorized compatible retrieval URL; a config alone is not a private-resource delivery bundle. This initial compiler requires pinned resources to be packaged local files because a remote URL and a manifest digest do not make clients enforce a cryptographic pin. The manifest digest itself is not a runtime integrity claim.

Resource record ownership is independent of delivery visibility. `OwnerID` continues to enforce tenant authorization; only explicit `Visibility: "public"` permits a remote URL reference in a client export. Omitted visibility means private. Private remote resources cannot be exposed by clearing their owner. The control-plane resource importer now accepts exact owned bytes and supplies generated local paths; the output publisher delivers a protected, frozen configuration-plus-files ZIP. Public local files and private local packaged files use the same compiler reference semantics. Native per-resource private URL delivery is not implemented; see the [owned rule-file delivery contract](../../docs/design/owned-rule-file-delivery.md).

sing-box source/SRS versions 1–5 are accepted for 1.14.3. Remote resources use its explicit 1.14 `http_client`, not the deprecated implicit downloader, and enable the native cache. Mihomo accepts classical/domain/IPCIDR YAML/text, and domain/IPCIDR MRS. Classical MRS is rejected. Xray server compilation supports domain/domain-suffix/IP rules, not generic boolean or DAT-resource translation yet. No unsupported resource is omitted or silently expanded. sing-box does not emulate fallback/load balance as manual groups. Explicit IPv4/IPv6 TUN interface addresses currently have a proven rendering only for sing-box. Target-scoped native extensions are implemented at the shared client render seam; see [native extension contract](../../docs/design/native-client-overrides.md). Arbitrary native programs and unbounded native configurations are not supported. Core parsing does not prove cross-core REALITY handshakes or universal semantic equivalence.

## Official syntax references

Checked 2026-10-19; these establish syntax, not runtime completion:

- [sing-box VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/), [TLS](https://sing-box.sagernet.org/configuration/shared/tls/), [V2Ray transport](https://sing-box.sagernet.org/configuration/shared/v2ray-transport/)
- [sing-box rule sets](https://sing-box.sagernet.org/configuration/rule-set/), [HTTP client](https://sing-box.sagernet.org/configuration/shared/http-client/), [route defaults](https://sing-box.sagernet.org/configuration/route/)
- [Mihomo VLESS](https://wiki.metacubex.one/en/config/proxies/vless/), [TLS](https://wiki.metacubex.one/en/config/proxies/tls/), [transports](https://wiki.metacubex.one/en/config/proxies/transport/)
- [Mihomo rules](https://wiki.metacubex.one/en/config/rules/), [rule providers](https://wiki.metacubex.one/en/config/rule-providers/), [fallback](https://wiki.metacubex.one/en/config/proxy-groups/fallback/), [load balance](https://wiki.metacubex.one/en/config/proxy-groups/load-balance/)
- [Xray VLESS](https://xtls.github.io/en/config/outbounds/vless.html), [transport](https://xtls.github.io/en/config/transport.html)
