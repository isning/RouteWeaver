# Ticket-clause ledger and CI9 disposition — 2026-11-02

**95 supported clauses; RW-07.3 unresolved; RW-24.1 and RW-24.4 dependency-conditional.**
All 98 original clauses, 24 tickets, 35 stories and 82 evidence groups are retained.
[Final review and execution boundaries](CI9-FORWARD-ACCEPTANCE-2026-11-02.md) and
[machine-readable selectors, hashes and receipts](CI9-FORWARD-ACCEPTANCE-2026-11-02.json)
bind this adjudication to local `7a101032f55c1bde5ff308ffa1ddfcdd97b8d79e`,
remote `30906420acc235d4285be27857fd416383914483`, tree
`9a848d8631aa3c0bd2f355311040483a93db9428`, CI9 run41406226333.

13 tickets verified; RW-07 in progress; 10 held by the original forward dependency graph.
CI9 all18 green does not resolve RW-07.3 or validate a later fix. NET-03 unknown-cause
residual risk and actual deployment inputs/authority remain open. No application code,
test execution, GitHub publication, main merge or deployment is performed by this ledger.

## Original literal clauses and current adjudication

### RW-01 — Create and validate direct or multi-hop routes

Stories: F01, F02, K02. Direct prerequisites: none. Forward status: `verified`.

1. **A one-endpoint direct route and a path with more than two distinct endpoints round-trip through storage and UI without a hard-coded engine or hop enum.**
   - Disposition: `supported`.
   - Evidence groups: `topology`, `ordered-route-browser`, `route-exit-browser`.
   - Bounded scope: Composed bounded software evidence: endpoint-based direct/three-hop path model, generic ID-keyed storage/API, arbitrary ordered path/graph serialization, API direct-route round trip, actual browser ordered/graph editing and persisted two-hop graph historical confirmation. Does not claim a new single browser journey separately saving every hop count or live deployment.
   - Exact selectors/retained receipt paths:
     - `internal/domain/profile_test.go :: TestTopologyAllowsThreeHopsSameHostAndDirect`
     - `internal/domain/profile_test.go :: TestProfileAcceptsDeepNestingAndRejectsCycle`
     - `internal/domain/profile_test.go :: TestRenamingDoesNotChangeStableReferences`
     - `web/tests/workspace.ui.spec.ts :: administrator edits an ordered route without dragging`
     - `web/tests/route-exit-backend.ui.spec.ts :: existing managed route selects stored plain TCP endpoint absent from its programs and saves a real draft`
     - `internal/httpapi/legacy_endpoint_options_test.go :: TestLegacyEndpointEditorPreservesTypedOptionsAndRouteIdentity`
     - `internal/render/registry_test.go :: TestLegacyAdapterDoesNotImposeTwoHopLimit`
     - `web/src/route-graph.dom.test.tsx :: retains measured geometry and dragging across path updates and view switches, without storing geometry in routing intent`
     - `web/src/infrastructure-model.test.ts :: allows a one-endpoint direct server route`
     - `docs/verification/GRAPH-NODE-MEASUREMENT-2026-10-20.md :: Integrated browser confirmation`
2. **Endpoint identity, not display name or VPS identity, governs cycle detection; rename preserves references; invalid draft preserves form values.**
   - Disposition: `supported`.
   - Evidence groups: `topology`, `endpoint-impact-ui`.
   - Bounded scope: Endpoint IDs, not labels/host IDs, govern graph traversal and references; source/DOM/backend evidence covers rename and retained rejected draft.
   - Exact selectors/retained receipt paths:
     - `internal/domain/profile_test.go :: TestTopologyAllowsThreeHopsSameHostAndDirect`
     - `internal/domain/profile_test.go :: TestProfileAcceptsDeepNestingAndRejectsCycle`
     - `internal/domain/profile_test.go :: TestRenamingDoesNotChangeStableReferences`
     - `web/src/endpoint-impact.dom.test.tsx :: retains draft on failed impact read and twice canceled review, without writing or exposing secrets`
     - `web/src/endpoint-impact.dom.test.tsx :: requires a fresh review after dependency conflict and writes only the reviewed draft`
     - `internal/httpapi/legacy_endpoint_options_test.go :: TestLegacyEndpointEditorPreservesTypedOptionsAndRouteIdentity`
     - `internal/render/rename_references_test.go :: TestExplicitEndpointAndGroupRenamePreservesRenderedReferences`
3. **Protocol/TLS capability errors name the offending endpoint and exact target; shared connection edits preview dependent routes.**
   - Disposition: `supported`.
   - Evidence groups: `endpoint-tls`, `endpoint-impact`, `endpoint-impact-browser`.
   - Bounded scope: Exact-target capability rejection and identity-located endpoint diagnostics; impact review binds edited endpoint and names dependent routes/deployments without applying them.
   - Exact selectors/retained receipt paths:
     - `internal/render/reality_pair_test.go :: TestServerRealityClientParametersMatchServerMaterial`
     - `internal/httpapi/endpoint_impact_test.go :: TestEndpointImpactReviewBindsDraftAndDependencies`
     - `web/tests/endpoint-impact.ui.spec.ts :: shared endpoint impact review stays readable and cancel preserves exact draft at 320px`
     - `internal/render/endpoint_target_parity_test.go :: TestEndpointOutboundTargetParity`
4. **The architecture negative fixture, API authorization, persistence and graph/form tests pass using the same local and CI harness.**
   - Disposition: `supported`.
   - Evidence groups: `render-extension`, `tenant`, `topology`.
   - Bounded scope: Common scripts/verify.sh harness plus final exact-tree CI9/static and web evidence. Architecture negative fixture is explicit; API auth, persistence, form/graph selectors are not inferred from aggregate green alone.
   - Exact selectors/retained receipt paths:
     - `internal/render/client_test.go :: TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
     - `internal/render/client_test.go :: TestMihomoPreservesFourStrategiesAndResourceFile`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/domain/profile_test.go :: TestTopologyAllowsThreeHopsSameHostAndDirect`
     - `internal/domain/profile_test.go :: TestProfileAcceptsDeepNestingAndRejectsCycle`
     - `internal/domain/profile_test.go :: TestRenamingDoesNotChangeStableReferences`
     - `scripts/check-architecture/main_test.go :: TestGuardRejectsForbiddenImportAtPublicCommandSeam`
     - `scripts/verify.sh :: static/backend/web harness`

### RW-02 — Invite and manage local accounts securely

Stories: A01, M03. Direct prerequisites: none. Forward status: `verified`.

1. **Invitation claim, sign-in, sign-out and expired/revoked sessions have positive and negative tests; passwords are salted and secrets never returned in normal listings.**
   - Disposition: `supported`.
   - Evidence groups: `invite-browser`, `account`, `account-browser`.
   - Bounded scope: Real isolated invitation/sign-in/sign-out/session lifecycle, bounded expired/revoked sessions and redacted listings; HashPassword calls salted bcrypt.GenerateFromPassword. No external identity-provider claim.
   - Exact selectors/retained receipt paths:
     - `web/tests/session-recovery.ui.spec.ts :: real invite signup switches identity without inheriting old account draft or cache`
     - `internal/httpapi/account_security_test.go :: TestAccountSecurityHTTPRotationCSRFAndOwnership`
     - `internal/httpapi/account_security_test.go :: TestAdminAccountDisableResetAndRetirementHTTP`
     - `web/tests/account-security-backend.ui.spec.ts :: real password change preserves failed reauthentication draft, rotates credentials and invalidates older sessions`
     - `web/tests/account-security-backend.ui.spec.ts :: administrator resets a synthetic account through the UI and temporary login cannot bypass required password change`
     - `internal/store/identity_test.go :: TestInviteIsSingleUseAndUsernameUnique; TestEncryptedStateAndSessionSurviveReopen`
     - `internal/auth/security.go :: HashPassword`
2. **Pause/expiry/renewal are separate commands with visible effect and audit records; a normal user cannot perform administrator commands.**
   - Disposition: `supported`.
   - Evidence groups: `account`, `cycle-api`, `cycle-browser`.
   - Bounded scope: Separate account/policy pause, expiry extension and explicit reset commands; real API/browser show state/usage distinction and audit. Normal-user admin mutation denied.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/account_security_test.go :: TestAccountSecurityHTTPRotationCSRFAndOwnership`
     - `internal/httpapi/account_security_test.go :: TestAdminAccountDisableResetAndRetirementHTTP`
     - `web/tests/cycle-renewal-backend.api.spec.ts :: isolated ${mode} cycle renewal and reset preserve meter identity and boundary`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real ${mode} cycle editor, renewal, explicit reset and user countdown`
     - `internal/httpapi/access_policy_test.go :: TestAccessPolicyHTTPPreviewApplyAndTenantIsolation`
     - `web/tests/cycle-renewal-backend.ts :: verifyReplayAndAudit`
3. **Administrator second-factor enrollment/verification and recovery behavior have explicit bounded tests and do not bypass authorization.**
   - Disposition: `supported`.
   - Evidence groups: `mfa-browser`, `account`.
   - Bounded scope: Real browser TOTP setup, wrong password/code/replay denial, new-step login and administrator recovery; store concurrent enrollment/session revocation and scoped audited recovery. No recovery bypass.
   - Exact selectors/retained receipt paths:
     - `web/tests/mfa-backend.ui.spec.ts :: synthetic administrator enrolls an authenticator, logs in with TOTP, and recovers through administrator reset`
     - `internal/httpapi/account_security_test.go :: TestAccountSecurityHTTPRotationCSRFAndOwnership`
     - `internal/httpapi/account_security_test.go :: TestAdminAccountDisableResetAndRetirementHTTP`
     - `internal/store/identity_test.go :: TestTOTPActualStepReplayRejected; TestMFAEnableRevokesSessionsAndCannotRepeat`
     - `internal/store/identity_lifecycle_test.go :: TestOfflineRecoveryIsScopedAuditedAndRetainsMFAUnlessExplicit`
     - `internal/store/identity_concurrency_test.go :: TestMFAEnrollmentCannotBeBypassedWithAnEarlierAccountSnapshot`
4. **Tenant ownership is enforced on every read/write/export, with another-user and unauthenticated denial tests.**
   - Disposition: `supported`.
   - Evidence groups: `tenant`, `account`.
   - Bounded scope: Owner-keyed tenant repository and authenticated API guard cover reads/writes/reveal/export; positive owner operations and explicit foreign/unauthenticated/CSRF denial at public seams.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/account_security_test.go :: TestAccountSecurityHTTPRotationCSRFAndOwnership`
     - `internal/httpapi/account_security_test.go :: TestAdminAccountDisableResetAndRetirementHTTP`
     - `internal/httpapi/collection_delete_test.go :: TestCollectionDeleteDependenciesAndOwnerBoundaryAtHTTPSeam`
     - `internal/httpapi/tenant.go :: registerTenant, sameOwner and tenant owner-keyed operations`

### RW-03 — Grant services and inspect effective access

Stories: A02, S01. Direct prerequisites: RW-01, RW-02. Forward status: `verified`.

1. **Group membership plus an explicit individual override produces a deterministic documented effective grant; multiple groups cannot silently add quota or routes.**
   - Disposition: `supported`.
   - Evidence groups: `policy`, `group-precedence`.
   - Bounded scope: Deterministic one-service priority/tie handling and explicit individual override; quota is not stacked, ambiguous distinct services fail closed, explicit same-service route union follows documented evaluator.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/access_policy_test.go :: TestAccessPolicyHTTPPreviewApplyAndTenantIsolation`
     - `internal/httpapi/access_policy_test.go :: TestAccessPolicyPreviewRejectsUnknownReferencesAndShowsAmbiguity`
     - `internal/service/effective_test.go :: TestEffectiveAccessSelectsOneGroupAndIndividualOverrides`
     - `internal/service/effective_test.go :: TestEffectiveAccessSameServiceTiesDoNotStackAndOverridesCanDenyAll`
2. **The affected-user preview and stored result agree; a revoked or expired grant is rechecked when a subscription is obtained.**
   - Disposition: `supported`.
   - Evidence groups: `group-precedence`, `policy-ui`.
   - Bounded scope: Authoritative affected-user preview and stored application agree. Feed retrieval rechecks current platform eligibility; expired/exhausted/disabled platform dependency is denied while independent private source conversion remains separate.
   - Exact selectors/retained receipt paths:
     - `internal/service/effective_test.go :: TestEffectiveAccessSelectsOneGroupAndIndividualOverrides`
     - `internal/service/effective_test.go :: TestEffectiveAccessSameServiceTiesDoNotStackAndOverridesCanDenyAll`
     - `web/src/policy-confirmation-content.dom.test.tsx :: shows the authoritative affected count and preserves exact comparisons, provenance and full authorization`
     - `internal/httpapi/access_policy_test.go :: TestAccessPolicyHTTPPreviewApplyAndTenantIsolation`
     - `internal/httpapi/external_feed_policy_test.go :: TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility`
     - `internal/httpapi/account_security_test.go :: TestAdminAccountDisableResetAndRetirementHTTP`
