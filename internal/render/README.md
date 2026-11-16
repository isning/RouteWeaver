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

## Bounded background comparison

`ClientRegistry.RenderBounded` is an opt-in contract for the built-in Mihomo and
sing-box adapters. It does not change ordinary `Render`, explicit reviews, or
publication capacity. A `RenderBudgetError` declines background work; it is not
proof of invalid configuration or an unchanged subscription.

The contract checks the materialized IR before recursive validation, then the
actual generated tree before serialization and the composed/merged trees before
native schema validation. Each tree is limited to 4,096 visited nodes, depth 16,
4 KiB per string, and 16 KiB aggregate string bytes. Input inventories are capped
at 32 endpoints, 8 groups, 32 rules, 8 resources, and 64 retained name allocations.
Native input is JSON only, at most 4 KiB, depth 8, and 256 tokens; ordinary explicit
rendering retains YAML support. Generated and final artifact checks cap content
at 128 KiB. These are bounded-data/complexity limits with fixed embedded schemas,
not a preemptive CPU deadline. No network or external schema loading is added.

Dashboard comparisons use this path for small native drafts after the existing
owner-scoped shared input budget and collection preflight. Small platform drafts
also use it, only when their complete dependency inventory fits a read-only
snapshot: at most 64 records, 64 KiB per record, and the existing 2 MiB request
input budget shared by both captures. Saved source snapshots and collections
use the same immutable input capture and
bounded conversion preflight (16 sources, 32 total steps, and bounded endpoint
and template bytes); final rendering still permits at most 32 endpoints. Local
accepted rule files are limited to four files of at most 4 KiB each, checked
before materialization's parser calls. Mihomo text and opaque srs/mrs envelopes
are admitted; binary checks are not
native-format execution validation. Sing-box JSON additionally requires a single
object, depth at most 8, at most 256 tokens, no duplicate keys and exact EOF before
normal format verification. Mihomo YAML admits only a fixed `payload:` block with
at most 64 two-space-indented list items, each a single-line JSON-quoted string
whose decoded value is at most 256 bytes. This whitelist bounds syntax before the YAML parser; other
YAML syntax, including aliases, anchors, tags, flow/nested collections, additional
keys and multi-document streams remains unchecked. These gates preserve original
bytes and do not narrow explicit review. Unaccepted remote rules, oversized graphs
remain unchecked. Neither comparison capture
fetches a source.
It evaluates canonical policy, usage and both hold types without rebuilding
projections. After rendering it captures again, requires identical complete
record membership/content, rechecks every grant and applied path, and rejects
expired eligibility/proof deadlines. Larger graphs remain deferred. These are
as-of comparisons, not authorization to deliver or publish; existing manual
review, publication and delivery checks are unchanged. Oversized, invalid,
unsupported-target, or unreadable candidates remain unchecked with their
publication revision; a later read retries corrected saved data. A comparison
never publishes the candidate or rewrites the stored publication.

Small independently metered outputs can also be compared when their profile is
made only of at most eight isolated managed platform routes. Their dedicated
capture adds complete admission bindings, immutable attribution claims, owner
intents, runtime instances and provider observations to the same budgets; these
extra collections do not affect ordinary comparisons. The original profile-to-
isolated-grant map must match the published creation intent. Both captures check
the isolated grant (not its original shared sibling), exact live binding and
claim, published attribution revision, applied path and current runtime identity.
Provider policy reuses the pure live `ManagedAdmission` evaluator on every
applied hop in both snapshots; missing evidence, exhausted allowance, invalid
configuration or expired evidence remains unchecked. Its returned freshness,
cycle and service deadlines join the final expiry fence. Advisory semantics stay
unchanged, and corrupt negative counters are conservatively rejected only by
this background consumer. No admission lease, IP/connection slot, quota budget
or provisioning state is created or settled. A successful comparison means only
that saved configuration differences were checked, not that a connection will be
admitted. All normal live admission/publication/revocation fences remain active.
