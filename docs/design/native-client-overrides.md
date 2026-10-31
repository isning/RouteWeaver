# Native client extensions (C503)

Implemented engineering contract, 2026-10-19. This is target-specific client data, not a general plugin/program executor or a promise of arbitrary configuration compatibility.

## Seam and durable input

`ClientRegistry.Render` is the only final configuration composition seam. Profile preview, saved drafts, template candidates, and publication all call it. The portable profile and optional `ir.nativeOverride` remain separate intent. The extension contains:

- `schemaVersion: "1"`, `namespace: "routeweaver/native-client"`.
- `target: {adapterId, version}` with an exact supported client version.
- `format: "json" | "yaml"` and the original `content` string.
- `ruleMode: "prepend" | "append" | "replace"`.

Both built-in adapters declare their extension capability in `/api/me/capabilities`. An adapter that does not declare it rejects native input. Current schemas are deliberately pinned to Mihomo 1.19.32 and sing-box 1.14.3. A change of version, client, or output mode never silently discards an extension: it blocks rendering until the owner explicitly changes/removes the extension. Multiple clients can have independent named profiles and native edits. There is no claim that native edits migrate across clients.

The original text, including invalid drafts, whitespace and comments, survives save, reveal and regeneration. A draft can save with diagnostics; preview and publication reject invalid content. Common settings remain structured. Applying an extension never rewrites the underlying portable settings. Removing it restores the generated settings. Template copy/follow merges retain this owner-local extension; native data is not part of reusable template policy or baseline.

## Precedence and conflicts

1. Resolve owner-authorized inputs and portable intent, then generate the base artifact.
2. Parse native text as bounded data using yaml.v3 (JSON input is also checked as JSON). Reject duplicate keys, aliases, anchors, custom tags, extra YAML documents, non-JSON values, excessive depth and oversized input.
3. Validate the target's supported native surface and reference/identity invariants.
4. Compose arrays with the explicit rules below and apply standard RFC 7396 object merge using evanphx/json-patch. Scalars and ordinary arrays are native-wins. Null deletion is intentionally disallowed; remove the override field to return to the structured value.
5. Validate the final artifact, return its exact JSON plus a nonportable change report, and publish only those final bytes.

Special arrays:

- Mihomo `proxy-groups` and sing-box `outbounds` add uniquely named policy groups. They do not replace generated entries. sing-box additions are selector/urltest groups, never arbitrary outbound connections. Native groups may reference generated endpoints/groups and other native groups in this same profile. Dangling references, reserved/generated-name collisions and cycles are rejected.
- sing-box `dns.servers` adds uniquely tagged native resolvers. It does not remove generated resolver identities. DNS final/action/bootstrap references are checked, including explicit resolver dependency cycles.
- Mihomo `rules` or sing-box `route.rules` use `ruleMode`. Prepend places native rules before portable policy; append places them after portable policy; replace substitutes only portable policy rules. Generated sniff preprocessing and explicit default/fallback remain. Array order is preserved.

Saved-profile preview accepts optional `outputId` when reviewing an update to an existing subscription. It requires that exact output to be owned by the caller and linked to the saved profile, rejects requested target/mode mismatches, and uses its target, mode and retained name allocations exactly as republish does. Responses distinguish `previewScope: "profile-draft"` from `"output-update"` and identify the selected output. This avoids name-reference drift after a collision is added or removed. Output-scoped previews also return `previewDigest`, which binds the owner, exact captured output/profile/source/collection/resource/grant inputs, target/mode/retained names, and full unredacted final render. The existing-output review UI sends this digest to `POST /outputs/{id}/publish`. Publication prepares through the same cached-reader/render path, rejects a changed review with HTTP 409, then atomically compares all captured tenant inputs and writes the output plus bearer-token index. A change between preparation and commit also fails without replacing the published feed. Presentation redaction happens only after hashing the exact final bytes.

API clients omitting the optional digest retain explicit update-latest behavior; a supplied empty or mismatched digest does not fall back. New-output creation still publishes the current draft immediately, rather than claiming a frozen earlier review. Review digests do not freeze global accounting/runtime eligibility: those checks run during preparation and the feed independently rechecks current authority/effective grants. Global state may therefore make a reviewed output unavailable, but cannot substitute different bytes under an accepted digest. Only captured tenant input records participate in the publication CAS.