3. **Not-started, active, paused and expired services display correctly without inferring runtime deployment.**
   - Disposition: `supported`.
   - Evidence groups: `service-ui`, `cycle-browser`.
   - Bounded scope: Actual UI state table covers not-started, active, paused and expired; active says authorization effective, not deployed or live. Real cycle browser covers countdown/renewal.
   - Exact selectors/retained receipt paths:
     - `web/src/subscription-overview-status.dom.test.tsx :: names active authorization without presenting unlimited quota as available routes`
     - `web/src/subscription-overview-status.dom.test.tsx :: gives paused platform service a next step without granting restoration or changing personal subscriptions`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real ${mode} cycle editor, renewal, explicit reset and user countdown`
     - `web/src/subscription-overview-status.dom.test.tsx :: names the ordinary account's %s policy state`
4. **An invited user sees only their authorized service and public entry connectivity, not transit credentials.**
   - Disposition: `supported`.
   - Evidence groups: `tenant`, `published-native`, `service-ui`.
   - Bounded scope: Invited tenant sees own overview/platform entry; real published-principal API/native contract emits only granted public credential after exact applied manifest, never internal transit credential.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/published_native_test.go :: TestNativePublishedManagedPrincipalEndToEnd`
     - `web/src/subscription-overview-status.dom.test.tsx :: names active authorization without presenting unlimited quota as available routes`
     - `web/src/subscription-overview-status.dom.test.tsx :: gives paused platform service a next step without granting restoration or changing personal subscriptions`
     - `internal/httpapi/published_routes_test.go :: TestPublishedRoutePrincipalsRequireExactAppliedManifest`

### RW-04 — Import private sources without unsafe fetching

Stories: C101, F04. Direct prerequisites: RW-02. Forward status: `verified`.

1. **At least one explicit supported input fixture for each exposed input mode imports successfully and retains source provenance; configuration extraction reports ignored sections.**
   - Disposition: `supported`.
   - Evidence groups: `import`, `source-refresh`.
   - Bounded scope: URI/plain/base64, native Mihomo/sing-box config extraction and source refresh inputs have positive fixtures with immutable source/snapshot provenance; ignored non-node configuration is diagnosed. File UI is local acquisition into these same parser modes.
   - Exact selectors/retained receipt paths:
     - `internal/importer/import_test.go :: TestParseMihomoExtractsNodesAndReportsOtherConfig`
     - `internal/importer/import_test.go :: TestParseSingBoxExtractsNodesNotInternalGroups`
     - `internal/importer/import_test.go :: TestParseNoAuthSOCKSAndBase64SS`
     - `internal/importer/import_test.go :: TestParseRejectsUnsupportedSecurityWithoutPartialSnapshot`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshMaterialCandidateRequiresExactAcceptance`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshUnchangedKeepsSnapshotAndHarmlessRenamePreservesIdentity`
     - `internal/httpapi/source_refresh_test.go :: TestSourceCandidateRevealStaleEditDeletionAndInvalidPartial`
     - `internal/httpapi/source_mixed_atomic_test.go :: TestMixedSourceImportNeverStoresPartialAcceptedSnapshot`
     - `web/src/source-controls.dom.test.tsx :: offers a localized keyboard file picker, preserves cancellation and retries the same local file without uploading`
2. **Malformed, partially supported and oversized input has bounded diagnostics; failed refresh leaves the prior accepted snapshot and edited input intact.**
   - Disposition: `supported`.
   - Evidence groups: `import`, `source-refresh`.
   - Bounded scope: Mixed supported/unsupported/malformed imports are atomic and diagnostics bounded; failed edited input remains private/recoverable while last accepted snapshot and published feeds remain byte-identical. Fetch size bounds are explicit.
   - Exact selectors/retained receipt paths:
     - `internal/importer/import_test.go :: TestParseMihomoExtractsNodesAndReportsOtherConfig`
     - `internal/importer/import_test.go :: TestParseSingBoxExtractsNodesNotInternalGroups`
     - `internal/importer/import_test.go :: TestParseNoAuthSOCKSAndBase64SS`
     - `internal/importer/import_test.go :: TestParseRejectsUnsupportedSecurityWithoutPartialSnapshot`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshMaterialCandidateRequiresExactAcceptance`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshUnchangedKeepsSnapshotAndHarmlessRenamePreservesIdentity`
     - `internal/httpapi/source_refresh_test.go :: TestSourceCandidateRevealStaleEditDeletionAndInvalidPartial`
     - `internal/httpapi/source_mixed_atomic_test.go :: TestMixedSourceImportNeverStoresPartialAcceptedSnapshot`
     - `internal/httpapi/source_refresh_test.go :: TestSourceValidEmptyRequiresReviewAndFailedEditedInputRemainsSaved`
     - `internal/resources/fetch_test.go :: TestBodySizeAndHTTPError`
3. **Private/loopback/link-local destinations, redirects and DNS rebinding protections are tested at the fetcher seam; only an explicit loopback test transport bypass exists in tests.**
   - Disposition: `supported`.
   - Evidence groups: `fetch`.
   - Bounded scope: Fetcher rejects private/loopback/link-local and mixed DNS answers before dialing, pins resolved public address, revalidates redirects and suppresses secrets. Test loopback transport is explicitly constructed, not production global bypass.
   - Exact selectors/retained receipt paths:
     - `internal/resources/fetch_test.go :: TestFetchRejectsSpecialAddressesBeforeDial`
     - `internal/resources/fetch_test.go :: TestMixedDNSAnswersDeniedBeforeDial`
     - `internal/resources/fetch_test.go :: TestRedirectCannotReachPrivate`
     - `internal/resources/fetch_test.go :: TestTransportErrorRedactsSecret`
     - `internal/resources/fetch_test.go :: TestFetchPublicPinnedAndDigest; TestRedirectLoopIsBounded`
4. **Operator visibility is disclosed at import; logs, ordinary errors and source listings do not expose bearer URLs or credentials; cross-user access is denied.**
   - Disposition: `supported`.
   - Evidence groups: `tenant`, `external-feed`.
   - Bounded scope: Import UI visibly states operator visibility and account scope at submit. Normal source summaries/errors redact bearer material, owner-only reveal is explicit, foreign access denied.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/external_feed_policy_test.go :: TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility`
     - `web/src/source-task-layout.dom.test.tsx :: groups the four privacy facts with the actual submit action and retains a failed import`
     - `internal/resources/fetch_test.go :: TestTransportErrorRedactsSecret`

### RW-05 — Preview ordered source processing stages

Stories: C201, C202, C203. Direct prerequisites: RW-04. Forward status: `verified`.

1. **Filter, rename, stable sort, explicit connection-identity deduplication and allowlisted field override each have positive fixtures and precise invalid-step diagnostics.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline`, `override`.
   - Bounded scope: All supported processing operators have positive fixtures; precise scope/step errors and allowlisted region/tags/host/port override prevent hidden ownership/topology mutation.
   - Exact selectors/retained receipt paths:
     - `internal/conversion/pipeline_test.go :: TestSourceProcessingThenOrderedMergeThenAggregate`
     - `internal/conversion/pipeline_test.go :: TestDedupUsesConnectionNotDisplayNameAndKeepsProvenance`
     - `internal/conversion/pipeline_test.go :: TestPreviewRedactsSecretsWithoutMutatingAcceptedSnapshot`
     - `internal/conversion/pipeline_test.go :: TestCollectionOwnershipAndInvalidStepFailClosed`
     - `internal/conversion/override_test.go :: TestProcessCollectionOverrideSourceThenAggregatePreservesIdentityAndPreviews`
     - `internal/conversion/override_test.go :: TestProcessCollectionOverrideNilTagsPreservesAndEmptyTagsClears`
     - `internal/conversion/override_test.go :: TestProcessCollectionInvalidOverrideRejectsWithoutMutatingAcceptedInput`
     - `internal/conversion/pipeline_contract_test.go :: TestProcessingStableSortPreservesEqualKeySourceOrder`
     - `internal/conversion/pipeline.go :: applySteps`
2. **Disabling or reordering a step changes the preview deterministically; renaming never changes connection identity.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline`.
   - Bounded scope: Contract tables assert source order, stable ascending/descending sorts, disable/reorder effects and exact stable IDs through rename/override.
   - Exact selectors/retained receipt paths:
     - `internal/conversion/pipeline_test.go :: TestSourceProcessingThenOrderedMergeThenAggregate`
     - `internal/conversion/pipeline_test.go :: TestDedupUsesConnectionNotDisplayNameAndKeepsProvenance`
     - `internal/conversion/pipeline_test.go :: TestPreviewRedactsSecretsWithoutMutatingAcceptedSnapshot`
     - `internal/conversion/pipeline_test.go :: TestCollectionOwnershipAndInvalidStepFailClosed`
     - `internal/conversion/pipeline_contract_test.go :: TestProcessingStepOrderAndDisabledStepsAreExplicit`
3. **Every stage reports added/removed/changed options and reasons while redacting secrets; preview does not persist or publish.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline`, `pipeline-api`.
   - Bounded scope: Stage deltas use step input, not empty snapshot baseline; explicit addedIds/removedIds/changedIds and corresponding operation content/provenance explain changes. Secret-redacted preview does not persist or republish.
   - Exact selectors/retained receipt paths:
     - `internal/conversion/pipeline_test.go :: TestSourceProcessingThenOrderedMergeThenAggregate`
     - `internal/conversion/pipeline_test.go :: TestDedupUsesConnectionNotDisplayNameAndKeepsProvenance`
     - `internal/conversion/pipeline_test.go :: TestPreviewRedactsSecretsWithoutMutatingAcceptedSnapshot`
     - `internal/conversion/pipeline_test.go :: TestCollectionOwnershipAndInvalidStepFailClosed`
     - `web/tests/workspace.api.spec.ts :: private source → ordered collection → profile → published feed → revocation`
     - `internal/conversion/pipeline_contract_test.go :: TestProcessingAdditionsUseStepInputNotSnapshotSummary`
     - `internal/httpapi/processing_noop_publication_test.go :: TestNoOpProcessingRecipePreservesPublishedContentAndSibling`
4. **No-op changes do not create a false pending publication; an invalid override cannot change owner or administrator topology.**
   - Disposition: `supported`.
   - Evidence groups: `processing-api`, `pipeline-api`.
   - Bounded scope: Real HTTP no-op preview/save reports no false pending output change; rejected overrides preserve accepted source and frozen selected/sibling feeds. Conversion only owns tenant endpoint transformations.
   - Exact selectors/retained receipt paths:
     - `web/tests/processing-publication-backend.api.spec.ts :: isolated processing recipe preserves stages, source and sibling feed through exact publication`
     - `web/tests/workspace.api.spec.ts :: private source → ordered collection → profile → published feed → revocation`
     - `internal/httpapi/processing_noop_publication_test.go :: TestNoOpProcessingRecipePreservesPublishedContentAndSibling`
     - `internal/domain/profile.go :: EndpointOverride allowlist`

### RW-06 — Compose reusable ordered collections

Stories: C102, C201, C202, C203. Direct prerequisites: RW-05. Forward status: `verified`.

1. **Source processing runs before ordered merge and aggregate processing; a golden scenario exercises all three layers.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline`, `pipeline-api`.
   - Bounded scope: Golden source filter/rename -> ordered merge -> aggregate rename asserts three layers and exact resulting order/names; real API includes source/aggregate override and dedup provenance.
   - Exact selectors/retained receipt paths:
     - `internal/conversion/pipeline_test.go :: TestSourceProcessingThenOrderedMergeThenAggregate`
     - `internal/conversion/pipeline_test.go :: TestDedupUsesConnectionNotDisplayNameAndKeepsProvenance`
     - `internal/conversion/pipeline_test.go :: TestPreviewRedactsSecretsWithoutMutatingAcceptedSnapshot`
     - `internal/conversion/pipeline_test.go :: TestCollectionOwnershipAndInvalidStepFailClosed`
     - `web/tests/workspace.api.spec.ts :: private source → ordered collection → profile → published feed → revocation`
