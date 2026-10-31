# Native validation dependencies

This directory accompanies RouteWeaver's private source and binary handoff. It does not establish public-distribution authorization or a license-compatibility conclusion.

- SagerNet/sing-box v1.14.3: the embedded JSON options schema was generated unchanged with the official binary's `schema` command. Source: <https://github.com/SagerNet/sing-box/tree/v1.14.3>. `LICENSE.sing-box` is the unmodified upstream notice, including its naming/association condition. `COPYING.GPL-3` supplies the referenced GNU GPL version 3 text. See `README.md` for exact artifact hashes and provenance. Generated output is not assumed to be license-free.
- github.com/santhosh-tekuri/jsonschema/v6 v6.0.2: JSON Schema validation. Source: <https://github.com/santhosh-tekuri/jsonschema/tree/v6.0.2>. `LICENSE.jsonschema` is copied unchanged from the pinned Go module.
- github.com/evanphx/json-patch/v5 v5.9.11: RFC 7396 merge-patch implementation. Source: <https://github.com/evanphx/json-patch/tree/v5.9.11>. `LICENSE.json-patch` is copied unchanged from the pinned Go module.

The existing yaml.v3 dependency parses YAML data. The Mihomo subset schema and reference-policy code are RouteWeaver's code, not copied native runtime code. The control plane does not embed or execute the sing-box/Mihomo runtime through this feature. Native executables are used only by opt-in tests against fixed synthetic fixtures.

Dependency notices are not an exhaustive combined-work/legal review. Any future external redistribution needs a review of the full package, included source, all direct/transitive dependency notices, and the upstream conditions. No license-compatibility or production-readiness claim is made here.
