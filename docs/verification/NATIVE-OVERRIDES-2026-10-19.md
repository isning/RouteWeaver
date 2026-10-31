# C503 native client extension evidence

Date: 2026-10-19 UTC. Feature ticket RW-10 remains in progress; this report is local engineering evidence, not a GitHub issue, full-browser acceptance, runtime routing proof or release approval.

## Public seams and observed red → green

The agreed ticket seams are client renderer, owner-scoped profile save/reveal/preview/publication, and the UI advanced-editor task. Tests were added at those seams, not against private merge helpers.

Observed failing-before-passing tests included:

- `TestNativeOverrideAddsProcessPolicyAndFakeIPWithoutChangingGeneratedConnections`: native data was initially discarded; fake-IP/process rules/native selector now compose after portable generation while preserving generated credentials.
- `TestNativeOverrideRejectsForeignDNSDetour`: foreign native DNS detour originally passed; owner-local reference checks now reject it.
- `TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`: raw invalid draft leaked in save response; normal list/get/save now omit it, owner reveal retains exact bytes, foreign access is denied.
- `TestNativePreviewRedactsURLAuthenticationButExportRetainsExactData`: query token initially appeared in normal final preview; preview-only URL redaction now hides it without corrupting publication.
- `TestNativeDiagnosticNeverEchoesUntrustedPropertyNames`: arbitrary input key appeared in error path; only trusted schema field labels and actual array indices are now reflected. `TestNativeNumericObjectKeysAreNotReflectedAsArrayIndices` separately reproduced and closed numeric unknown-key leakage.
- `TestNativeChangeReportDistinguishesAdditionsFromReplacements` and `TestNativeSingBoxRejectsCredentialMaterialOutsideConnections`: additive arrays were mislabeled as replacement, and DNS client-key fields escaped connection guards; both fixed.
- `TestNativeDNSResolverCyclesAndDanglingMihomoSelectorsAreRejected`: cyclic resolver dependencies and unowned/ambiguous native DNS selectors were accepted; semantic checks now reject them.
- `TestNativeOutputScopedPreviewRetainsNamesWhenCollisionsChange`: output-scoped preview initially rejected `outputId`; it now uses the same owner-checked retained allocations as republish. Collision addition/removal fixtures compare full no-secret preview content with republished bytes; cross-tenant, wrong-profile and target mismatch requests are denied.
- `TestOutputReviewRejectsChangedProfileAndPreservesFeed`: output previews initially had no digest. Existing-output review now binds exact captured inputs and unredacted render, rejects stale publication with HTTP 409, and preserves the prior feed; fresh review succeeds.
- `TestNativeCapabilitiesAreDeclaredBySupportedAdaptersOnly`: capability metadata was missing; both built-in adapters now declare the versioned extension surface and undeclared adapters reject it.
- `TestNativeSingBoxRejectsUnmanagedServiceAndNamespaceReferences`: native references to non-existent service/namespace/inbound records were accepted; those references now fail closed.

Additional green regressions cover deterministic prepend/append/replace and fallback preservation; reserved/generated identity conflicts; native group cycles; unsupported fields/types; duplicate YAML/JSON keys; null deletion; cross-target/version/output-mode errors; unknown credentials and rule resources; retained client-local paths without reading them; source/template regeneration; immutable publication retained after invalid draft; explicit template-follow preserving exact native text. `output_review_test.go` additionally covers source/profile/output/resource/grant changes, stable repeated reviews, malformed digest rejection and exact no-secret reviewed publication. A secret-only native URL change leaves redacted preview text identical but changes the digest and rejects the stale review. `token_inputs_test.go` changes a captured source before commit and verifies both old output and old token index survive the failed transaction; fresh captured inputs commit both together.

## Executed commands

- After the optional output review fence: `scripts/go.sh test ./internal/httpapi ./internal/store ./internal/render -count=1`: passed.
- `scripts/go.sh test -race ./internal/httpapi ./internal/store -run 'TestOutputReview|TestTokenPublicationFences|TestNativeOutputScoped|TestCASCannotResurrect' -count=1`: passed for publication/input fences. The additional secret-only digest regression passed separately after this run.

- `scripts/go.sh test ./internal/render ./internal/httpapi ./internal/reuse ./internal/domain -count=1`: passed on the integrated workspace after native changes.
- `scripts/go.sh test -race ./internal/render ./internal/httpapi -run 'TestNative(Override|Draft|Preview|SingBox|Diagnostic|Numeric|Change|References|DNS|Capabilities|OutputScoped)' -count=1`: passed for the selected native tests. This is scoped race-detector evidence, not proof of all concurrency behavior.
- `scripts/go.sh run ./scripts/check-architecture`: passed production-import checks. No native process/HTTP/file-import escape is added to the production renderer. Import checks are not a complete effect/security proof.
- With `ROUTEWEAVER_MIHOMO_BIN` and `ROUTEWEAVER_SINGBOX_BIN` pointing at the pinned toolchain binaries, `scripts/go.sh test ./internal/httpapi -run TestNativeOverridePublishedArtifactsPassPinnedNativeParsers -count=1 -v`: passed both subtests.

The native end-to-end fixture saves the owner profile, reopens the exact native text, composes the final client artifact, validates those exact bytes with the real client parser, publishes, and asserts the authorized feed is byte-for-byte equal to the parser input.

- Mihomo 1.19.32: fake-IP DNS, owned native DNS selector with explicit independent bootstrap, native select group, PROCESS-NAME and DST-PORT rules.
- sing-box 1.14.3: DNS cache/strategy, native selector with connection-interruption option, process-name and port routing.

Only fixed synthetic inputs are given to native processes. These tests do not create a user-runtime native validation endpoint.

## Important validation distinction

The sing-box official JSON Schema is broader than RouteWeaver's bounded Mihomo extension schema. Results report `upstream-json-schema-and-references` or `bounded-schema-and-references`, never `nativeChecked: true` for an HTTP preview.

An isolated experiment submitted a fixed two-resolver `domain_resolver` cycle to pinned sing-box `check`. It returned exit 0. Therefore native parser acceptance alone does not prove resolver dependency acyclicity. RouteWeaver's additional semantic cycle check rejects that case at the public render seam. No core was started and no DNS/traffic behavior was asserted.

Client paths and network references are emitted as data; the control plane neither reads those paths nor fetches those URLs. Parser acceptance does not prove TUN privileges, process discovery, file availability on the device, DNS bootstrap reachability, live traffic, or deployment.

## Publication fence scope

Output-scoped preview and publication share one cached tenant-input/render preparation. Digest comparison uses the unredacted result. Store `CompareInputsAndPutWithToken` uses existing `compareRecordsTx` under the same transaction as output and token-index writes. Global runtime/accounting authority is deliberately not frozen by this transaction; current eligibility/effective grants are rechecked by the feed and may deny an older output. API calls without the optional digest retain latest-draft semantics; the existing-output review UI requires and sends the digest.

## Remaining gates

The UI lane owns real-browser advanced-editor tasks, full API/browser regression, and responsive/manual review. Independent final review and the broader release gates remain pending in the ticket until their own evidence is attached. This report does not convert whole C502/C503 acceptance into verified status. The separate structured C502 capability coverage and prerequisites must also be satisfied.

The schema provenance and unchanged upstream/dependency notices are in `internal/render/schemas/`. A future external redistribution requires its own combined-work/license review; no public publication occurred.