2. **Collection rename preserves references; delete previews dependents; missing or ambiguous identities produce diagnostics rather than silent substitution.**
   - Disposition: `supported`.
   - Evidence groups: `dependencies`, `collection-delete`, `collection-delete-ui`.
   - Bounded scope: Composed source + public seam support: collection Name is label only; saveCollection writes the same owner/ID key and profile materialization resolves CollectionID, so rename cannot rewrite references. Explicit dependency API names both dependents, prevents delete, and conversion diagnoses missing/duplicate identities. No new standalone collection-rename test claimed.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_relationship_race_test.go :: TestDeleteSourceCreateCollectionRacePreservesReferences`
     - `internal/httpapi/tenant_relationship_race_test.go :: TestDeleteDependencyCreateProfileRacePreservesReferences`
     - `internal/httpapi/collection_delete_test.go :: TestCollectionDeleteDependenciesAndOwnerBoundaryAtHTTPSeam`
     - `web/src/collection-delete.dom.test.tsx :: does not enable collection deletion before an authoritative dependency read and names every blocking profile`
     - `web/src/collection-delete.dom.test.tsx :: cancels collection deletion twice safely, then preserves failed deletion context and retries without cascading`
     - `web/src/collection-delete.dom.test.tsx :: keeps the selected collection after a newly added dependency rejects deletion and disables further deletion`
     - `internal/httpapi/tenant.go :: saveCollection, materializeProfileWithReader, collectionDependencies`
     - `internal/conversion/pipeline.go :: ProcessCollection identity checks`
3. **Multiple configurations can reuse a collection without sharing ownership or changing one another.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline-api`, `tenant`.
   - Bounded scope: Two real stored profiles reuse one owner-scoped collection; independent ID-keyed profile writes do not mutate sibling profile/collection, foreign lookup fails. Output scoping independently demonstrates selected publication leaves sibling frozen.
   - Exact selectors/retained receipt paths:
     - `web/tests/workspace.api.spec.ts :: private source → ordered collection → profile → published feed → revocation`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/collection_delete_test.go :: TestCollectionDeleteDependenciesAndOwnerBoundaryAtHTTPSeam`
     - `internal/httpapi/tenant.go :: materializeProfileWithReader, saveProfile`
     - `internal/httpapi/nested_source_publication_test.go :: TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication`
4. **Concurrent source update has a frozen snapshot identity; failed candidate preserves the last accepted collection.**
   - Disposition: `supported`.
   - Evidence groups: `source-refresh`, `frozen-routing`.
   - Bounded scope: Snapshot/source IDs are retained in provenance; templateInputs reads each exact record once and CompareAndPutRecords fences concurrent changes. Source candidate tests preserve accepted snapshots/collection materialization and published outputs on failure.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshMaterialCandidateRequiresExactAcceptance`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshUnchangedKeepsSnapshotAndHarmlessRenamePreservesIdentity`
     - `internal/httpapi/source_refresh_test.go :: TestSourceCandidateRevealStaleEditDeletionAndInvalidPartial`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `internal/httpapi/template_inputs.go :: TenantGet, expectRecord, compares`
     - `internal/httpapi/source_apply_mode_test.go :: TestSourceConcurrentManualApplyCommitsExactlyOneHistoryEvent`
     - `internal/httpapi/source_mixed_atomic_test.go :: TestMixedSourceImportNeverStoresPartialAcceptedSnapshot`

### RW-07 — Save independent full client profiles

Stories: C501, F03. Direct prerequisites: RW-06. Forward status: `in_progress`.

1. **Two profiles with different targets and settings persist independently; copying a template records provenance but future edits remain independent.**
   - Disposition: `supported`.
   - Evidence groups: `templates`, `native-overrides`.
   - Bounded scope: Composed bounded source/API evidence: independent profile ID/target/mode/runtime records plus two-profile reuse and both-target render/save contracts. Template copy stores binding provenance and remains independent of later template versions; local overrides survive reviewed follow updates. No new same-test two-target permutation claimed.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_test.go :: TestTemplatePresetCopyIsIsolatedAndVersionsImmutable`
     - `internal/httpapi/templates_test.go :: TestSharedTemplateRejectsPrivateShapesAndCrossTenantBindings`
     - `internal/httpapi/templates_test.go :: TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback`
     - `internal/httpapi/templates_test.go :: TestSwitchingTemplateReferenceModeKeepsPersonalRuntimeAndPrivateBindings`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/collection_delete_test.go :: TestCollectionDeleteDependenciesAndOwnerBoundaryAtHTTPSeam`
     - `internal/httpapi/tenant.go :: Profile, saveProfile (owner/ID-scoped target/settings)`
2. **Server deployment intent and client profile intent are distinct contracts; client operations cannot create deployments or retrieve transit secrets.**
   - Disposition: `supported`.
   - Evidence groups: `ir-isolation`, `tenant`.
   - Bounded scope: Separate ClientProfileIR/ServerDeploymentIR contracts, tenant materialization rejects internal origins/foreign ownership, user admin endpoints deny access; client save writes only tenant profiles and cannot publish server deployment.
   - Exact selectors/retained receipt paths:
     - `internal/domain/profile_test.go :: TestProfileDoesNotExportTransitOrAnotherOwner`
     - `internal/domain/profile_test.go :: TestReadableNamesPersistAcrossCollisionChanges`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/tenant.go :: materializeProfileWithReader, saveProfile`
     - `internal/httpapi/legacy_endpoint_options_test.go :: TestLegacyEndpointEditorPreservesTypedOptionsAndRouteIdentity`
3. **Draft and published revision are separate and stale writes fail without losing the submitted draft.**
   - Disposition: `unresolved`.
   - Evidence groups: `frozen-routing`, `native-overrides`.
   - Bounded scope: Published revisions remain frozen until explicit reviewed publication, and rejected-save DOM retains submitted draft; however stale profile-editor save denial is not established and source permits overwrite after an earlier editor commits.
   - Remaining condition: Stale draft editor overwrite is not rejected: saveProfile has no submitted/opened revision precondition; expectRecord reads the latest record when the request begins. If editor A commits before stale B submits, B can replace A. Current stale reviewed-publication409 and synthetic DOM409 tests are different seams. Minimal closure is guarded profile draft saves plus actual A/B stale public-seam denial and retained-draft UI evidence; no deployment requirement.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/tenant.go:54-68,382-416 :: Profile and saveProfile have no opened revision comparison`
     - `internal/httpapi/template_inputs.go:79-93 :: expectRecord reads current record during request, not submitted baseline`
     - `web/src/profile-content-hierarchy.dom.test.tsx :: new structured DNS selects its actual resolver and retains runtime intent after a rejected save`
4. **Default-template values and explicit overrides are visible and deterministic; the profile is not reduced to a node-only list.**
   - Disposition: `supported`.
   - Evidence groups: `templates`, `native-overrides`.
   - Bounded scope: Template defaults merge deterministically with explicit personal runtime/policy overrides, visible editor controls retain them; full rendering includes rules/groups/runtime and is explicitly distinct from nodes-only output.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_test.go :: TestTemplatePresetCopyIsIsolatedAndVersionsImmutable`
     - `internal/httpapi/templates_test.go :: TestSharedTemplateRejectsPrivateShapesAndCrossTenantBindings`
     - `internal/httpapi/templates_test.go :: TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback`
     - `internal/httpapi/templates_test.go :: TestSwitchingTemplateReferenceModeKeepsPersonalRuntimeAndPrivateBindings`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`

### RW-08 — Configure nested client strategy groups

Stories: C301, C302. Direct prerequisites: RW-07. Forward status: `blocked`.

1. **Valid nesting deeper than two levels works; self-reference, indirect cycles and empty effective membership are rejected with exact group diagnostics.**
   - Disposition: `supported`.
   - Evidence groups: `topology`, `dynamic-browser`.
   - Bounded scope: Three-level profile and real saved dynamic nested group policy work; identity DFS rejects self/indirect cycle at exact group ID, effective-empty membership reports groups[index], missing action metadata names exact stable group. Explicit UI empty-group regression is retained.
   - Exact selectors/retained receipt paths:
     - `internal/domain/profile_test.go :: TestTopologyAllowsThreeHopsSameHostAndDirect`
     - `internal/domain/profile_test.go :: TestProfileAcceptsDeepNestingAndRejectsCycle`
     - `internal/domain/profile_test.go :: TestRenamingDoesNotChangeStableReferences`
     - `web/tests/group-membership.ui.spec.ts :: automatic members are an explicit additive choice over current source, collection and platform connections`
     - `internal/domain/profile_validation.go :: ValidateClientProfile (effective membership and identity DFS)`
     - `web/src/group-membership.dom.test.tsx :: keeps the real empty-group error when automatic membership is explicitly disabled`
     - `internal/httpapi/nested_source_publication_test.go :: TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication`
2. **Manual, URL-test, fallback and load-balance each have positive native-validated output on at least one pinned target, not just an unsupported response.**
   - Disposition: `supported`.
   - Evidence groups: `native-client`, `render-extension`.
   - Bounded scope: Native checker invokes pinned actual Mihomo for manual/url-test/fallback/load-balance with exact emitted semantics, and sing-box for its supported cases. Requires CI9 native gate execution receipt, not ordinary skipped unit invocation; parent owns exact receipt binding.
   - Exact selectors/retained receipt paths:
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/render/client_test.go :: TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
     - `internal/render/client_test.go :: TestMihomoPreservesFourStrategiesAndResourceFile`
3. **Dynamic predicates resolve against the frozen source snapshot and preview member changes after refresh.**
   - Disposition: `supported`.
   - Evidence groups: `frozen-routing`, `dynamic-browser`.
   - Bounded scope: Real HTTP nested dynamic refresh asserts frozen saved/source identities, added member and group change preview, unchanged strategy; existing delivered feeds remain frozen until selected explicit publication, sibling unchanged.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `web/tests/group-membership.ui.spec.ts :: automatic members are an explicit additive choice over current source, collection and platform connections`
     - `internal/httpapi/nested_source_publication_test.go :: TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication`
4. **Unsupported target strategy or depth is diagnosed without coercing the group to manual or changing the intended server exit.**
   - Disposition: `supported`.
   - Evidence groups: `render-extension`, `native-client`.
   - Bounded scope: Target registry rejects unknown versions/adapters and unsupported sing-box fallback/load-balance with exact group location; retains intended strategy/default routing and rejects publication rather than coercing. No unsupported numeric depth limit is invented where target has none.
   - Exact selectors/retained receipt paths:
     - `internal/render/client_test.go :: TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
     - `internal/render/client_test.go :: TestMihomoPreservesFourStrategiesAndResourceFile`
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/httpapi/nested_source_publication_test.go :: TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication`

### RW-09 — Edit ordered rules and resource references

Stories: C401, C402. Direct prerequisites: RW-07. Forward status: `blocked`.

1. **A positive fixture covers ordered matching, a combined predicate and explicit final action; native validation confirms each claimed supported target.**
   - Disposition: `supported`.
   - Evidence groups: `native-client`, `overlay-safety`.
   - Bounded scope: Source + public HTTP + exact pinned native parser evidence; owner-private resources and frozen publication. No universal SRS compatibility or live external-resource service claim.
   - Exact selectors/retained receipt paths:
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/render/native_override_test.go :: TestNativeOverrideRejectsUnsupportedConflictsAndForeignReferences`
     - `internal/render/native_override_test.go :: TestNativeSingBoxRejectsCredentialMaterialOutsideConnections`
     - `internal/render/native_override_test.go :: TestNativeDNSResolverCyclesAndDanglingMihomoSelectorsAreRejected`
     - `internal/httpapi/structured_rule_journey_test.go :: TestStructuredRuntimeAndOwnedRuleVersionPublication`
2. **Rule resources support fixed/following versions with digest, provenance and explicit cache/fetch errors; resource failures preserve previous valid publication.**
   - Disposition: `supported`.
   - Evidence groups: `rule-bundle`, `rule-native`.
   - Bounded scope: Source + public HTTP + exact pinned native parser evidence; owner-private resources and frozen publication. No universal SRS compatibility or live external-resource service claim.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/resource_bundle_test.go :: TestOwnedRuleFilesPublishAsExactFrozenBundle`
     - `internal/httpapi/resource_bundle_test.go :: TestRuleFileImportRejectsUnownedPathsAndMismatchedPins`
     - `internal/httpapi/resource_bundle_native_test.go :: TestNativeOwnedRuleFileBundles`
     - `internal/httpapi/resource_bundle_test.go :: TestRuleRefreshFailureRetainsAcceptedBytesWithoutPretendingFreshness`
     - `internal/httpapi/structured_rule_journey_test.go :: TestStructuredRuntimeAndOwnedRuleVersionPublication`
3. **Target-specific resource formats are respected; SRS is not treated as universally compatible and mandatory semantics are not silently omitted or expanded.**
   - Disposition: `supported`.
   - Evidence groups: `rule-native`, `render-extension`.
   - Bounded scope: Source + public HTTP + exact pinned native parser evidence; owner-private resources and frozen publication. No universal SRS compatibility or live external-resource service claim.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/resource_bundle_native_test.go :: TestNativeOwnedRuleFileBundles`
     - `internal/render/client_test.go :: TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
     - `internal/render/client_test.go :: TestMihomoPreservesFourStrategiesAndResourceFile`
     - `internal/httpapi/resource_bundle_native_test.go :: TestNativeOwnedRuleFileBundles (mihomo-yaml/mrs/sing-box-source/srs target-specific native consumption and corruption rejection)`
4. **Private resource access is owner-scoped at retrieval and does not leak its bearer URL into ordinary previews or logs.**
   - Disposition: `supported`.
   - Evidence groups: `rule-bundle`, `fetch`, `tenant`.
   - Bounded scope: Source + public HTTP + exact pinned native parser evidence; owner-private resources and frozen publication. No universal SRS compatibility or live external-resource service claim.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/resource_bundle_test.go :: TestOwnedRuleFilesPublishAsExactFrozenBundle`
     - `internal/httpapi/resource_bundle_test.go :: TestRuleFileImportRejectsUnownedPathsAndMismatchedPins`
     - `internal/resources/fetch_test.go :: TestFetchRejectsSpecialAddressesBeforeDial`
     - `internal/resources/fetch_test.go :: TestMixedDNSAnswersDeniedBeforeDial`
     - `internal/resources/fetch_test.go :: TestRedirectCannotReachPrivate`
     - `internal/resources/fetch_test.go :: TestTransportErrorRedactsSecret`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/resource_bundle_test.go :: TestRuleRefreshFailureRetainsAcceptedBytesWithoutPretendingFreshness`
     - `internal/httpapi/resource_bundle_test.go :: TestRuleBundleRejectsTamperedFileAndForeignAcceptedVersion`

### RW-10 — Manage runtime settings and native overrides

Stories: C502, C503. Direct prerequisites: RW-07, RW-08, RW-09. Forward status: `blocked`.

1. **DNS, sniffing and TUN each have at least one positive supported-target fixture and a visible structured UI, without changing host OS permissions.**
   - Disposition: `supported`.
   - Evidence groups: `native-client`, `native-overlay-parser`.
   - Bounded scope: Structured UI and HTTP plus target-specific native validation. TUN configuration validation does not claim host TUN activation or change OS permissions.
   - Exact selectors/retained receipt paths:
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/httpapi/native_overrides_native_test.go :: TestNativeOverridePublishedArtifactsPassPinnedNativeParsers`
     - `web/tests/structured-runtime-backend.ui.spec.ts :: structured runtime editor → real saved preview → frozen output at ${width}`
     - `internal/httpapi/structured_rule_journey_test.go :: TestStructuredRuntimeAndOwnedRuleVersionPublication`
