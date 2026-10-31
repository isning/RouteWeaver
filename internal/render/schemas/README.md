# Embedded native validation schemas

## sing-box 1.14.3

`sing-box-1.14.3.json` is unmodified JSON Schema Draft 2020-12 emitted by the pinned official sing-box 1.14.3 binary with `sing-box schema -o schema.json`, following <https://sing-box.sagernet.org/configuration/schema/>. It is not downloaded on user requests.

- Source release: <https://github.com/SagerNet/sing-box/releases/tag/v1.14.3>.
- Schema SHA-256: `15133dc518142b7082f120fa7ed08dabb5b28768850e4bebcde67272cbd58d47`.
- Generating binary SHA-256: `768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93`.
- Binary provenance is recorded by the shared native-core toolchain. Its release URL was official; an independently published upstream checksum was not verified. A recorded hash is not a signature verification claim.
- Upstream project/source: <https://github.com/SagerNet/sing-box/tree/v1.14.3>; upstream licensing: <https://github.com/SagerNet/sing-box/blob/v1.14.3/LICENSE> (GPL-3.0-or-later). This generated options schema is attributed to SagerNet/sing-box. No upstream implementation is copied into the renderer.

The production compiler registers this embedded document and refuses all external schema loads. Validation uses github.com/santhosh-tekuri/jsonschema/v6. Cross-object ownership, graph, default/fallback and extension-scope checks remain application-specific and run in addition to the schema.

## Mihomo 1.19.32

`mihomo-1.19.32-override.json` is RouteWeaver's explicitly bounded schema for the supported extension surface, not an upstream/full Mihomo schema. It uses the same mature JSON Schema validator. Syntax was checked against official Mihomo configuration documentation; fixed positive resulting configurations are checked against the pinned real Mihomo binary. Unknown fields are rejected. Do not describe acceptance of this schema as universal native configuration acceptance.

Any schema change requires a deliberate target/version decision, public-render positive and negative tests, and representative native-parser fixtures. Neither schema proves client process liveness, remote TLS handshakes, host privileges, DNS behavior or traffic routing.
