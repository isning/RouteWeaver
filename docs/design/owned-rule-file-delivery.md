# Owned, immutable rule-file delivery

Scope: C402 with C501/C601/C602 integration, tracked by RW-09. This is accepted-file delivery, not generic rule conversion or native execution in the control plane.

## Maintained model

- `RuleResource` remains a file descriptor. `acceptedVersion` and `sizeBytes` identify an actual accepted immutable version; neither a client-supplied boolean nor `visibility: public` authorizes access to file bytes.
- An owner-scoped resource head retains private source provenance, accepted time, inspection level and explicit refresh status. Remote source URLs stay encrypted with that head and are excluded from ordinary responses. `canRefresh` reveals only whether an explicit refresh is available.
- Owner-scoped `resource-versions` records retain the exact accepted bytes and their descriptor. The immutable version binds owner, resource ID, SHA-256, native format/version and interpretation. Private deduplication is not shared across tenants.
- An accepted descriptor uses a generated `rules/<SHA-256>.<known-extension>` delivery path. The upload accepts bytes, not a filesystem path. Neither import, render nor export reads the server filesystem from `RuleResource.Path`.
- Publication resolves authorized records, verifies accepted bytes against the digest, and copies exact file versions into the frozen output. Its input comparison and preview digest cover resource versions, file bytes, generated paths and final configuration. Create and republish both fence captured inputs.

## API and user workflow

1. `POST /api/me/resources/import` accepts `{resource: {id, name, format, formatVersion?, behavior?, updatePolicy, digest?}, contentBase64}` for an uploaded file. Alternatively, set `resource.url` and `fetch: true`, omitting `contentBase64`, to fetch and accept a source explicitly. Exactly one source is required. `path`, `acceptedVersion` and `sizeBytes` are server-assigned, not accepted from this request.
2. An optional supplied SHA-256 digest is mandatory integrity evidence for that import: mismatched bytes are rejected. Remote imports use the existing bounded, DNS-pinned SSRF-safe fetcher, including redirect checks. No GET export or preview performs a hidden fetch.
3. Profiles reference owned resources. A stored pinned accepted version stays pinned when the head is replaced; following references resolve the current accepted head. Selecting a different pin is an explicit profile edit, not a background rewrite.
4. `POST /api/me/resources/{id}/refresh` fetches only the private origin already saved by an explicit remote import. Pinned refresh must match accepted bytes. Follow may accept a new immutable version. A failed fetch, envelope check or digest check preserves the previous head/file and marks `refreshStatus: failed`; new publication is blocked until successful refresh or explicit replacement. Previously frozen output bytes remain available under current output/account permissions. No stale-duration or compromise-recovery policy is invented.
5. Published output metadata reports `delivery: bundle` when it has accepted files, and `downloadPath: /api/me/outputs/{id}/bundle`. The ZIP contains one native config, separate exact rule files and `manifest.json` with versions, SHA-256, sizes and inspection levels. Users must retain the directory layout when using the configuration. No input archive is extracted by the server.
6. Explicit owner-authenticated download uses that `downloadPath`. A bearer bundle link uses `/feed/{token}/bundle`, bound to the same output token, current account and applicable platform-entry checks. Rotation invalidates the prior token; revocation denies both retrieval forms. Already downloaded bytes cannot be recalled.
7. Bare `/feed/{token}` returns a specific conflict for bundle-only outputs instead of an unusable config with missing local files. Private per-resource remote URLs/native automatic updates are not implemented. The UI must not present a ZIP link as a normal client-config import or QR code.

`/outputs/{id}/access` returns `feedPath`, `feedURL`, `bundlePath`, `bundleURL`, `downloadPath`, and `delivery`. Absolute URLs use only the configured effective subscription origin; no request Host/forwarded host is trusted. Imported local resources do not require a configured public origin.

## Validation and limits

- Accepted raw file limit: 8 MiB. Import request limit: 12 MiB, accommodating base64 with bounded metadata.
- Frozen output: at most 64 referenced resources, 16 MiB total accepted file bytes, 4 MiB configuration when creating a ZIP, and 24 MiB serialized output at publication. Base64 overhead remains below the default 32 MiB backup record limit.
- sing-box source uses the mature Go JSON parser; envelope version 1–5, bounded object/rule counts and maximum nesting 64 are checked.
- Mihomo YAML uses `yaml.v3`, one document, a payload envelope, bounded nodes/entries and nesting, and no aliases/anchors. Text files are bounded UTF-8 without NUL; obvious HTML is rejected.
- SRS/MRS uploads are opaque to the control plane. SRS magic/header version or MRS frame magic, size and SHA-256 are checked without decompression or native program execution. These checks do not prove complete file validity or native semantics. Metadata and bundle manifests explicitly report `nativeChecked: false`.
- Test fixtures separately use pinned real binaries to compile SRS/MRS and check downloaded bundles. sing-box check demonstrably consumes source/SRS files (malformed-file negative fixture). Mihomo -t checks configuration references but does not consume provider payloads; its separate native converter parses downloaded YAML/MRS, recovers the expected domain and rejects malformed files. No Mihomo runtime provider-load or traffic claim is made. Those finite fixtures do not upgrade arbitrary user uploads to native-validated status.
- Public remote-follow metadata remains supported for compatibility, but its upstream future bytes are not frozen or cryptographically enforced by clients. An inspected URL/digest is not an accepted immutable file until explicit import succeeds. No format is silently flattened or converted.

## Privacy, permissions and recovery

All mutating owner endpoints retain server authentication, CSRF and owner checks. File bodies never appear in resource listings, profile previews, output summaries or access-link metadata. Explicit bundle export intentionally includes the owner's required configuration credentials and selected file bytes. Generated paths, per-file digests and owner identity are rechecked before archive delivery. Failed/oversized/tampered content returns an error before ZIP headers or bytes are sent.

Accepted versions are retained while outputs/profiles may refer to them. No automatic garbage collection, source expiration policy or separate resource-revocation workflow is claimed. Output revocation, account disablement and current platform-entry eligibility govern subsequent bundle retrieval. A future retention/revocation policy must preserve these ownership and frozen-generation invariants.