2. **Overlay precedence and conflicts are deterministic, namespace-scoped and target-bound; unsupported mandatory fields are rejected, not dropped.**
   - Disposition: `supported`.
   - Evidence groups: `overlay-safety`, `native-overrides`.
   - Bounded scope: Structured UI and HTTP plus target-specific native validation. TUN configuration validation does not claim host TUN activation or change OS permissions.
   - Exact selectors/retained receipt paths:
     - `internal/render/native_override_test.go :: TestNativeOverrideRejectsUnsupportedConflictsAndForeignReferences`
     - `internal/render/native_override_test.go :: TestNativeSingBoxRejectsCredentialMaterialOutsideConnections`
     - `internal/render/native_override_test.go :: TestNativeDNSResolverCyclesAndDanglingMihomoSelectorsAreRejected`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
3. **Native edits survive save/reopen/regeneration; malformed advanced input preserves the text and points to the conflicting field.**
   - Disposition: `supported`.
   - Evidence groups: `native-overrides`, `native-overlay-parser`.
   - Bounded scope: Structured UI and HTTP plus target-specific native validation. TUN configuration validation does not claim host TUN activation or change OS permissions.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/native_overrides_native_test.go :: TestNativeOverridePublishedArtifactsPassPinnedNativeParsers`
     - `web/src/workspace.dom.test.tsx :: keeps malformed native client text after a rejected preview and saves the exact draft`
     - `internal/render/native_override.go :: nativeError(PROTECTED_FIELD/DELETE_CONFLICT, field path) and schema diagnostics`
4. **Portable and target-only fields are distinguished in preview; unknown credentials or cross-tenant references cannot be introduced through overlays.**
   - Disposition: `supported`.
   - Evidence groups: `native-overrides`, `tenant`.
   - Bounded scope: Structured UI and HTTP plus target-specific native validation. TUN configuration validation does not claim host TUN activation or change OS permissions.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/render/native_override_test.go :: TestNativeOverrideRejectsForeignDNSDetour`
     - `internal/render/native_override_test.go :: TestNativeSingBoxRejectsCredentialMaterialOutsideConnections`
     - `internal/render/native_override_test.go :: TestNativeSingBoxRejectsUnmanagedServiceAndNamespaceReferences`
     - `internal/render/client_semantics_test.go :: TestClientSemanticSnapshotHasNoPortableClaimsForNativeOrNodesOnly`

### RW-11 — Render and verify actual client outputs

Stories: C601, F03. Direct prerequisites: RW-08, RW-09, RW-10. Forward status: `blocked`.

1. **Node-only and complete modes produce structurally different correct outputs, each parsed and validated rather than renamed file extensions.**
   - Disposition: `supported`.
   - Evidence groups: `native-nodes`, `native-client`.
   - Bounded scope: Pinned Mihomo 1.19.32 and sing-box client 1.14.3 parsing; real downloaded client traffic where explicitly named. Nodes-only is consumed in a minimal receiving config, not a physical-device import claim.
   - Exact selectors/retained receipt paths:
     - `internal/render/nodes_native_test.go :: TestNativeClientNodesOnlyConsumption`
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
2. **Mihomo and sing-box are separately described with exact pinned version, supported/unsupported/unverified capabilities and positive native validator evidence.**
   - Disposition: `supported`.
   - Evidence groups: `native-client`, `render-extension`.
   - Bounded scope: Pinned Mihomo 1.19.32 and sing-box client 1.14.3 parsing; real downloaded client traffic where explicitly named. Nodes-only is consumed in a minimal receiving config, not a physical-device import claim.
   - Exact selectors/retained receipt paths:
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/render/client_test.go :: TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions`
     - `internal/render/client_test.go :: TestClientFullAndNodesOnlyAreDifferentOutputs`
     - `internal/render/client_test.go :: TestMihomoPreservesFourStrategiesAndResourceFile`
     - `internal/render/client_registry.go :: MihomoVersion=1.19.32; SingBoxVersion=1.14.3; exact-version registry gate`
     - `internal/render/stock_versions_test.go :: TestStockSecurityVersionsPreserveHistoricalAndIndependentTargets`
3. **Output is deterministic from a frozen manifest, preserves stable output references and includes only necessary user-owned or granted entry credentials.**
   - Disposition: `supported`.
   - Evidence groups: `frozen-routing`, `tenant`, `client-delivery`.
   - Bounded scope: Pinned Mihomo 1.19.32 and sing-box client 1.14.3 parsing; real downloaded client traffic where explicitly named. Nodes-only is consumed in a minimal receiving config, not a physical-device import claim.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/client_delivery_native_test.go :: TestNativeInvitedUserDownloadedClientTraffic`
     - `internal/httpapi/client_delivery_native_test.go :: TestClientDeliverySOCKSFixtureIsDestinationBounded`
     - `internal/httpapi/client_delivery_native_test.go :: TestNativeInvitedUserDownloadedClientTraffic/{mihomo,sing-box}`
     - `internal/render/client_semantics_test.go :: TestFullConfigSecretInspectionUsesOnlyVerifiedFrozenObjects`
4. **No output exports administrator topology, transit credentials, owner/source identifiers or hidden unresolved references; redacted preview is not labeled importable.**
   - Disposition: `supported`.
   - Evidence groups: `ir-isolation`, `tenant`, `native-overrides`.
   - Bounded scope: Pinned Mihomo 1.19.32 and sing-box client 1.14.3 parsing; real downloaded client traffic where explicitly named. Nodes-only is consumed in a minimal receiving config, not a physical-device import claim.
   - Exact selectors/retained receipt paths:
     - `internal/domain/profile_test.go :: TestProfileDoesNotExportTransitOrAnotherOwner`
     - `internal/domain/profile_test.go :: TestReadableNamesPersistAcrossCollisionChanges`
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewRedactsURLAuthenticationButExportRetainsExactData`
     - `internal/render/client_semantics_test.go :: TestFullConfigSecretInspectionUsesOnlyVerifiedFrozenObjects`

### RW-12 — Publish and rotate multiple subscriptions

Stories: C602. Direct prerequisites: RW-03, RW-11. Forward status: `blocked`.

1. **Draft edits do not remove access to an existing published revision; failed compilation or compatibility checks retain the previous valid output.**
   - Disposition: `supported`.
   - Evidence groups: `frozen-routing`, `native-overrides`.
   - Bounded scope: Actual UI/HTTP publication, fetch, download, selected rotation, trusted clipboard and decoded rendered QR. No unexposed import integration or mobile-device import claimed.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `internal/httpapi/native_overrides_test.go :: TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave`
     - `internal/httpapi/native_overrides_test.go :: TestNativePreviewAndPublishedOutputUseSameFinalComposition`
     - `internal/httpapi/native_overrides_test.go :: TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate`
     - `internal/httpapi/structured_rule_journey_test.go :: TestStructuredRuntimeAndOwnedRuleVersionPublication`
2. **Rotation invalidates only the selected old link; revoke and grant expiry are checked at every fetch; cross-user listing and retrieval fail.**
   - Disposition: `supported`.
   - Evidence groups: `tenant`, `rotation-browser`, `client-delivery`.
   - Bounded scope: Actual UI/HTTP publication, fetch, download, selected rotation, trusted clipboard and decoded rendered QR. No unexposed import integration or mobile-device import claimed.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `web/tests/product-model.ui.spec.ts :: existing strategy groups remain editable and revoked recovery replaces only the selected client link`
     - `web/tests/product-model.ui.spec.ts :: scoped configuration creates one independent second-client subscription and immediately exposes its new link`
     - `internal/httpapi/client_delivery_native_test.go :: TestNativeInvitedUserDownloadedClientTraffic`
     - `internal/httpapi/client_delivery_native_test.go :: TestClientDeliverySOCKSFixtureIsDestinationBounded`
     - `internal/httpapi/output_rotation_recovery_test.go :: TestOutputRotationRecoveryPreservesKnownMissingProofAsUnconfirmed`
     - `internal/httpapi/output_rotation_recovery_test.go :: TestOutputRotationRecoveryDoesNotMisclassifyRevocationOrPlatformSuspension`
     - `internal/httpapi/external_feed_policy_test.go :: TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility/{expired,exhausted}`
     - `internal/httpapi/outputs.go :: feed invokes authorizeOutputDelivery on every fetch`
3. **Names and collision disambiguation are stable under input reordering and all group/rule references follow a deliberate rename.**
   - Disposition: `supported`.
   - Evidence groups: `pipeline-api`, `frozen-routing`.
   - Bounded scope: Actual UI/HTTP publication, fetch, download, selected rotation, trusted clipboard and decoded rendered QR. No unexposed import integration or mobile-device import claimed.
   - Exact selectors/retained receipt paths:
     - `web/tests/workspace.api.spec.ts :: private source → ordered collection → profile → published feed → revocation`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication`
     - `internal/httpapi/output_routing_summary_test.go :: TestPublishedRoutingSummarySourceRenameChangesCandidateOnly`
     - `internal/render/rename_references_test.go :: TestExplicitEndpointAndGroupRenamePreservesRenderedReferences`
     - `internal/domain/profile_test.go :: TestStableNamesDoNotDependOnInputOrder`
     - `internal/domain/profile_test.go :: TestReadableNamesPersistAcrossCollisionChanges`
     - `internal/domain/profile_test.go :: TestRenamingDoesNotChangeStableReferences`
4. **At least copied links and file download work end-to-end; any additional QR/import button only appears when its supported target integration actually works.**
   - Disposition: `supported`.
   - Evidence groups: `rotation-browser`, `first-feed-browser`.
   - Bounded scope: Actual UI/HTTP publication, fetch, download, selected rotation, trusted clipboard and decoded rendered QR. No unexposed import integration or mobile-device import claimed.
   - Exact selectors/retained receipt paths:
     - `web/tests/product-model.ui.spec.ts :: existing strategy groups remain editable and revoked recovery replaces only the selected client link`
     - `web/tests/product-model.ui.spec.ts :: scoped configuration creates one independent second-client subscription and immediately exposes its new link`
     - `web/tests/first-subscription.ui.spec.ts :: first subscription skips the empty target gate but preserves save, cancel, review, and explicit publication`
     - `web/tests/service-center-backend.ui.spec.ts :: E09 invited service center keyboard delivery and selected-link rotation at ${width}px`
     - `/workspace/scratch/d385eb428cee/checklist-evidence-20261101/browser-41406226333/RECEIPT.md :: six real clipboard + rendered QR decoding checks at 1440/390`

### RW-13 — Account route usage and reset periods

Stories: F05, S02, A03. Direct prerequisites: RW-03. Forward status: `verified`.

1. **A 1 GB whole-route measurement at 2× debits 2 GB once, never once per hop; duplicate/reordered measurements do not double-charge.**
   - Disposition: `supported`.
   - Evidence groups: `billing`, `counter`, `published-native`.
   - Bounded scope: Exact synthetic accounting measurements and public seams joined to existing native whole-route settlement, calendar/source/history and real browser evidence. 1 GB accounting input is not a claim of 1 GB physically transferred traffic.
   - Exact selectors/retained receipt paths:
     - `internal/store/billing_test.go :: TestMeterRecordsOverQuotaAndKeepsHistoricalRate`
     - `internal/store/billing_test.go :: TestFractionalRateRoundsAfterAggregation`
     - `internal/store/counter_ingestion_test.go :: TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider`
     - `internal/store/counter_ingestion_test.go :: TestCounterCursorDoesNotResetOnBillingCycleChange`
     - `internal/store/counter_ingestion_test.go :: TestCounterCalendarAndManualBoundaryNeedExactObservation`
     - `internal/httpapi/published_native_test.go :: TestNativePublishedManagedPrincipalEndToEnd`
     - `internal/store/billing_test.go :: TestMeterGigabyteAtDoubleRateDebitsOnceAndKeepsHistoricalRate`
     - `internal/store/admission_budget_test.go :: TestManagedAggregateSnapshotsDoNotDoubleDebitAdmissionLedger`
