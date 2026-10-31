# Owned rule-file delivery evidence, 2026-10-19

Scope: C402 and related C501/C601/C602 delivery, local ticket RW-09. Status remains **in progress** pending aggregate prerequisites and independent review. This does not claim production deployment or complete arbitrary-rule semantic support.

## Implemented outcome

Owner-authenticated uploads and explicit safe remote imports create immutable accepted file versions, not inline subscription rules. Files are SHA-256/size/format-bound and delivered separately in a frozen ZIP with the native configuration and manifest. Pinning, source provenance, failed-refresh state, owner checks, preview input fencing, safe generated paths and token revocation are separate from user-editable visibility. See [design and API contract](../design/owned-rule-file-delivery.md).

## Red before green

`TestOwnedRuleFilesPublishAsExactFrozenBundle` first failed at the real HTTP seam: `/api/me/resources/import` returned 405. It passed after upload, immutable storage and bundle publication/download were implemented.

`TestFetchRuleFileRejectsChangedBytesBehindPin` first failed to compile because `Fetcher.FetchRuleFile` did not exist. After implementation, the test uses the actual safe HTTP transport over `net.Pipe`; a changed response cannot satisfy the original SHA pin and an HTML response cannot become a source rule set. No external requests were made.

## Passing focused behavior

- `internal/httpapi/resource_bundle_test.go`: exact separate bytes after upload/publish/download, metadata and preview privacy, owner isolation, CSRF, arbitrary absolute/relative path rejection, forged accepted-version rejection, mandatory digest pin, frozen output after replacement, stale preview rejection, same-token bundle rotation and revocation, and rejection of a tampered stored file before delivery.
- The explicit failed-remote-refresh fixture uses a private IP URL rejected by the real safe fetcher before dial. It preserves the accepted digest and previously frozen ZIP, exposes `refreshStatus: failed` without the secret origin, and blocks new publication. Preview and export do not fetch the origin.
- `internal/resources/rule_file_test.go`: accepted manifest integrity, exact size, path and byte tampering, oversized content, excessive JSON nesting, YAML aliases/multiple documents, HTML and invalid opaque headers.
- `internal/resources/fetch_test.go`: changed bytes behind a pin and invalid source response through actual `net.Pipe` transport, alongside existing SSRF/DNS/redirect/body limit regressions.
- Focused commands select `Test(OwnedRuleFiles|RuleFileImport|FrozenBundle|RuleRefreshFailure|RuleBundleRejects|AcceptedRuleFile|FetchRuleFile)` in HTTP/resources packages. See [focused race log](owned-rule-files-2026-10-19/focused-race.log).

## Actual native-file evidence

`TestNativeOwnedRuleFileBundles` uploads through the owner HTTP API, publishes, downloads the ZIP, verifies exact bytes, writes only the generated files to an isolated test directory and invokes the native parser:

- Mihomo 1.19.32 with YAML and native-compiled MRS.
- sing-box 1.14.3 with JSON source and native-compiled SRS.

All four cases passed. Sensitivity is explicit: sing-box `check` rejects malformed referenced source/SRS files. Mihomo `-t` does **not** reject malformed referenced YAML/MRS, so that command establishes configuration/reference parsing only. A separate fixture-only native Mihomo converter parses the exact downloaded YAML/MRS, recovers the independently expected domain and rejects malformed file bytes; it proves bounded file-format parsing, not runtime provider loading or traffic behavior. SRS/MRS compilation and native conversion run only in fixed local test fixtures; the control plane never invokes native executables on uploads. [Native output log](owned-rule-files-2026-10-19/native-bundles.log). The root native harness includes this test in both selection and its required-pass set.

## UI task evidence

- `web/src/rule-files.dom.test.tsx`: preserves the selected upload after failure without submitting caller-controlled delivery paths; offers authorized ZIP download instead of a broken config subscription/QR. Two tests passed. [DOM log](owned-rule-files-2026-10-19/ui-dom.log).
- `web/tests/rule-files.api.spec.ts`: real-backend upload, profile preview, publish, exact ZIP, frozen replacement and revoke. One API task passed. [API log](owned-rule-files-2026-10-19/ui-api.log).
- The UI uses an explicit resource-reference projection so metadata/inspection fields do not enter the strict IR. Existing pinned references survive unrelated selection changes; choosing the latest accepted version is explicit.

## Limits and unrun scope

- Production upload inspection is bounded envelope/header/integrity validation, not full native validation. SRS/MRS remain opaque; `nativeChecked: false` is intentional.
- Only local-bundle delivery is claimed for private files. No per-resource private automatic client-fetch URL is implemented. Bare feed retrieval is blocked for bundle-only outputs, not silently degraded.
- Already downloaded client files cannot be recalled. Output/account/platform authorization is checked at later retrieval; no automatic resource retention/expiration/GC policy is invented.
- The first broad non-race HTTP run encountered the concurrent source-candidate fixture change `TestSecondaryPresetDigestRejectsChangedSource`; that worker owned its reconciliation. A separate broad HTTP/domain/render/resources race attempt was deliberately interrupted (exit 130) to avoid competing backup-KDF workload with the parent's serial aggregate gate. That attempt is not a pass; the focused race log and parent's final aggregate run are the applicable evidence.
- Actual browser rendering/visual review was not run in this slice, per the parent scope. DOM and real-backend API tests are not a browser visual pass. No VPS, live external service, GitHub publication, traffic-through-native proof, universal rule equivalence or complete release verification is claimed.