The preview report returns `target`, `ruleMode`, `changedPaths`, `replacedPaths`, `nonportable: true`, and `validation`. Additive groups/resolvers and prepend/append rule lists are not labeled as replacement. Paths never reflect arbitrary secret-bearing keys. A native rule referencing an old generated display name after a rename is a visible conflict, not silently retargeted; no interpolation DSL is introduced.

## Useful target-specific capabilities

Mihomo supports a bounded schema for fake-IP DNS, native nameserver policy, resolver transports/routing, DNS cache choices, sniff/TUN options, process discovery, connection concurrency, and native group options. Native routing supports domain keyword/wildcard/regex, process name/path/wildcard/regex, source/destination/inbound ports, source CIDRs, network, UID, DSCP, and owned rule-set predicates in addition to portable leaf rules. Nested native boolean strings, implicit GEOSITE/GEOIP downloads, arbitrary providers/listeners, and undeclared fields are rejected rather than ignored. Portable logical rules and explicit resource records remain available.

Mihomo DNS fragments are not assumed to be harmless strings: a selector must name a policy in this profile, proxied/RULES DNS requires a separate non-proxied `proxy-server-nameserver`, and unknown selector-to-interface fallback is rejected. Domain rule-set references must exist in the authorized resource manifest. Implicit geodata fallback is rejected; explicit owned resources are the supported alternative.

sing-box final configurations are checked against the upstream JSON Schema exported by the exact pinned binary. Native extensions can express richer DNS transports/rules/cache, native route predicates/actions, logging and cache settings, and additional selector/urltest groups. Its native field surface is larger than Mihomo's bounded schema; the two validation scopes are reported accurately. An upstream schema is structural evidence, not proof of networking, OS capability, reachability or every dynamic dependency. Route default and rule-set manifests remain structured; native references cannot introduce another tenant's records.

## Ownership and security decisions

- Generated proxy/outbound connections, managed identities and credentials cannot be replaced or supplied through native additions. Authentication fields/headers, client private keys and controller APIs are rejected. Source/connection changes use the existing owner-checked structured seams.
- Raw rule providers, rule-set declarations and private file delivery manifests remain structured. A native rule can reference only already-authorized resources. A raw native path cannot read a control-plane file or turn it into a delivered resource.
- Client-local paths, such as a sing-box hosts file or cache/log path, are inert output strings. The client is responsible for making them available. The control plane does not open them, fetch native URLs, start a core, execute code, or interpret JavaScript. Native parser subprocesses exist only in fixed synthetic test fixtures, not the HTTP/render production path.
- The JSON Schema compiler uses embedded schemas and a loader that rejects every external URI. User `$schema`/`$ref` fields are not used to select or retrieve schemas.
- Native text is owner-private and omitted from ordinary profile list/get/save responses. The authenticated owner's explicit `/reveal` returns exact content for editing. Invalid drafts are equally protected. Template exports do not include native text.
- Normal previews redact generated credentials and URL user information/query/fragment data. Private DNS query tokens, if supplied as client data, remain only in explicit owner reveal and authorized published output. Error messages do not echo raw text, arbitrary property names or values. A redacted preview is not advertised as importable canonical bytes.
- An invalid draft does not mutate a published subscription. All existing feed authorization/revocation checks continue to apply to the immutable published artifact.

## References and evidence

- [Mihomo native rules](https://wiki.metacubex.one/en/config/rules/), [DNS configuration and fragment routing](https://wiki.metacubex.one/en/config/dns/), [DNS transports](https://wiki.metacubex.one/en/config/dns/type/).
- [sing-box JSON Schema generation](https://sing-box.sagernet.org/configuration/schema/), [native route rules](https://sing-box.sagernet.org/configuration/route/rule/), [DNS](https://sing-box.sagernet.org/configuration/dns/).
- `internal/render/schemas/README.md` records exact schema provenance and limitations.
- `docs/verification/NATIVE-OVERRIDES-2026-10-19.md` separates public-seam tests, pinned parser fixtures, browser evidence and unproven runtime behavior.