2. **Every debit retains its applicable multiplier/policy and period; provider IN+OUT is separate; late-data attribution and rounding rules are documented and tested.**
   - Disposition: `supported`.
   - Evidence groups: `billing`, `counter`, `budget`.
   - Bounded scope: Exact synthetic accounting measurements and public seams joined to existing native whole-route settlement, calendar/source/history and real browser evidence. 1 GB accounting input is not a claim of 1 GB physically transferred traffic.
   - Exact selectors/retained receipt paths:
     - `internal/store/billing_test.go :: TestMeterRecordsOverQuotaAndKeepsHistoricalRate`
     - `internal/store/billing_test.go :: TestFractionalRateRoundsAfterAggregation`
     - `internal/store/counter_ingestion_test.go :: TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider`
     - `internal/store/counter_ingestion_test.go :: TestCounterCursorDoesNotResetOnBillingCycleChange`
     - `internal/store/counter_ingestion_test.go :: TestCounterCalendarAndManualBoundaryNeedExactObservation`
     - `internal/store/admission_budget_test.go :: TestBudgetPinsRateBoundaryAndPreservesLateHistoricalCharge`
     - `internal/store/admission_budget_test.go :: TestManagedAggregateSnapshotsDoNotDoubleDebitAdmissionLedger`
     - `internal/store/admission_budget_test.go :: TestIssuedBudgetsFenceQuotaReductionAndCycleChange`
     - `internal/store/counter_ingestion_test.go :: TestCounterPolicyBoundaryAutomaticallyContinuesWithoutGuessing`
3. **Fixed monthly day, activation calendar-month anniversary, fixed-day interval and no-auto-reset work in UTC+8; missing dates clamp to month-end then recover the original anchor.**
   - Disposition: `supported`.
   - Evidence groups: `calendar`, `cycle-api`, `cycle-browser`.
   - Bounded scope: Exact synthetic accounting measurements and public seams joined to existing native whole-route settlement, calendar/source/history and real browser evidence. 1 GB accounting input is not a claim of 1 GB physically transferred traffic.
   - Exact selectors/retained receipt paths:
     - `internal/service/cycle_test.go :: TestCalendarClampingRestoresDay`
     - `internal/service/cycle_test.go :: TestWeightedUsesIntegerCeiling`
     - `web/tests/cycle-renewal-backend.api.spec.ts :: isolated ${mode} cycle renewal and reset preserve meter identity and boundary`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real ${mode} cycle editor, renewal, explicit reset and user countdown`
     - `web/tests/cycle-renewal-backend.ts :: cycleModes and assertCycleWindow`
4. **Manual reset keeps the next automatic reset anchor; renewal does not reset usage and unused quota does not roll over; history remains queryable.**
   - Disposition: `supported`.
   - Evidence groups: `calendar`, `cycle-api`, `lossless-history`.
   - Bounded scope: Exact synthetic accounting measurements and public seams joined to existing native whole-route settlement, calendar/source/history and real browser evidence. 1 GB accounting input is not a claim of 1 GB physically transferred traffic.
   - Exact selectors/retained receipt paths:
     - `internal/service/cycle_test.go :: TestCalendarClampingRestoresDay`
     - `internal/service/cycle_test.go :: TestWeightedUsesIntegerCeiling`
     - `web/tests/cycle-renewal-backend.api.spec.ts :: isolated ${mode} cycle renewal and reset preserve meter identity and boundary`
     - `internal/store/history_read_recovery_test.go :: TestHistoricalUsageContextStreamsCanonicalWindowAndCancels`
     - `internal/store/history_read_recovery_test.go :: TestReopenDoesNotTrustRestoredTriggerAfterOfflineBypass`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real ${mode} cycle editor, renewal, explicit reset and user countdown`
     - `internal/store/usage_history_test.go :: TestUsageHistoryOwnerIndexKeepsExactWindowsAndMutations`
     - `internal/store/admission_budget.go :: immutable CycleStart window; available = policy.Quota - usage.WeightedBytes - reserved (no previous-cycle quota addition)`
     - `internal/service/effective.go :: ResolvePolicy uses declared plan/individual quota, not prior-cycle remainder`
5. **Displayed next reset/timezone/countdown matches the persisted policy; no-reset and unconfigured states never fabricate a countdown.**
   - Disposition: `supported`.
   - Evidence groups: `cycle-ui`, `cycle-browser`, `service-ui`.
   - Bounded scope: Exact synthetic accounting measurements and public seams joined to existing native whole-route settlement, calendar/source/history and real browser evidence. 1 GB accounting input is not a claim of 1 GB physically transferred traffic.
   - Exact selectors/retained receipt paths:
     - `web/src/service-cycle-defaults.dom.test.tsx :: retains the complete $name cycle through an unrelated edit, preview and explicit apply`
     - `web/src/service-cycle-defaults.dom.test.tsx :: leaves the account's no-reset anchor, timezone control and implicit start unchanged`
     - `web/src/service-cycle-defaults.dom.test.tsx :: preserves hidden precise cycles across stale preview, explicit latest acceptance and a failed apply`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real ${mode} cycle editor, renewal, explicit reset and user countdown`
     - `web/src/subscription-overview-status.dom.test.tsx :: names active authorization without presenting unlimited quota as available routes`
     - `web/src/subscription-overview-status.dom.test.tsx :: gives paused platform service a next step without granting restoration or changing personal subscriptions`
     - `web/src/model.test.ts :: counts down from the actual reset instant and does not invent a date`
     - `web/src/model.test.ts :: shows a configured UTC+8 reset without browser timezone ambiguity`

### RW-14 — Enforce online-IP and entry limits

Stories: A04. Direct prerequisites: RW-03, RW-13, RW-15. Forward status: `verified`.

1. **The same client IP at multiple public entries counts once; transit VPS IPs and private-airport direct traffic are excluded; freshness/window is explicit.**
   - Disposition: `supported`.
   - Evidence groups: `ip-limit`.
   - Bounded scope: One-user × logical public-entry bounded leases/rate; public-ingress binding excludes transit/private external subscriptions by ownership boundary. Native local executable timing, not WAN/global-rate/SLA evidence.
   - Exact selectors/retained receipt paths:
     - `internal/store/admission_test.go :: TestAdmissionUnionCountsNormalizedIPsAcrossEntriesAndDurablyRenews`
     - `internal/store/admission_test.go :: TestAdmissionRenewalRespectsRevocationQuotaAndHolds`
     - `internal/store/admission_test.go :: TestConnectionLimitCountsIndependentStreamsOnSameIPAndRenewsAtCap`
     - `internal/store/admission_test.go :: TestAdmissionScopesPresenceAndExpiresStaleIPs`
     - `internal/store/admission.go :: SetEntryAdmissionBinding requires current owned platform-entries grant and public principal; imported subscriptions/transit cannot create binding`
     - `internal/store/admission_manifest_test.go :: TestManagedBindingCannotUseLegacyGrantBypass`
     - `internal/httpapi/published_principals.go :: binding created only for public entry principal`
     - `internal/httpapi/external_feed_policy_test.go :: TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility`
2. **An over-limit new IP is rejected; expired/paused/exhausted access stops under a documented bounded lease policy; unknown quota cannot grant unbounded access.**
   - Disposition: `supported`.
   - Evidence groups: `ip-limit`, `continuous-native`, `provider-native`.
   - Bounded scope: One-user × logical public-entry bounded leases/rate; public-ingress binding excludes transit/private external subscriptions by ownership boundary. Native local executable timing, not WAN/global-rate/SLA evidence.
   - Exact selectors/retained receipt paths:
     - `internal/store/admission_test.go :: TestAdmissionUnionCountsNormalizedIPsAcrossEntriesAndDurablyRenews`
     - `internal/store/admission_test.go :: TestAdmissionRenewalRespectsRevocationQuotaAndHolds`
     - `internal/store/admission_test.go :: TestConnectionLimitCountsIndependentStreamsOnSameIPAndRenewsAtCap`
     - `internal/httpapi/service_native_test.go :: TestNativeContinuousManagedServicePreservesPayloadAndRevocation`
     - `internal/httpapi/provider_native_test.go :: TestNativeManagedProviderSuspensionAndRecovery`
     - `internal/store/admission_budget_test.go :: TestExpiredBudgetCannotBeReissuedUntilFinalEvidence`
3. **Rate limit is shared by upload/download and all connections for one user × logical entry, independent across entries; no strict global-rate claim.**
   - Disposition: `supported`.
   - Evidence groups: `published-native`, `continuous-native`.
   - Bounded scope: One-user × logical public-entry bounded leases/rate; public-ingress binding excludes transit/private external subscriptions by ownership boundary. Native local executable timing, not WAN/global-rate/SLA evidence.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/published_native_test.go :: TestNativePublishedManagedPrincipalEndToEnd`
     - `internal/httpapi/service_native_test.go :: TestNativeContinuousManagedServicePreservesPayloadAndRevocation`
     - `internal/agent/managed_entry_rate_native_test.go :: TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries`
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/monitor/named-native-web-receipt.json :: rate case PASS once, 8.58s, job125148744066, exact3090642`
4. **At least one pinned executable runtime has positive limit enforcement evidence with latency and existing-connection behavior measured; simulation alone cannot close this ticket.**
   - Disposition: `supported`.
   - Evidence groups: `published-native`, `continuous-native`, `operational-recovery`.
   - Bounded scope: One-user × logical public-entry bounded leases/rate; public-ingress binding excludes transit/private external subscriptions by ownership boundary. Native local executable timing, not WAN/global-rate/SLA evidence.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/published_native_test.go :: TestNativePublishedManagedPrincipalEndToEnd`
     - `internal/httpapi/service_native_test.go :: TestNativeContinuousManagedServicePreservesPayloadAndRevocation`
     - `internal/httpapi/service_native_test.go :: TestNativeManagedOperationalRecovery`
     - `internal/agent/managed_entry_rate_native_test.go :: TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries`
     - `internal/httpapi/service_native_test.go :: TestNativeContinuousManagedServicePreservesPayloadAndRevocation (existing flow closes within MaxLease+3s; process remains alive)`

### RW-15 — Apply and recover staged local revisions

Stories: F01, K03. Direct prerequisites: RW-01. Forward status: `verified`.

1. **Pinned Xray and sing-box configurations are natively validated and applied in an isolated local harness; generated is never reported as applied.**
   - Disposition: `supported`.
   - Evidence groups: `fleet-native`, `native-client`.
   - Bounded scope: Isolated Linux local harness with pinned stock Xray 26.10.31/sing-box 1.14.4 and managed runtime as applicable; exact observed revision/fences, not a real VPS rollout.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback`
     - `internal/render/native_test.go :: TestNativeClientFixtures`
     - `internal/agent/supervisor_test.go :: TestNativeSupervisorLifecycleAndRestart/{xray,sing-box}`
     - `scripts/native-cores.sh :: strict required runtime subtests reject missing/skipped xray/sing-box lifecycle results`
2. **Stale generations, duplicate requests, partial failures, disconnect and restart are exercised; observed active artifact identifies the validated revision.**
   - Disposition: `supported`.
   - Evidence groups: `agent-fences`, `fleet-native`, `continuous-native`.
   - Bounded scope: Isolated Linux local harness with pinned stock Xray 26.10.31/sing-box 1.14.4 and managed runtime as applicable; exact observed revision/fences, not a real VPS rollout.
   - Exact selectors/retained receipt paths:
     - `internal/agent/reconciler_test.go :: TestRestartRetainsFenceAndDoesNotReplay`
     - `internal/agent/reconciler_test.go :: TestUnknownOutcomeBlocksNewerMutationUntilObserved`
     - `internal/agent/reconciler_test.go :: TestLostAcknowledgementRecoveredByIdentityNotReplayed`
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback`
     - `internal/httpapi/service_native_test.go :: TestNativeContinuousManagedServicePreservesPayloadAndRevocation`
     - `internal/agent/reconciler_test.go :: TestValidateBeforeActivationAndGenerationFence`
     - `internal/agent/reconciler_test.go :: TestDelayedOldOperationCannotOvertakeCompletedNewGeneration`
     - `internal/agent/supervisor_test.go :: TestNativeSupervisorLifecycleAndRestart/{xray,sing-box}`
     - `web/tests/publication-native.native.spec.ts :: same browser publication is observed by the owned native instance and stopped (exact nine identity fields, stale409 and stop cleanup)`
