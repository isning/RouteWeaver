# Rule-resource compatibility evidence

Official-document research supplied by the project's verification worker, checked 2026-10-18. This appendix separates documented format facts from RouteWeaver's proposed contract. It does not assert that any configuration was executed or any pair of formats is semantically interchangeable. Pin actual supported versions before implementation.

## Documented facts

- **sing-box:** rule sets support local and remote resources, with source JSON and binary SRS representations. Remote resource persistence/cache behavior must be explicitly configured, not presumed. [Rule sets](https://sing-box.sagernet.org/configuration/rule-set/).
- **sing-box source format versions:** version 1 corresponds to sing-box 1.8+, version 2 to 1.10+, version 3 to 1.11+, version 4 to 1.13+, and version 5 to 1.14+. Do not emit a newer rule resource for an older target merely because both call it SRS. [Source format](https://sing-box.sagernet.org/configuration/rule-set/source-format/).
- **sing-box remote fetch options:** current documentation introduces http_client in 1.14; download_detour is deprecated in 1.14 with removal planned for 1.16. These are version-specific adapter facts, not stable fields in the product model. [Rule sets](https://sing-box.sagernet.org/configuration/rule-set/).
- **Mihomo:** rule providers support distinct behavior/format combinations; MRS is for domain or ipcidr behavior, not classical behavior. A complex resource may require supported classical YAML/text, or be unsupported for the intended semantics. [Rule providers](https://wiki.metacubex.one/en/config/rule-providers/).
- **Mihomo classical contents:** documented classical provider contents exclude RULE-SET and SUB-RULE. Do not assume nesting of resource references survives conversion. [Provider contents](https://wiki.metacubex.one/en/config/rule-providers/content/).
- **Xray:** routing supports geosite/geoip data and external DAT references using ext:file:tag semantics. Resource location is an environment/runtime concern, including XRAY_LOCATION_ASSET; it is not a subscription URL format shared with clients. [Routing](https://xtls.github.io/en/config/routing.html), [environment and assets](https://xtls.github.io/en/config/env.html).

## RouteWeaver contract proposals, not upstream guarantees

- Shared IR expresses intended exact/suffix/wildcard/regex and boolean matcher semantics explicitly. Similar field names across targets do not demonstrate identical matching, DNS resolution or precedence.
- A target adapter declares a proven semantic subset and emits a compatible file resource. SRS → MRS or SRS → DAT is not promised as a universal lossless conversion.
- RuleSetRef's identity, pin, digest, ownership, update policy and resource manifest belong to RouteWeaver's proposed contract. Do not claim the native core validates custom manifest signatures or enforces our ownership policy. Validation/distribution must account for what the runtime actually supports.
- Unsupported semantics block publication with a specific diagnostic. An explicit user-approved inline fallback policy is distinct from file-format adaptation and must never be silently activated.
- Tests must cover order, default/failure actions, DNS behavior, resource freshness, authenticated retrieval and malformed/changed data for the exact pinned targets. Documentation establishes a research basis, not passing integration evidence.