3. **Rollback is a new fenced operation with verified result; failure preserves last known valid state and the attempted draft; no implicit exit substitution.**
   - Disposition: `supported`.
   - Evidence groups: `fleet-native`, `agent-fences`.
   - Bounded scope: Isolated Linux local harness with pinned stock Xray 26.10.31/sing-box 1.14.4 and managed runtime as applicable; exact observed revision/fences, not a real VPS rollout.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback`
     - `internal/agent/reconciler_test.go :: TestRestartRetainsFenceAndDoesNotReplay`
     - `internal/agent/reconciler_test.go :: TestUnknownOutcomeBlocksNewerMutationUntilObserved`
     - `internal/agent/reconciler_test.go :: TestLostAcknowledgementRecoveredByIdentityNotReplayed`
     - `internal/agent/reconciler_test.go :: TestKnownFailedActivationRestoresOnlyUncommittedPointer`
     - `internal/httpapi/fleet_test.go :: TestFleetRollbackRefreshesCredentialsAndDoesNotResurrectRevokedGrants`
4. **The scoped agent cannot run arbitrary shell or access unrelated tenant sources; live VPS enrollment/credentials are not performed by the development harness.**
   - Disposition: `supported`.
   - Evidence groups: `tenant`, `agent-fences`.
   - Bounded scope: Isolated Linux local harness with pinned stock Xray 26.10.31/sing-box 1.14.4 and managed runtime as applicable; exact observed revision/fences, not a real VPS rollout.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/tenant_test.go :: TestTenantIsolationAndCSRFAtHTTPSeam`
     - `internal/httpapi/tenant_test.go :: TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped`
     - `internal/httpapi/tenant_test.go :: TestFeedRotationAndRevocation`
     - `internal/agent/reconciler_test.go :: TestRestartRetainsFenceAndDoesNotReplay`
     - `internal/agent/reconciler_test.go :: TestUnknownOutcomeBlocksNewerMutationUntilObserved`
     - `internal/agent/reconciler_test.go :: TestLostAcknowledgementRecoveredByIdentityNotReplayed`
     - `internal/agent/contracts.go :: scoped Adapter Validate/Activate/Observe contract, no arbitrary remote command`
     - `internal/agent/reconciler_test.go :: TestInvalidArtifactScopeAndDriftAreRejected`
     - `internal/agent/reconciler_test.go :: TestStateDoesNotExposePrivateArtifactsAndRootHasOneWriter`
     - `internal/httpapi/fleet_test.go :: TestFleetStalePreviewConcurrentExecutionAndAuthorization`

### RW-16 — Operate scoped fleet batches

Stories: K01. Direct prerequisites: RW-15. Forward status: `verified`.

1. **A batch names exact targets, core versions and expected disruption before execution; each target outcome and retry attempt is visible.**
   - Disposition: `supported`.
   - Evidence groups: `fleet`.
   - Bounded scope: Scoped batch planning/execution/install/retry software contract plus opt-in local native official-artifact evidence. Actual VPS target, credentials, rollout and authorization remain external prerequisites.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/fleet_test.go :: TestFleetPhasesKeepSuccessAndRetryOnlyFailedTargets`
     - `internal/httpapi/fleet_test.go :: TestFleetStalePreviewConcurrentExecutionAndAuthorization`
     - `internal/httpapi/fleet_test.go :: TestFleetUpgradeNamesExactOldNewIdentityAndRejectsUnknownRuntime`
2. **Only declared official release artifacts with integrity checks can be installed in an isolated sandbox; no arbitrary remote-shell endpoint is introduced.**
   - Disposition: `supported`.
   - Evidence groups: `upgrade-native`, `fleet-native`.
   - Bounded scope: Scoped batch planning/execution/install/retry software contract plus opt-in local native official-artifact evidence. Actual VPS target, credentials, rollout and authorization remain external prerequisites.
   - Exact selectors/retained receipt paths:
     - `internal/agent/stock_upgrade_native_test.go :: TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease`
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback`
     - `internal/agent/core_install_test.go :: TestCoreInstallerRejectsUnpinnedReleaseAndCorruptArchive`
     - `internal/agent/core_install_test.go :: TestNativeCoreInstallerPreparesImmutableOfficialExecutables`
     - `internal/httpapi/fleet_test.go :: TestFleetInstallRequiresCatalogAndExactInstalledEvidenceNotRunning`
     - `internal/agent/contracts.go :: scoped Adapter methods, no arbitrary command field`
3. **A failed target does not turn the whole batch green or overwrite successful observations; retries are idempotent and generation-fenced.**
   - Disposition: `supported`.
   - Evidence groups: `fleet`, `agent-fences`.
   - Bounded scope: Scoped batch planning/execution/install/retry software contract plus opt-in local native official-artifact evidence. Actual VPS target, credentials, rollout and authorization remain external prerequisites.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/fleet_test.go :: TestFleetPhasesKeepSuccessAndRetryOnlyFailedTargets`
     - `internal/httpapi/fleet_test.go :: TestFleetStalePreviewConcurrentExecutionAndAuthorization`
     - `internal/httpapi/fleet_test.go :: TestFleetUpgradeNamesExactOldNewIdentityAndRejectsUnknownRuntime`
     - `internal/agent/reconciler_test.go :: TestRestartRetainsFenceAndDoesNotReplay`
     - `internal/agent/reconciler_test.go :: TestUnknownOutcomeBlocksNewerMutationUntilObserved`
     - `internal/agent/reconciler_test.go :: TestLostAcknowledgementRecoveredByIdentityNotReplayed`
     - `internal/httpapi/fleet_test.go :: TestFleetPartialEnrollmentFailureRetainsInputAndSuccessHistory`
     - `internal/agent/reconciler_test.go :: TestDelayedOldOperationCannotOvertakeCompletedNewGeneration`
4. **Local tests establish planning and execution contracts; real VPS rollout remains separately authorized and is not required to run ordinary CI.**
   - Disposition: `supported`.
   - Evidence groups: `fleet`, `fleet-native`.
   - Bounded scope: Scoped batch planning/execution/install/retry software contract plus opt-in local native official-artifact evidence. Actual VPS target, credentials, rollout and authorization remain external prerequisites.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/fleet_test.go :: TestFleetPhasesKeepSuccessAndRetryOnlyFailedTargets`
     - `internal/httpapi/fleet_test.go :: TestFleetStalePreviewConcurrentExecutionAndAuthorization`
     - `internal/httpapi/fleet_test.go :: TestFleetUpgradeNamesExactOldNewIdentityAndRejectsUnknownRuntime`
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback`
     - `internal/httpapi/fleet_native_test.go :: TestNativeFleetConfigureStopStartAndRollback (opt-in isolated local process harness)`
     - `internal/agent/core_install_test.go :: TestNativeCoreInstallerPreparesImmutableOfficialExecutables (explicit official archive input)`
     - `AGENTS.md :: no live rollout implied by local/native verification`

### RW-17 — Track provider resources separately

Stories: K04. Direct prerequisites: RW-13, RW-15. Forward status: `verified`.

1. **Provider cumulative IN+OUT, bandwidth rate, capacity and user weighted debit have distinct units and ledgers.**
   - Disposition: `supported`.
   - Evidence groups: `provider`, `billing`.
   - Bounded scope: Real authenticated observation HTTP path and deterministic accounting fixtures distinguish host IN+OUT, rates, quota and weighted user ledger; not provider-invoice reconciliation.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/node_observations_test.go :: TestNodeResourcesAndProviderAllowanceHaveAuthenticatedEndToEndDataPath`
     - `internal/observability/observability_test.go :: TestProviderEstimateRequiresOperatorBaselineAndCountsSelectedINPlusOUTOnly`
     - `internal/store/counter_ingestion_test.go :: TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider`
2. **Provider cycles and alert/exhaustion thresholds persist with explicit timezone and source; missing samples appear unknown rather than zero.**
   - Disposition: `supported`.
   - Evidence groups: `provider`, `provider-policy`, `provider-ui`.
   - Bounded scope: Persisted time.Time instants and source, explicit local-time entry labels and UTC serialization, saved notification thresholds, unknown rather than fabricated zero; no new timezone-enum requirement.
   - Exact selectors/retained receipt paths:
     - `internal/observability/observability_test.go :: TestConfigRequiresLabeledUnitsCycleAndExplicitProviderInterfaces; TestInitialObservationNeverInventsCPUOrProviderConsumption; TestProviderStatementIsIndependentOfNICAndOldOrFutureInputsCannotAlert`
     - `internal/notifications/acceptance_matrix_test.go :: TestNotificationEventAudienceChannelAcceptanceMatrix`
     - `web/src/ObservationForms.tsx :: explicit browser-local cycle labels`
     - `web/src/observability-model.ts :: providerTimestamp`
     - `web/src/observation-footer.dom.test.tsx :: explicit provider cycle retains original ISO start/end`
3. **Exhaustion behavior follows explicit policy and does not silently switch the route exit.**
   - Disposition: `supported`.
   - Evidence groups: `provider-policy`, `provider-native`, `provider-fence`.
   - Bounded scope: Explicit advisory/suspend policy; same managed native runtime identity survives denial/recovery; exact applied-hop policy and stale/unknown observations fail closed without exit substitution.
   - Exact selectors/retained receipt paths:
     - `internal/store/provider_admission_test.go :: TestProviderSuspensionFollowsExactAppliedHopsAndKeepsSettlement`
     - `internal/httpapi/provider_native_test.go :: TestNativeManagedProviderSuspensionAndRecovery`
4. **Counter epoch, duplicate sample, cycle boundary and stale-observation fixtures verify resource calculations and their presentation.**
   - Disposition: `supported`.
   - Evidence groups: `provider`, `provider-fence`.
   - Bounded scope: Counter reset/epoch/gap/replay/cycle/staleness calculation fixtures plus authenticated API and unknown/explicit-source UI presentation; no physical-host telemetry claim.
   - Exact selectors/retained receipt paths:
     - `internal/observability/observability_test.go :: TestReplayConflictGapResetAndCycleCrossingCannotFabricateCoverage; TestCycleBoundaryAndBaselineRaceStayExplicit; TestProviderStatementIsIndependentOfNICAndOldOrFutureInputsCannotAlert`
     - `internal/httpapi/node_observations_test.go :: TestNodeResourcesAndProviderAllowanceHaveAuthenticatedEndToEndDataPath`
     - `web/src/observation-footer.dom.test.tsx :: provider observation presentation`

### RW-18 — Diagnose connectivity and notify operators

Stories: K05. Direct prerequisites: RW-15, RW-17, RW-19. Forward status: `verified`.

1. **Target, direction, timestamp and estimated/actual traffic cost are shown; timeouts and error details point to an actionable failure.**
   - Disposition: `supported`.
   - Evidence groups: `diagnostic`.
   - Bounded scope: Bounded locally authorized real-agent transfer and synthetic-HTTP real-browser cancellation context; estimated/actual/unknown costs remain distinct. CI9 verifies actual narrow pixels and two Escape/focus returns.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/diagnostics_test.go :: TestDiagnosticAdminRequestRunsThroughRealAgentAndDurableResult; TestDiagnosticDriverCancellationStopsActualTransfer`
     - `internal/agent/diagnostics_test.go :: TestDiagnosticBoundsRedirectSizeDeadlineAndCancellation`
     - `web/src/Diagnostics.tsx :: job timestamp, target, direction, cost and actionable result rendering`
     - `web/tests/diagnostic-cancel-context.ui.spec.ts :: server diagnostic cancellation retains its target and exact opener at 320px`
2. **Diagnostics cannot target arbitrary internal metadata services or silently send traffic beyond the authorized target.**
   - Disposition: `supported`.
   - Evidence groups: `diagnostic-safety`.
   - Bounded scope: Metadata/private/credential/query/rebound targets rejected, exact authorized local target only, no redirect following; no arbitrary external probe authorization inferred.
   - Exact selectors/retained receipt paths:
     - `internal/agent/diagnostics_test.go :: TestDiagnosticRejectsMetadataCredentialsPrivateAndReboundFixtureTargets; TestBoundedDiagnosticExecutesOnlyLocallyAuthorizedFixture; TestDiagnosticBoundsRedirectSizeDeadlineAndCancellation`
3. **Monitoring thresholds, audience and deduplication are configurable and tested using local sinks.**
   - Disposition: `supported`.
   - Evidence groups: `channels`, `notifications`, `notification-drill`.
   - Bounded scope: Persisted thresholds/audiences/automatic permission and dedup are exercised against local verified TLS mail/webhook contracts, not live third-party delivery.
   - Exact selectors/retained receipt paths:
     - `internal/notifications/acceptance_matrix_test.go :: TestNotificationEventAudienceChannelAcceptanceMatrix; TestNotificationExplicitChannelFailureRetryMatrix`
     - `internal/notifications/service_test.go :: TestThresholdDeduplicationAndNewCycles; TestProviderObservationFreshnessAndExplicitAutomaticPermission`
     - `internal/notifications/transport_test.go :: TestWebhookSignedHTTPSStableEventIDAndRejectedResponse; TestSMTPVerifiedTLSAcceptanceStableMessageIDAndNoPlaintextFallback`
4. **No automatic server failover is added; manual alternate route selection names its changed exit and follows the ordinary revision workflow.**
   - Disposition: `supported`.
   - Evidence groups: `route-exit-browser`, `fleet`.
   - Bounded scope: Browser names Alternative UK and changed endpoint; preview/retarget only, separate apply required. HTTP test proves review/revision/receipt replay/409 and unchanged credentials/accounting/fallback; no automatic failover or invented import button.
   - Exact selectors/retained receipt paths:
     - `web/tests/route-exit-backend.ui.spec.ts :: existing managed route selects stored plain TCP endpoint absent from its programs and saves a real draft`
     - `internal/httpapi/published_route_retarget_test.go :: TestManagedRouteRetargetAddsInventoryExitPreservesFallbackAndReplaysReceipt`

### RW-19 — Publish announcements and audit reminders

Stories: A05. Direct prerequisites: RW-02, RW-03, RW-13. Forward status: `verified`.

1. **Announcements have audience and validity bounds; users see only messages intended for them.**
   - Disposition: `supported`.
   - Evidence groups: `notifications`.
   - Bounded scope: Audience and validity bounds, private read receipts, cross-user isolation through notification service and authorized HTTP.
   - Exact selectors/retained receipt paths:
     - `internal/notifications/service_test.go :: TestAnnouncementAudienceExpiryAndPrivateReadReceipts`
     - `internal/httpapi/notifications_test.go :: TestNotificationHTTPAudienceReadAndSettingsIsolation`
2. **In-app, email and Webhook adapters have bounded local contract tests; explicit configured destinations and permission are required before real external sends.**
   - Disposition: `supported`.
   - Evidence groups: `channels`.
   - Bounded scope: Local in-app/verified TLS adapters and explicit permission; saving channel configuration alone queues no external send. Real destinations require operator configuration/permission and are not claimed exercised.
   - Exact selectors/retained receipt paths:
     - `internal/notifications/transport_test.go :: TestWebhookSignedHTTPSStableEventIDAndRejectedResponse; TestSMTPVerifiedTLSAcceptanceStableMessageIDAndNoPlaintextFallback; TestSMTPSTARTTLSAuthenticatesOnlyAfterVerifiedUpgrade`
     - `internal/notifications/acceptance_matrix_test.go :: TestNotificationEventAudienceChannelAcceptanceMatrix`
     - `internal/httpapi/notifications_test.go :: TestNotificationHTTPAudienceReadAndSettingsIsolation`
3. **Reminder retries do not duplicate the same threshold/cycle notification; changed audience and expiry are rechecked at delivery.**
   - Disposition: `supported`.
   - Evidence groups: `notifications`, `notification-drill`.
   - Bounded scope: Durable event identity, cycle/threshold dedup, bounded restart retries and current audience/expiry rechecks; local sinks only.
   - Exact selectors/retained receipt paths:
     - `internal/notifications/service_test.go :: TestThresholdDeduplicationAndNewCycles; TestDurableOutboxRestartStableIdentityAndBoundedRetries; TestAnnouncementAudienceIsRecheckedBeforeDeliveryAndCanBeRestored; TestAnnouncementEditsRecheckCurrentValidityAndRetainReadReceipt`
     - `internal/notifications/acceptance_matrix_test.go :: TestNotificationExpiredProviderDeliveryChannelMatrix; TestNotificationExternalTerminalFailureMatrix`
4. **Audit covers actor, object, action and effect but excludes passwords, tokens and full private-source URLs.**
   - Disposition: `supported`.
   - Evidence groups: `account`, `tenant`.
   - Bounded scope: Actor/object IDs and outcome-named actions express effect, linked to durable target/receipt; no separate effect-column requirement. Secret reveal is withheld on audit failure; audit and ordinary state omit credentials/private source URLs.
   - Exact selectors/retained receipt paths:
     - `internal/store/records.go :: AuditEvent and Store.Audit`
     - `internal/httpapi/required_audit_test.go :: TestSecretRevealRequiresDurableAudit`
     - `internal/httpapi/notifications_test.go :: TestNotificationHTTPAudienceReadAndSettingsIsolation`
     - `internal/store/identity_lifecycle_test.go :: TestSecurityAuditFailureRollsBackPasswordAndSessionChanges`
     - `internal/store/counter_ingestion_test.go :: TestOperatorBaselineIsAuditedAndDoesNotChargeUnknownInterval`
     - `internal/store/counter_mixed_recovery_test.go :: TestCounterAutomaticRecoveryPreservesPartialOperatorResolution`
     - `internal/httpapi/source_refresh.go :: source-candidate.secret-revealed audit uses source/candidate IDs only`

### RW-20 — Reuse versioned templates and presets

Stories: M01. Direct prerequisites: RW-05, RW-09, RW-11. Forward status: `blocked`.

1. **Independent copies never change when upstream updates; fixed references stay pinned and following references produce a reviewable candidate.**
   - Disposition: `supported`.
   - Evidence groups: `templates`, `template-native`.
   - Bounded scope: Copy remains independent, fixed version pinned, follow update requires exact reviewed candidate; no silent update.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_test.go :: TestTemplatePresetCopyIsIsolatedAndVersionsImmutable; TestPinnedPresetStaysPinnedAndFollowRequiresReviewedCandidate; TestPinnedVersionAdvancesOnlyByExplicitReviewedUpgrade`
2. **Personal edits are preserved under documented conflict precedence; failed compatibility checks retain the previous valid output.**
   - Disposition: `supported`.
   - Evidence groups: `templates`, `template-browser`.
   - Bounded scope: Real local HTTP/browser stale 409 → refreshed review → apply preserves personal overrides and current published feeds until selected publication; incompatible update retains valid fallback.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_test.go :: TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback; TestSwitchingTemplateReferenceModeKeepsPersonalRuntimeAndPrivateBindings`
     - `web/tests/template-follow-backend.ui.spec.ts :: real template follow conflict → review → validate → selected publication at 1440/390`
3. **Shared resources carry provenance and versions but cannot contain owner-private subscription credentials.**
   - Disposition: `supported`.
   - Evidence groups: `templates`, `tenant`.
   - Bounded scope: Immutable version/provenance and owner binding isolation; shared template rejects private URL/token/endpoints and public template views omit owner secrets.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_test.go :: TestSharedTemplateRejectsPrivateShapesAndCrossTenantBindings; TestFollowedProfileCanReviewNewPrivateBindingWithoutPublishingSecrets; TestTemplatePresetCopyIsIsolatedAndVersionsImmutable`
4. **A positive update scenario crosses template/preset selection, candidate preview, native validation and publication without silently changing unrelated profiles.**
   - Disposition: `supported`.
   - Evidence groups: `template-browser`, `template-native`.
   - Bounded scope: Positive actual pinned Mihomo/sing-box parser validates selected rendered artifact and published bytes; real-browser reviewed update and sibling output unchanged. No unrelated profile or unselected feed mutation.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/templates_native_test.go :: TestNativeTemplateFollowedProfileUpdate`
     - `web/tests/template-follow-backend.api.spec.ts :: real mihomo/sing-box template conflict review preserves local overrides and publishes only the selected output`
     - `web/tests/template-follow-backend.ui.spec.ts :: real template follow conflict → review → validate → selected publication at 1440/390`

### RW-21 — Restore encrypted backups safely

Stories: M02. Direct prerequisites: RW-02, RW-12, RW-13, RW-20. Forward status: `blocked`.

1. **Complete backups contain recovery-required secrets only in authenticated encryption; template sharing remains redacted and ordinary subscriptions retain only needed connection credentials.**
   - Disposition: `supported`.
   - Evidence groups: `backup`, `tenant`.
   - Bounded scope: Complete authenticated encrypted recovery container includes required private state; sharing is redacted, ordinary feed retains connection credentials only. No automatic transfer or secret sharing.
   - Exact selectors/retained receipt paths:
     - `internal/backup/backup_test.go :: TestAuthenticatedBackupRejectsWrongPasswordTruncationAndTampering`
     - `internal/store/backup_test.go :: TestBackupFreshRestorePreservesSecretsIdentitiesIndexesCountersAndHistory`
     - `internal/httpapi/templates_test.go :: TestSharedTemplateRejectsPrivateShapesAndCrossTenantBindings`
     - `internal/store/backup_admission_obligations_test.go :: TestEncryptedBackupRestorePreservesOutstandingAdmissionObligation`
2. **Wrong key, truncated data, tampered ciphertext and unsupported schema are rejected before mutation.**
   - Disposition: `supported`.
   - Evidence groups: `backup`, `backup-obligation`.
   - Bounded scope: Wrong key/truncated/tampered/authenticated unsupported schema rejected before publishing restore; bounds and cleanup verified. Uses current guaranteed-corruption fixture, not erased historical flaky mutation.
   - Exact selectors/retained receipt paths:
     - `internal/backup/backup_test.go :: TestAuthenticatedBackupRejectsWrongPasswordTruncationAndTampering; TestBackupValidatesCompleteAuthenticatedPayloadAndBounds`
     - `internal/backup/stream_test.go :: TestStreamingBackupRejectsUnauthenticatedOrMalformedFramesAndCleansStaging`
     - `internal/store/backup_test.go :: TestBackupRejectsInvalidOrOccupiedTargetBeforeMutation`
3. **Restore preserves users, grants, profile revisions, publication links and ledger history; conflict and target overwrite behavior are explicit.**
   - Disposition: `supported`.
   - Evidence groups: `backup`, `backup-browser`, `lossless-history`.
   - Bounded scope: Users/grants/profile revisions/feed-token indexes/usage/audit retained; occupied/symlink target rejects, source unchanged, outstanding admission obligation preserved and replay does not double charge.
   - Exact selectors/retained receipt paths:
     - `internal/store/backup_test.go :: TestBackupFreshRestorePreservesSecretsIdentitiesIndexesCountersAndHistory; TestBackupRejectsInvalidOrOccupiedTargetBeforeMutation`
     - `internal/store/backup_admission_obligations_test.go :: TestEncryptedBackupRestorePreservesOutstandingAdmissionObligation`
     - `internal/backup/stream_test.go :: TestStreamingBackupLedgerGrowthAndCompleteRecovery`
4. **Migration/restore fault injection proves a recoverable prior state and reports verified completion; no automatic third-party upload or secret sharing occurs.**
   - Disposition: `supported`.
   - Evidence groups: `backup`, `backup-obligation`, `operational-recovery`.
   - Bounded scope: Injected SQLite insert/migration failure rolls back or leaves original source unchanged; explicit retry or verified fresh copy succeeds. Local restore only, no third-party upload or activation inferred.
   - Exact selectors/retained receipt paths:
     - `internal/store/backup_test.go :: TestBackupImportRollsBackPartialDatabaseFailure`
     - `internal/store/notification_migration_test.go :: TestLegacyNotificationMigrationFailurePreservesOriginal`
     - `internal/store/notification_migrate_fresh_test.go :: TestOfflineNotificationMigrationPublishesFreshVerifiedCopy; TestOfflineNotificationMigrationFailuresDoNotPublishOrChangeSource`

### RW-22 — Configure and maintain the platform

Stories: M04. Direct prerequisites: RW-02, RW-12, RW-19. Forward status: `blocked`.

1. **Domain changes preview existing-link consequences and require valid explicit values; rejected edits preserve the submitted form and previous effective settings.**
   - Disposition: `supported`.
   - Evidence groups: `origin`, `origin-ui`.
   - Bounded scope: Real backend UI rejects invalid/stale edits without discarding form; shows existing-token consequences and explicit activation review. Local verified TLS fixture only, no DNS/TLS infrastructure changes.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/subscription_origin_test.go :: TestSubscriptionOriginStageIsAdminOnlyAndNeverActivates; TestSubscriptionOriginVerifiedActivationRetainsTokensAndSurvivesFailedReplacement`
     - `web/tests/settings-origin-backend.ui.spec.ts :: E13 real domain draft recovery and reviewed default activation at 1440px/390px`
2. **Notification configuration is separate from send permission; secrets are write-only/explicitly revealable under authorization, not ordinary state fields.**
   - Disposition: `supported`.
   - Evidence groups: `channels`, `origin-ui`.
   - Bounded scope: Channel save != send permission; response/state/audit/outbox omit secrets and explicit privileged reveal needs durable audit. No live-send claim.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/notifications_test.go :: TestNotificationHTTPAudienceReadAndSettingsIsolation`
     - `internal/httpapi/required_audit_test.go :: TestSecretRevealRequiresDurableAudit`
     - `internal/notifications/service_test.go :: TestProviderObservationFreshnessAndExplicitAutomaticPermission`
3. **Saved and effective revision are distinct when activation fails; the visible result reflects observed activation rather than a generic success banner.**
   - Disposition: `supported`.
   - Evidence groups: `origin`, `origin-ui`.
   - Bounded scope: Configured/effective revisions separate; failed replacement preserves previous effective origin, failed status observed; unverified/stale activation denied409 and UI retains draft.
   - Exact selectors/retained receipt paths:
     - `internal/httpapi/subscription_origin_test.go :: TestSubscriptionOriginVerifiedActivationRetainsTokensAndSurvivesFailedReplacement; TestSubscriptionOriginProofExpiresAndConcurrentEditFencesVerification`
     - `web/tests/settings-origin-backend.ui.spec.ts :: E13 real domain draft recovery and reviewed default activation at 1440px/390px`
4. **Settings maintenance works through authorized API/UI without raw database editing or implicit external domain/TLS changes.**
   - Disposition: `supported`.
   - Evidence groups: `origin`, `origin-ui`.
   - Bounded scope: Authorized production API/UI maintenance, no raw DB intervention; example domains are strings in browser harness and actual TLS contract is isolated net.Pipe, not external DNS/certificate deployment.
   - Exact selectors/retained receipt paths:
     - `web/tests/settings-origin-backend.api.spec.ts :: E13 real settings revisions reject invalid/stale drafts and fence activation until explicit default approval`
     - `web/tests/settings-origin-backend.ui.spec.ts :: E13 real domain draft recovery and reviewed default activation at 1440px/390px`
     - `internal/httpapi/subscription_origin_test.go :: TestSubscriptionOriginStageIsAdminOnlyAndNeverActivates; TestSubscriptionOriginVerificationRejectsRedirectsAndInvalidTLS`

### RW-23 — Use the complete service subscription center

Stories: S01, S02. Direct prerequisites: RW-12, RW-13. Forward status: `blocked`.

1. **The main action gets a subscription; service, authorized routes, expiry, actual/weighted usage and next reset are clear without technical IDs dominating the page.**
   - Disposition: `supported`.
   - Evidence groups: `service-ui`, `first-feed-browser`, `cycle-browser`.
   - Bounded scope: Invited own-service browser shows service/routes/expiry/raw+weighted usage/reset and subscription main action; no technical-ID-dominant delivery path.
   - Exact selectors/retained receipt paths:
     - `web/tests/service-center-backend.ui.spec.ts :: E09 invited service center keyboard delivery and selected-link rotation at 1440px/390px`
     - `web/src/service-cycle-defaults.dom.test.tsx :: service cycle defaults`
     - `web/tests/cycle-renewal-backend.ui.spec.ts :: real service cycle renewal modes`
2. **Loading, empty, expired, paused, offline and failed states are distinguished and preserve retry/navigation behavior.**
   - Disposition: `supported`.
   - Evidence groups: `service-ui`, `cycle-ui`.
   - Bounded scope: Actual App DOM state fixtures distinguish loading/empty/expired/paused/offline/failed and preserve retry/navigation/draft ownership; not every negative state required in same browser journey.
   - Exact selectors/retained receipt paths:
     - `web/src/subscription-overview-status.dom.test.tsx :: status table; allows user/admin inventory entry without converting a failed read into empty; gives paused platform service a next step without granting restoration or changing personal subscriptions`
     - `web/src/subscription-relational.dom.test.tsx :: keeps first-use empty, saved draft and search no-match as different states`
     - `web/src/subscription-creation-readiness.dom.test.tsx :: keeps an ordinary checked draft through pending and failed profile reads without repeating inspection; preserves this publication through same-account resume read failure but discards it on account replacement`
3. **A full browser journey uses the real local backend, not only intercepted fixtures: login, view own service, get a subscription, rotate and deny old link.**
   - Disposition: `supported`.
   - Evidence groups: `first-feed-browser`, `rotation-browser`.
   - Bounded scope: Real isolated CLI/backend login → own service → actual feed download → selected rotation → old URL404; siblings/other tenant unchanged, not intercepted-only fixtures.
   - Exact selectors/retained receipt paths:
     - `web/tests/service-center-backend.ui.spec.ts :: E09 invited service center keyboard delivery and selected-link rotation at 1440px/390px`
     - `web/tests/service-center-backend.api.spec.ts :: E09 invited own service and configured grant deliver isolated feeds; rotation denies only old selected URL`
4. **Keyboard-only and narrow mobile layouts complete the main task; no external-provider billing or physical-device identity is inferred.**
   - Disposition: `supported`.
   - Evidence groups: `first-feed-browser`, `rotation-browser`.
   - Bounded scope: Keyboard-only main task at desktop/narrow390; actual trusted clipboard sentinel/copy/paste bytes and screenshot-pixel jsQR equality initial/rotated/reopened URLs. No phone OS, external-provider bill or physical-device identity inferred.
   - Exact selectors/retained receipt paths:
     - `web/tests/service-center-backend.ui.spec.ts :: E09 invited service center keyboard delivery and selected-link rotation at 1440px/390px`
     - `/workspace/scratch/d385eb428cee/checklist-evidence-20261101/browser-41406226333/RECEIPT.md :: all six trusted clipboard and rendered QR checks`

### RW-24 — Verify complete integration and recovery

Stories: F01, F02, F03, F04, F05, C101, C102, C201, C202, C203, C301, C302, C401, C402, C501, C502, C503, C601, C602, S01, S02, A01, A02, A03, A04, A05, K01, K02, K03, K04, K05, M01, M02, M03, M04. Direct prerequisites: RW-01, RW-02, RW-03, RW-04, RW-05, RW-06, RW-07, RW-08, RW-09, RW-10, RW-11, RW-12, RW-13, RW-14, RW-15, RW-16, RW-17, RW-18, RW-19, RW-20, RW-21, RW-22, RW-23. Forward status: `blocked`.

1. **Every confirmed story has positive end-to-end evidence, not just a type, document, disabled button or unsupported diagnostic; evidence is attached to its local ticket.**
   - Disposition: `conditional_on_feature_prerequisites`.
   - Evidence groups: `ALL_STORIES`.
   - Bounded scope: Must be closed only after coordinator accepts every feature clause and attaches source-bound evidence to each local ticket. Green aggregate cannot reverse-close feature prerequisites.
   - Remaining condition: Coordinator forward RW-01–RW-23 adjudications and final ticket evidence attachment are outside this RW-17–RW-24 review. No newly discovered feature defect.
   - Exact selectors/retained receipt paths:
     - `docs/tickets/catalog.json :: unchanged literal acceptance and 35 confirmed story mappings`
     - `docs/verification/TICKET-CLAUSE-ACCEPTANCE-LEDGER-2026-11-02.json :: forward prerequisite layers and per-clause evidence mapping`
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/final-receipt.json :: exact source all18 successful jobs`
2. **Quick, full and native checks report their exact scope and fail on missing requested prerequisites; architecture checker rejects its intentional forbidden fixture.**
   - Disposition: `supported`.
   - Evidence groups: `render-extension`.
   - Bounded scope: Quick/full/native names reflect exact scope; requested prerequisites missing fail. Intentional forbidden import fixtures execute in mandatory static gate. CI9 native execution verified, not merely source presence.
   - Exact selectors/retained receipt paths:
     - `scripts/verify.sh :: named gate dispatch, full prerequisite refusal and explicit scope output`
     - `scripts/native-cores.sh :: pinned prerequisite check and required-passed/skipped rejection`
     - `scripts/test_client_native_gate.py :: test_selected_dns_cases_missing_skipped_or_failed_reject`
     - `scripts/check-architecture/main_test.go :: TestGuardRejectsForbiddenImportAtPublicCommandSeam; TestGuardRejectsUnclassifiedProductionModules`
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/final-receipt.json :: final static/native gates`
3. **Fault cases cover generation fencing/restart, tenant revocation, stale source/template updates, ledger dedup/cycles and backup recovery.**
   - Disposition: `supported`.
   - Evidence groups: `agent-fences`, `tenant`, `source-refresh`, `templates`, `counter`, `calendar`, `backup`.
   - Bounded scope: Named generation/restart/revocation/stale update/dedup/cycle/restore faults executed under exact-source final backend gates; bounded local fault evidence, not WAN or live-VPS resilience.
   - Exact selectors/retained receipt paths:
     - `internal/agent/reconciler_test.go :: TestRestartRetainsFenceAndDoesNotReplay; TestDelayedOldOperationCannotOvertakeCompletedNewGeneration; TestAcceptedRevokedPolicyStopsOldRuntimeInsteadOfReusingLease`
     - `internal/httpapi/source_refresh_test.go :: TestSourceRefreshMaterialCandidateRequiresExactAcceptance; TestSourceCandidateRevealStaleEditDeletionAndInvalidPartial`
     - `internal/httpapi/templates_test.go :: TestPinnedPresetStaysPinnedAndFollowRequiresReviewedCandidate`
     - `internal/store/counter_ingestion_test.go :: TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider; TestCounterCursorDoesNotResetOnBillingCycleChange; TestCounterCalendarAndManualBoundaryNeedExactObservation`
     - `internal/store/backup_test.go :: TestBackupImportRollsBackPartialDatabaseFailure`
4. **Standards and specification reviews are recorded separately; all blocking findings are resolved and affected final checks rerun.**
   - Disposition: `conditional_on_feature_prerequisites`.
   - Evidence groups: `REVIEW_RECEIPTS`.
   - Bounded scope: Separate Standards/Spec delta reviews and CI9 affected-check evidence remain valid for source7a10103, but cannot establish global closure after the subsequently identified RW-07.3 blocker. Any later fix requires its own review and affected final source-bound check evidence; no retroactive clearance from CI9. NET-03 remains a distinct unknown-cause risk disposition.
   - Remaining condition: Coordinator final audit confirmed an existing blocking specification gap in RW-07.3: missing stale profile-save baseline. Therefore the literal all blocking findings resolved and affected final checks rerun condition is not fulfilled until that feature finding is fixed, reviewed and its affected exact-source final checks pass. This is a dependent consequence of RW-07.3, not a second software defect.
   - Exact selectors/retained receipt paths:
     - `/workspace/scratch/d385eb428cee/literal-final-independent-review-20261102/REVIEW.md :: separate Standards and Spec sections`
     - `/workspace/scratch/d385eb428cee/literal-final-independent-review-20261102/receipt.json :: four production blob equality current7a10103, zero concrete findings per axis`
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/monitor/named-native-web-receipt.json :: final2115 web tests and named native rate pass`
     - `/workspace/scratch/d385eb428cee/checklist-evidence-20261101/browser-41406226333/RECEIPT.md :: final diagnostic320, template and clipboard/QR cases`
5. **No claim of GitHub publication, native CI execution, real VPS deployment or production readiness is made without corresponding verified evidence.**
   - Disposition: `supported`.
   - Evidence groups: `SOURCE_BOUND_RECEIPTS`.
   - Bounded scope: Supported claim discipline: exact remote CI evidence and preserved runtime reference only. No main merge, actual deployment target, external trial or production-readiness clearance. NET-03 unknown cause requires release-owner risk disposition, not erased by later passes.
   - Exact selectors/retained receipt paths:
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/final-receipt.json :: remote30906420 and tree9a848d86 terminalall18`
     - `/workspace/scratch/d385eb428cee/ci9-publication-20261102/monitor/named-native-web-receipt.json :: actual named native execution`
     - `docs/verification/FINAL-CAPACITY-REFERENCE-2026-11-02.md :: qualified674 runtime reference and scope`
     - `/workspace/scratch/d385eb428cee/literal-final-soak-risk-20261102/ :: sample410 cause UNKNOWN residual-risk receipt`

## Story-to-feature prerequisite decisions

These are software feature outcomes, not global story completion; RW-24 remains held.

| Story | Feature tickets | Current feature prerequisite status |
|---|---|---|
| F01 | RW-01, RW-15 | Verified |
| F02 | RW-01 | Verified |
| F03 | RW-07, RW-11 | Held: RW-07, RW-11 |
| F04 | RW-04 | Verified |
| F05 | RW-13 | Verified |
| C101 | RW-04 | Verified |
| C102 | RW-06 | Verified |
| C201 | RW-05, RW-06 | Verified |
| C202 | RW-05, RW-06 | Verified |
| C203 | RW-05, RW-06 | Verified |
| C301 | RW-08 | Held: RW-08 |
| C302 | RW-08 | Held: RW-08 |
| C401 | RW-09 | Held: RW-09 |
| C402 | RW-09 | Held: RW-09 |
| C501 | RW-07 | Held: RW-07 |
| C502 | RW-10 | Held: RW-10 |
| C503 | RW-10 | Held: RW-10 |
| C601 | RW-11 | Held: RW-11 |
| C602 | RW-12 | Held: RW-12 |
| S01 | RW-03, RW-23 | Held: RW-23 |
| S02 | RW-13, RW-23 | Held: RW-23 |
| A01 | RW-02 | Verified |
| A02 | RW-03 | Verified |
| A03 | RW-13 | Verified |
| A04 | RW-14 | Verified |
| A05 | RW-19 | Verified |
| K01 | RW-16 | Verified |
| K02 | RW-01 | Verified |
| K03 | RW-15 | Verified |
| K04 | RW-17 | Verified |
| K05 | RW-18 | Verified |
| M01 | RW-20 | Held: RW-20 |
| M02 | RW-21 | Held: RW-21 |
| M03 | RW-02 | Verified |
| M04 | RW-22 | Held: RW-22 |

## Historical mapping and actual rollout boundary

The JSON retains earlier CI7/CI8, preparation snapshots, historical work IDs and
supplemental source hashes as history. Historical pending labels do not schedule
already completed work again. Current dispositions are `final_clause_review` and
the source-bound CI9 record. No original criterion, dependency or failure is erased.

Actual one-CP/Linux/private-invitation target selection, client/network/workload
envelope, key/backup custody, RPO/RTO, TLS/notification destinations and explicit
main/deploy authorization are external acceptance inputs, not new software features.
The original sample410 timeout remains UNKNOWN. A later passing reference window
does not determine its cause; NET-03 owner risk disposition remains pending.
