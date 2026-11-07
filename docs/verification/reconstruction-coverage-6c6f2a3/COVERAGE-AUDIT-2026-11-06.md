# RouteWeaver reconstruction coverage audit: composed 6c6f2a3

Date: 2026-11-06. Audited application source: `6c6f2a33a6381e0badbfb8eeab9ba6a191cf3314`. Tree: `505310c3660ead99006313c995aaf16d00f483fd`. Recovered baseline: `a1fbbc301378e47489660791e68f8c50fcf2b93f`. Prior audit: `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`.

## Conclusion

The previously missing bounded collection-preview, invitation-expiry, rule-import, enrollment-lifecycle, hidden uncertain-exit navigation and native-contract documentation changes are now present in the actual composed Git source. This closes the earlier explicit source omissions, **not** historical recovery or product acceptance.

The 49-record map now contains **42 source-reconstructed records, 3 partial, 3 aggregate-only and 1 uncertain**. Those 42 records are not a derivation or verification of the reported 42 bounded UI scopes: checkpoints overlap features, v128 is documentation-only, and v134 combines feature and aggregate history. Do not equate either count with recovered commits, passing tests or whole-product coverage.

- v89 remains **partial**: Inbox retry is reconstructed; Fleet uncertain creation/backend contract is not.
- v102 remains **partial**: bounded account-security recovery excludes MFA unknown-enable/shared ownership and full session integration.
- v134 remains **partial**: rate-boundary source exists, but the historical aggregate/receipt is unavailable.
- v103/v106/v119 remain **aggregate-only**: their historical execution/repair evidence cannot be recreated by naming adjacent source changes.
- v97 remains **uncertain**: the opaque “route-check fixes” summary still lacks a sufficiently specific acceptance contract. Later route/diagnostic work cannot prove parity.

All 49 original primary objects remain **NOT RECOVERED**. Target `ad1577e4a4d23f16e02c16daa2ac2cc75c140e55` and its reported 3,127-test evidence remain unavailable. All application tests, types, builds, browser, native and backend checks are **UNRUN** for this audit/source. No release acceptance is established.

## Method, preservation and documentation boundary

Read the exact Git diff from `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0` to `6c6f2a33a6381e0badbfb8eeab9ba6a191cf3314`, all six new reconstruction notes, changed production files and relevant new regression sources. Checked native-contract wording against existing `internal/httpapi/output_review.go` and `outputs.go`. Reused unchanged earlier semantic mappings after confirming the new changed-file set; rechecked their partial/aggregate/uncertain limits. All 49 source/document references were resolved against the pinned Git tree.

Collection preview lives in **`web/src/CollectionPreview.tsx`**, not Pipeline.tsx. This corrects the prior audit’s intended-file reference for missing v94/v95 while preserving the original audit untouched. Rule import is specifically RuleFileImport.tsx/api.ts, not source-file import or profile numeric editing.

No backend/runtime source changed from v88 to this commit (`internal/` and `runtimes/` diff is empty). New documentation describes existing backend behavior; it is not a backend fix. The inherited status/execution-plan at this exact commit still describe 37 scopes and pending work. Their later worktree edits are excluded. This audit derives new coverage from the pinned product source and reconstruction notes, not that stale count.

The four new candidate receipt files record complete-history, byte-identical independent restores for collection, invitation, rule import, native documentation, enrollment and uncertain-exit navigation. These are recorded storage results, not runtime verification; this audit did not repeat their restores.

The consolidated receipt snapshot read for this corrected audit has SHA-256 `06ae9d16039103f402d7a1ae4a3507e1ba90c7ff74364d8f9da960ad5830b134`. It records integration bundle version **14**, commit `10755d16bf90817b4734a6d1b1fec7d22fdf37ad`, tree `bef801a6e2c469a8716c46178a020b572837346a`, and bundle SHA-256 `d46fb39d088804e8f90b9a40be4ce7fc9284bfd2fe7c48cabc107a40b7c999eb`. Its recorded checks report byte-identical readback, complete-history bundle verification, successful empty-repository restore, fsck, clean checkout and diff check. These storage checks were **recorded by the preservation process, not rerun by this audit**; application verification remains UNRUN.

This audit remains pinned to application source `6c6f2a33a6381e0badbfb8eeab9ba6a191cf3314`. A direct Git comparison with saved `10755d16bf90817b4734a6d1b1fec7d22fdf37ad` confirms exactly two changed files: `docs/verification/RECONSTRUCTION-EXECUTION-PLAN-2026-11-06.md` and `docs/verification/RECONSTRUCTION-STATUS-2026-11-06.md`. Application source is therefore identical, while the complete Git trees differ. The earlier statement that the captured consolidated receipt still identified `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0` was stale and is corrected here. `AUDIT-RECEIPT.json` distinguishes the exact inspected product source from this later recorded storage checkpoint.

Only Git/Python/text inspection and writing this new audit directory occurred. No application execution, Node/npm/Go/gofmt, install, network, browser, server, native core, upload, push, deployment or live account action. The previous `coverage-audit/` files remain byte-for-byte unchanged.

## Material source changes confirmed

1. Collection stage identity includes collection/scope/source/step; removed selection resets rather than resurrects. Removed focused tabs request final-tab focus and nearest reveal without stealing outside focus. Malformed duplicate identities and actual browser focus/scroll remain outside verification.
2. Invitation expiry retains raw text, initial 72, explicit blank-to-server-24 default and exact 1–168 integer intent; a local spinbutton adapter preserves bounded arrows without silently repairing invalid text.
3. Rule import owns abortable file preparation, preserves recoverable selection intent, and checks owner lifetime after asynchronous session authority immediately before dispatch. Its server opened-revision gap remains open.
4. Enrollment uses keyed task ownership, a synchronous duplicate latch, pending close guard, task-local token display and specific departure warnings. Manual retry after an uncertain error can still rotate credentials; lost-token/idempotency recovery is absent.
5. Exit unresolved saving/uncertainty remains guarded when hidden. Navigation combines custom consequences and ordinary drafts; it does not persist recovery or guarantee users remain on the page.
6. Native-output documentation now matches optional reviewed creation and legacy omission, while explicitly denying ID reservation and replay-success semantics. It cites existing owner receipt/CAS behavior, not a new implementation.

## Checkpoint-by-checkpoint mapping

Paths below are relative to `integration-source/` and resolved from the pinned Git tree. Every row’s application verification is **UNRUN** and original object status **NOT RECOVERED**.

### v89: local fixes and two pending decisions

- Historical primary commit: `efff8d332921972785ba03463cb1ed5375981939`.
- Classification: **partial**.
- Bounded replacement or intended scope: Inbox retry ownership.
- Source references: `web/src/Notifications.tsx`; `web/src/inbox-read-state.dom.test.tsx`.
- Evidence note: `docs/verification/INBOX-INSTANCE-SOURCE-RECOVERY-2026-11-06.md`.
- Remaining gap: Inbox retry has a bounded replacement. The separately reported Fleet uncertain-create WIP/backend contract is absent and must not be inferred from Fleet numeric work.

### v90: rate draft fix preserved locally

- Historical primary commit: `0542c3d153b6d3a66ebecb1083bacc1e89217ea3`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Rate partial numeric drafts.
- Source references: `web/src/Rates.tsx`; `web/src/rate-factor-precision.dom.test.tsx`.
- Evidence note: `docs/verification/RATE-FACTOR-PRECISION-2026-11-06.md`.
- Remaining gap: No historical source equivalence; focus and actual browser input remain unverified.

### v91: backup inspection fixes preserved locally

- Historical primary commit: `f46f657a923c71db50152563f7689a2a7e3cdbee`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Backup inspection revision ownership and stale preview retirement.
- Source references: `web/src/Backup.tsx`; `web/src/backup-restore-outcomes.dom.test.tsx`.
- Evidence note: `docs/verification/BACKUP-INSPECTION-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Restore uncertainty, real archives and native file selection remain outside this bounded change.

### v92: template lifecycle fixes preserved locally

- Historical primary commit: `a9d248736b9ff25738eeefad7ba17d1c1e75ed1e`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Template extraction/publication exclusion and error retirement.
- Source references: `web/src/Templates.tsx`; `web/src/template-task-lifecycle.dom.test.tsx`.
- Evidence note: `docs/verification/TEMPLATE-LIFECYCLE-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Publication unknown outcome is not repaired.

### v93: MFA cancellation fix preserved locally

- Historical primary commit: `08f9e5c434a18eb14a109d4cad43f51a4093a992`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Local MFA setup dismissal cleanup.
- Source references: `web/src/Security.tsx`; `web/src/mfa-setup-dismissal.dom.test.tsx`.
- Evidence note: `docs/verification/MFA-SETUP-DISMISSAL-SOURCE-2026-11-06.md`.
- Remaining gap: Does not cover unknown MFA enable, shared write ownership, validated success or real authentication.

### v94: collection preview selection fix preserved locally

- Historical primary commit: `8159df2bd164e7c76e099b4366c5f92b2c8be7b6`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Collection preview stable selected-stage identity.
- Source references: `web/src/CollectionPreview.tsx`; `web/src/collection-preview-layout.dom.test.tsx`.
- Evidence note: `docs/verification/COLLECTION-PREVIEW-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Selection uses collection/scope/source/step identity rather than position. Missing selection resets to final without resurrection. Duplicate malformed stage tuples are not repaired. Actual tab keyboard/focus/rendering remains UNRUN. The prior audit intended-path reference to Pipeline.tsx is corrected here; Pipeline numeric work is distinct.

### v95: collection focus reveal follow-up preserved

- Historical primary commit: `ecbde0b3e9cdc7e0dafca1cb1c83fc5060d360ad`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Owned removed-tab focus and nearest-edge reveal.
- Source references: `web/src/CollectionPreview.tsx`; `web/src/collection-preview-layout.dom.test.tsx`.
- Evidence note: `docs/verification/COLLECTION-PREVIEW-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Ref-detach ownership and layout effect request final-tab focus/nearest scroll only for a removed focused tab, preserving editor focus elsewhere. Native focus/scroll and Radix behavior remain UNRUN; a scroll spy is not rendered browser evidence.

### v96: uncertain domain activation recovery preserved

- Historical primary commit: `0000e88d640f8a8566da289f75e0f328ee7d15f2`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Unknown domain activation with validated read and renewed review.
- Source references: `web/src/SubscriptionOriginSettings.tsx`; `web/src/subscription-origin.dom.test.tsx`.
- Evidence note: `docs/verification/DOMAIN-ACTIVATION-RECOVERY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Save/verify uncertainty remains ordinary handling. Reads do not establish historical operation receipts or DNS/TLS uptime.

### v97: serialized aggregate and profile draft investigation

- Historical primary commit: `315858e7a3cfdec835b4e8f1fb7e0b2946c16bf6`.
- Classification: **uncertain**.
- Bounded replacement or intended scope: Unspecified route-check fixes; profile draft investigation.
- Source references: `web/src/Diagnostics.tsx`; `web/src/Profiles.tsx`.
- Evidence note: `docs/verification/RECONSTRUCTION-STATUS-2026-11-06.md`.
- Remaining gap: Historical summary gives no route-check acceptance contract or file identity. Later diagnostic request recovery, effective-route selection and profile numeric work cannot prove these opaque fixes were recreated. Aggregate was initially in progress; its historical later result does not transfer.

### v98: proxy/DNS numeric draft fix reproduced and preserved

- Historical primary commit: `d2001d7f359f79ef4fd45fa9915e1701cf87f313`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Profile mixed/DNS port draft intent.
- Source references: `web/src/Profiles.tsx`; `web/src/profile-runtime-numeric.dom.test.tsx`.
- Evidence note: `docs/verification/PROFILE-RUNTIME-NUMERIC-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Only bounded mixed/DNS numeric behavior; group and pipeline are independently mapped below.

### v99: group interval draft fix preserved

- Historical primary commit: `388e443709d311d84f8e7eefb01f0a062c38364e`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Existing and create/use group interval intent.
- Source references: `web/src/Profiles.tsx`; `web/src/group-interval-intent.dom.test.tsx`.
- Evidence note: `docs/verification/GROUP-INTERVAL-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Repeated focus, discard and JSON replacement are authored regression source, not observed behavior.

### v100: original numeric inventory locally addressed

- Historical primary commit: `4c6752400d6b866e4ee150e21a966beaea38d072`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Collection per-source/aggregate processing ports.
- Source references: `web/src/Pipeline.tsx`; `web/src/pipeline-port-intent.dom.test.tsx`.
- Evidence note: `docs/verification/PIPELINE-PORT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Historical inventory also includes v98/v99; this is not a third recovery of those commits or evidence of all numeric editors.

### v101: diagnostic recovery integrated; aggregate underway

- Historical primary commit: `d1dae3d3c7f54b5b3183dc5815661dc0dd32437b`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Actor-bound diagnostic request recovery.
- Source references: `web/src/useDiagnosticRequest.ts`; `web/src/Diagnostics.tsx`; `web/src/diagnostic-request-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/DIAGNOSTIC-REQUEST-RECOVERY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: 404 stays unknown. New valid-record abandonment is an explicit design addition, not proven historical parity; can allow duplicate traffic. Same-tab reload and real request receipt behavior unverified.

### v102: account-security uncertainty recovery preserved

- Historical primary commit: `3fb249de1815f7e9a1f3e7f9841eb271dbbdaaa6`.
- Classification: **partial**.
- Bounded replacement or intended scope: Account-security nonsecret reminder and read-only recovery.
- Source references: `web/src/AccountSecurity.tsx`; `web/src/account-security.dom.test.tsx`.
- Evidence note: `docs/verification/ACCOUNT-SECURITY-UNCERTAINTY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: No MFA enrollment recovery/shared owner, historical operation receipt, invalid-store repair or full same-actor transport rotation verification. Lost cookie response can still require manual login.

### v103: service-policy aggregate passed; TLS draft investigation

- Historical primary commit: `e206c0341f7add5d14a8a4be93027175550b1142`.
- Classification: **aggregate-only**.
- Bounded replacement or intended scope: Historical service-policy aggregate and TLS investigation.
- Source references: `web/src/ServicePolicyEditor.tsx`; `web/src/service-quota-input.ts`.
- Evidence note: `docs/verification/SERVICE-QUOTA-PRECISION-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Summary reports aggregate plus unfixed TLS investigation, not an exact service-policy patch contract. Current service-quota scope is independently new; 2,484 historical tests and missing receipt are not recovered.

### v104: TLS import fix integrated; aggregate running

- Historical primary commit: `977c3e3e167997b12329f0406b303168f75c5de0`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: TLS delayed-read ownership and pending-save guard.
- Source references: `web/src/TLSMaterial.tsx`; `web/src/server-tls-editor.dom.test.tsx`.
- Evidence note: `docs/verification/TLS-READ-OWNERSHIP-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Native PEM picker, actual TLS and durable backend receipt recovery remain unverified/absent.

### v105: source-file import fix integrated; aggregate underway

- Historical primary commit: `868e7d1b2c8d0bf6c47f86046e9286145d7ba8cc`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Source file pending/failed draft ownership.
- Source references: `web/src/SourceEditorDialog.tsx`; `web/src/source-editor.dom.test.tsx`.
- Evidence note: `docs/verification/SOURCE-FILE-RECOVERY-2026-11-06.md`.
- Remaining gap: Cancellation retires UI read ownership, not physical disk IO. Actual native file retry remains unrun.

### v106: repaired source-import aggregate passed

- Historical primary commit: `11c762d2468c7d7ca32c9257a2adc2b89bdf8579`.
- Classification: **aggregate-only**.
- Bounded replacement or intended scope: Historical repaired source-import aggregate.
- Source references: `web/src/source-editor.dom.test.tsx`.
- Evidence note: `docs/verification/SOURCE-FILE-RECOVERY-2026-11-06.md`.
- Remaining gap: Exact historical failure/repair diff and 2,520-test receipt are unavailable. Current source-file scope is mapped at v105, not a recovered aggregate.

### v107: fixed-UTC+8 policy date repair integrated

- Historical primary commit: `e7f0714fcc0695df9417e0c495b1c4b76e2741dd`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Fixed UTC+8 date carriers and unchanged timestamp.
- Source references: `web/src/PolicyDateInput.tsx`; `web/src/policy-calendar.dom.test.tsx`.
- Evidence note: `docs/recovery/POLICY-DATE-RECONSTRUCTION-20261106.md`.
- Remaining gap: Locked DayPicker timezone integration and New York/Lord Howe/UTC execution remain unrun.

### v108: effective-policy route fix integrated

- Historical primary commit: `dc1ca855e49f4391d3adba72c8ae371cccb8976a`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Validated effective-policy route choices.
- Source references: `web/src/UserEntries.tsx`; `web/src/user-entry-effective-routes.dom.test.tsx`.
- Evidence note: `docs/verification/EFFECTIVE-ROUTE-CHOICE-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Catalog omission/read failure/deny-all distinctions have source coverage only; backend authorization remains separate.

### v109: rate and user-policy precision fixes preserved

- Historical primary commit: `23e8eb918f75c09fdff2354e71cef7096f7924f8`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Rate factor and six scaled UserPolicy callbacks.
- Source references: `web/src/Rates.tsx`; `web/src/UserPolicyEditor.tsx`; `web/src/policy-entitlement-edit-intent.dom.test.tsx`.
- Evidence note: `docs/verification/USER-POLICY-PRECISION-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Not all 19 NumericInput/two ByteQuantityInput inventory entries. Billing arithmetic unchanged; unsafe Admin/full-write contract remains separate.

### v110: resource numeric/inspection intent fix integrated

- Historical primary commit: `940693bf23fa58d56b41b9e51d8d21af60636f05`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Resource exact numeric drafts and inspection ownership.
- Source references: `web/src/Resources.tsx`; `web/src/resource-numeric-inspection.dom.test.tsx`.
- Evidence note: `docs/verification/resource-inspection-reconstruction-2026-11-06/README.md`.
- Remaining gap: Malformed inspection response schema remains unvalidated; browser/real backend unrun.

### v111: Admin quota protection integrated; contract gap remains

- Historical primary commit: `09b9ef578c6c6d144584cfc40b9db4615461cc1c`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Admin exact quota and unsafe full-PUT guard.
- Source references: `web/src/Admin.tsx`; `web/src/admin-task-lifecycle.dom.test.tsx`.
- Evidence note: `docs/verification/ADMIN-QUOTA-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Protective block, not exact-int64 transport or concurrent full-write solution; unrelated changes with unsafe quota are blocked.

### v112: Profile/Pipeline exact raw numeric fix integrated

- Historical primary commit: `08289e07c09cb490902fd5edf6f80159454a1f77`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Exact raw profile/pipeline numeric tails.
- Source references: `web/src/Profiles.tsx`; `web/src/Pipeline.tsx`; `web/src/profile-runtime-numeric.dom.test.tsx`; `web/src/pipeline-port-intent.dom.test.tsx`.
- Evidence note: `docs/verification/PROFILE-RUNTIME-NUMERIC-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Overlaps v98–100, not independent feature count. Optional empty/unchanged zero preservation and model retention require fresh execution.

### v113: connection port intent fix integrated; aggregate running

- Historical primary commit: `f3c9a671c86f1f872ad70d9982c1be6122395f8e`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Shared connection-port raw intent.
- Source references: `web/src/ConnectionFields.tsx`; `web/src/connection-fields.dom.test.tsx`; `web/tests/connection-port-entry.ui.spec.ts`.
- Evidence note: `docs/recovery/CONNECTION-PORT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Three-host dirty/reset/impact-review journeys are unrun; test source is not browser evidence.

### v114: notification/invitation scalar fix preserved

- Historical primary commit: `0b4c5e054f69b51eabe9c7517ec04391cfb37ada`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Notification repeat/SMTP raw fields and invitation expiry intent.
- Source references: `web/src/Notifications.tsx`; `web/src/notification-channel-draft.dom.test.tsx`; `web/src/Admin.tsx`; `web/src/invite-task-lifecycle.dom.test.tsx`.
- Evidence note: `docs/verification/INVITATION-EXPIRY-INTENT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Notification coverage remains in NOTIFICATION-NUMERIC-RECONSTRUCTION-2026-11-06.md. Invitation initial 72 is preserved; blank omits the field for backend default 24. Exact positive integer bounds and keyboard stepping are source-covered. Native numeric behavior/accessibility and ambiguous invitation-creation outcomes remain separate.

### v115: threshold token validation integrated; aggregate underway

- Historical primary commit: `11c8d7930d1435e4f6d9567bc527aa1ca8f89551`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Notification exact threshold tokens/count/order.
- Source references: `web/src/Notifications.tsx`; `web/src/notification-channel-draft.dom.test.tsx`.
- Evidence note: `docs/verification/NOTIFICATION-NUMERIC-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Uncommitted combobox search text is excluded. Full aggregate and browser editing remain unrun.

### v116: bundle access/rotation fix integrated locally

- Historical primary commit: `93a0f73bc2456fba3234b37ad1e1a0efd93bc20b`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Token bundle downloads and rotation wording.
- Source references: `web/src/Subscriptions.tsx`; `web/src/bundle-access-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/BUNDLE-ACCESS-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Actual ZIP save, live auth and native client import unverified; unchanged output need not be reimported solely for token rotation.

### v117: rule-import recovery integrated; aggregate running

- Historical primary commit: `7b12232fabf5eff0bb9e7825a6767b89ece00ce6`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Rule import selection/read recovery and lifetime fencing.
- Source references: `web/src/RuleFileImport.tsx`; `web/src/api.ts`; `web/src/rule-import-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/RULE-IMPORT-RECOVERY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Abortable reads, failed/invalid dirty selection, same-file retry, canceled picker retention and owner recheck after session wait are present. Original summary is too sparse for exact parity. Opened-revision conditional writes remain absent; already dispatched writes cannot be recalled. Real HTTPS/auth/file-picker/session integration UNRUN.

### v118: template endpoint catalog fix integrated

- Historical primary commit: `52e287641ec0687408b371324b7b13766b28f50f`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Processed template endpoint catalog and grant observations.
- Source references: `web/src/Templates.tsx`; `web/src/template-selection-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/TEMPLATE-ENDPOINT-CATALOG-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Separate reads are not atomic permission proof. No raw-candidate fallback; exact historical fixtures unavailable.

### v119: corrected template aggregate passed; Fleet baseline active

- Historical primary commit: `772dae15d060c09b4861dddcac58ebc86c7c08a6`.
- Classification: **aggregate-only**.
- Bounded replacement or intended scope: Historical corrected template fixture aggregate.
- Source references: `web/src/template-selection-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/TEMPLATE-ENDPOINT-CATALOG-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Original failed result and 2,847-test corrected receipt are historical only. Fleet tests then had no reported result; do not mark Fleet complete from this checkpoint.

### v120: Fleet numeric intent fix integrated; aggregate underway

- Historical primary commit: `592fee4ecc33a7d9c0ea65b7672fdedcf594175c`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Fleet lease/stage numeric intent.
- Source references: `web/src/Fleet.tsx`; `web/src/fleet-numeric-intent.dom.test.tsx`.
- Evidence note: `docs/recovery/FLEET-NUMERIC-INTENT-2026-11-06.md`.
- Remaining gap: Does not repair Fleet uncertain creation or its missing backend contract.

### v121: publication lease intent fix integrated; aggregate underway

- Historical primary commit: `7d4157791f77e98393fbe2ec0a60234a9ce18ac7`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Direct-publication lease intent.
- Source references: `web/src/ServerRoutes.tsx`; `web/src/publication-lease-intent.dom.test.tsx`.
- Evidence note: `docs/recovery/PUBLICATION-LEASE-INTENT-2026-11-06.md`.
- Remaining gap: Does not repair backend publication/lease contracts. Historical 2,894 belongs to its original commit, not this branch.

### v122: public-route port intent fix integrated; aggregate running

- Historical primary commit: `073df2fe9eb37af5580226fff12cd5d4bb0d87c8`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Published route client-port intent.
- Source references: `web/src/PublishedRoutes.tsx`; `web/src/published-route-port-intent.dom.test.tsx`.
- Evidence note: `docs/recovery/PUBLISHED-ROUTE-PORT-INTENT-2026-11-06.md`.
- Remaining gap: Backend publication enforcement and actual client output unverified; no historical aggregate count carries forward.

### v123: provider allowance unit-intent fix integrated

- Historical primary commit: `c2754865dd24983c00648e912c16488c96d17f82`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Provider exact allowance units and safe-byte cap.
- Source references: `web/src/ObservationForms.tsx`; `web/src/observation-footer.dom.test.tsx`.
- Evidence note: `docs/verification/PROVIDER-ALLOWANCE-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Provider revision backend WIP is not implemented. Native wheel/locale/spinner parity is unverified.

### v124: diagnostic numeric intent fix integrated

- Historical primary commit: `a8f8e0562ddab32452b889fbf8f04a464a9af658`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Diagnostic exact numeric limits.
- Source references: `web/src/Diagnostics.tsx`; `web/src/diagnostic-numeric-intent.dom.test.tsx`.
- Evidence note: `docs/verification/DIAGNOSTIC-NUMERIC-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Does not prove live traffic or server enforcement. Must compose with request recovery, ownership and abandonment checks.

### v125: pending enrollment lifecycle fix integrated

- Historical primary commit: `ec2baea5dec5fb553f8050963a2d5e0293d7f283`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Bounded pending agent enrollment lifecycle.
- Source references: `web/src/Infrastructure.tsx`; `web/src/infrastructure-creation.dom.test.tsx`; `web/src/navigation.ts`.
- Evidence note: `docs/verification/ENROLLMENT-PENDING-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Keyed mounted task, layout ownership, submit latch, pending Cancel guard and departure/token-loss warnings are present. Lost-response/forced-departure token recovery and backend idempotency remain UNSOLVED. Errors permit manual retry that may rotate credentials again; no durable/cross-tab operation lock or runtime acceptance.

### v126: exit TLS pending-review fix integrated

- Historical primary commit: `a341c1430d43883a6d79390082b8f8b2333c9280`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Exit TLS pending preview and paired material preservation.
- Source references: `web/src/RouteExitEditor.tsx`; `web/src/TLSMaterial.tsx`; `web/src/route-exit-editor.dom.test.tsx`.
- Evidence note: `docs/verification/TLS-READ-OWNERSHIP-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Frozen uncertain retry remains in-memory; TLS-bearing requests must not be persisted. Hidden unresolved exit navigation is v127, not this fix.

### v127: uncertain-exit navigation warning integrated

- Historical primary commit: `7b1e02422e920207f8bb09cda9cc18a64929957a`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Hidden unresolved-exit navigation and combined departure warnings.
- Source references: `web/src/RouteExitEditor.tsx`; `web/src/navigation.ts`; `web/src/App.tsx`; `web/src/navigation.dom.test.tsx`; `web/src/workspace-shell.dom.test.tsx`.
- Evidence note: `docs/verification/UNCERTAIN-EXIT-NAVIGATION-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Saving/uncertain state guards navigation independently of open; distinct custom and ordinary-draft consequences are combined. Browser-native prompts can be suppressed. Page unmount/reload loses memory-only recovery; metadata-only GET receipt recovery remains absent. No secrets persisted; actual navigation acceptance UNRUN.

### v128: native-client review contract documentation clarified

- Historical primary commit: `6d3db6a1c994f792a44952bdb75c17ae4403f923`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Optional reviewed new-output creation documentation.
- Source references: `docs/design/native-client-overrides.md`; `internal/httpapi/output_review.go`; `internal/httpapi/outputs.go`; `web/src/BasicRouting.tsx`; `web/src/Subscriptions.tsx`.
- Evidence note: `docs/verification/NATIVE-OUTPUT-CONTRACT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Documentation now distinguishes optional frozen review from legacy digest omission, rejects empty/mismatched digest fallback, and explicitly denies ID reservation/idempotent creation. Existing API source supports this wording; no new backend fix or native execution result. Exact historical prose remains unrecovered.

### v129: subscription rotation uncertainty guard integrated

- Historical primary commit: `e250a9623a86d1de8661dc065e474a1dae1ace5d`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Subscription rotation unknown-outcome guard.
- Source references: `web/src/Subscriptions.tsx`; `web/src/subscription-rotation-state.ts`; `web/src/subscription-rotation-uncertainty.dom.test.tsx`.
- Evidence note: `docs/verification/SUBSCRIPTION-ROTATION-UNCERTAINTY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Same-account remount memory only; full reload/new epoch loses reminder. Matching metadata and current access GET are not durable historical receipt.

### v130: policy partial-audit UI fix integrated

- Historical primary commit: `f9729fcf77f61dc891fd254750c457e0b46fbcf4`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Exact policy-committed/audit-missing response handling.
- Source references: `web/src/AccessPolicy.tsx`; `web/src/policy-partial-audit.dom.test.tsx`.
- Evidence note: `docs/verification/POLICY-PARTIAL-AUDIT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Only exact structured HTTP 500 detail classifies commit. Generic uncertainty, guarded editor conflict/rebase acceptance and backend atomicity unresolved.

### v131: inbox freshness fix integrated; aggregate underway

- Historical primary commit: `4a7d4b1a91c4f2b5ec06be35b7b0badd5884d379`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Inbox freshness and explicit refreshed acknowledgment.
- Source references: `web/src/Notifications.tsx`; `web/src/inbox-read-state.dom.test.tsx`.
- Evidence note: `docs/verification/INBOX-INSTANCE-SOURCE-RECOVERY-2026-11-06.md`.
- Remaining gap: Per-event concurrent failure ownership is new source only. Actual fresh server reads and acknowledgment must be verified.

### v132: instance observation polling fix integrated

- Historical primary commit: `9d814da1fed4c1f6477edb03fcedadb4655b3fac`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Continued instance observation polling.
- Source references: `web/src/Infrastructure.tsx`; `web/src/fleet-continuous-service.dom.test.tsx`.
- Evidence note: `docs/verification/INBOX-INSTANCE-SOURCE-RECOVERY-2026-11-06.md`.
- Remaining gap: Cached platform record is not node online status or current enforcement. Browser focus and polling timing unrun.

### v133: invite onboarding uncertainty safeguard integrated

- Historical primary commit: `579cdbd3f6d629296d0fc9be6fdcb0d786d72a39`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Invite onboarding unknown creation warning.
- Source references: `web/src/App.tsx`; `web/src/invite-uncertainty.dom.test.tsx`.
- Evidence note: `docs/verification/INVITE-UNCERTAINTY-SOURCE-2026-11-06.md`.
- Remaining gap: Mode-local reminder only; no durable operation receipt or prohibition on manual resubmission. Fresh login/auth-me and transport/session integration unverified.

### v134: recovered full frontend aggregate passed

- Historical primary commit: `c6f41f644349af9ffaded4b22868ed88d7cd1499`.
- Classification: **partial**.
- Bounded replacement or intended scope: Rate pending-boundary timer plus historical aggregate.
- Source references: `web/src/Rates.tsx`; `web/src/rate-pending-boundary.dom.test.tsx`.
- Evidence note: `docs/verification/RATE-BOUNDARY-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Timer has a new source reconstruction; 3,100-test historical recovered aggregate has not been recreated. Local clock label is not enforcement; wall-clock jumps/browser throttling remain unverified.

### v135: managed-entry stop warning fix integrated

- Historical primary commit: `6d76dd3ad693885283243cebcfa89f71ce9d0546`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Managed-entry stop consequences.
- Source references: `web/src/UserEntries.tsx`; `web/src/rotation-recovery.dom.test.tsx`.
- Evidence note: `docs/verification/LIFECYCLE-WARNINGS-SOURCE-2026-11-06.md`.
- Remaining gap: Warning source is present. Historical summary is terse; scope inferred with current reconstruction note. Admission/renewal/expiry runtime consequences still need independent execution.

### v136: DNS recovery

- Historical primary commit: `b7f3aa9bd04cbd1765178af86234a5cd09b4aff6`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Missing DNS resolver explicit repair and malformed rows.
- Source references: `web/src/Profiles.tsx`; `web/src/profile-content-hierarchy.dom.test.tsx`.
- Evidence note: `docs/verification/DNS-DEFAULT-RECONSTRUCTION-2026-11-06.md`.
- Remaining gap: Allows invalid draft without silent fallback. Real DNS, malformed rows, focus and composed numeric-editor journeys unrun; 3,122 historical tests are not current evidence.

### v137: Account lifecycle warning

- Historical primary commit: `ad1577e4a4d23f16e02c16daa2ac2cc75c140e55`.
- Classification: **source-reconstructed**.
- Bounded replacement or intended scope: Account disable/retire managed-flow warning.
- Source references: `web/src/AccountSecurity.tsx`; `web/src/account-security.dom.test.tsx`.
- Evidence note: `docs/verification/LIFECYCLE-WARNINGS-SOURCE-2026-11-06.md`.
- Remaining gap: No instant-disconnection claim. Target ad1577e and 3,127-test receipt remain unavailable; source warning does not establish deployed enforcement or product acceptance.

## Outstanding backend, session and acceptance inventory

These gaps remain open after the bounded UI candidates have been composed. No backend source changed between v88 and the audited commit. No severity or exploitability claim below is based on a current runtime reproduction.

### Backend and product contracts

1. **Future quota anchors.** Active entitlement can precede its accounting anchor, while usage projection excludes earlier observations. Regrant after settlement is a source-level hypothesis, not a demonstrated exploit. Decide pre-anchor accounting/access semantics, finite versus unlimited and zero-rate controls, migration of old history/reservations, and operator recovery. Preserve valid old settlement, outstanding holds and lease caps. Required tests include no-initial-budget grant/settle/top-up, concurrent grants, boundary times, all cycle modes, multi-account deployments and external-only output. Source: `docs/verification/BACKEND-RISKS-SOURCE-2026-11-06.md`, `internal/service/cycle.go`, `internal/store/admission_budget.go`, `internal/store/usage_projection.go`.
2. **Runtime observation ordering.** Same-generation older handlers may overwrite newer current state while retaining historical success. Real HTTP/driver reachability has not been reproduced. Capture sequencing, journal durability, atomic high-water comparison, retry identity and legacy migration/cutover require design and tests. Physical node metrics already have a distinct sequence pipeline and must not be conflated. Source: backend risk note; `internal/controlprotocol/protocol.go`, `internal/httpapi/agent_observation_history.go`, `internal/agent/driver.go`.
3. **Fleet uncertain creation.** Numeric lease/stage protection is independent of lost-response creation, authoritative lookup and idempotency. The historical isolated UI WIP must not be integrated alone as a completed repair.
4. **Provider usage revision.** Allowance unit precision does not close the provider-revision backend contract. Concurrent updates and authoritative accounting require separate evidence.
5. **Policy/audit atomicity.** Accurate UI interpretation of the exact committed/audit-missing response does not make writes atomic. Generic uncertainty, conflict/rebase and guarded group/user journeys remain open.
6. **Account quota transport/concurrency.** Admin unsafe-value blocking is not exact-int64 transport. Full PUT concurrency and safe unrelated edits with unsafe quotas remain unresolved.
7. **Agent enrollment.** Bounded pending UI ownership is now reconstructed (v125), but not executed. Lost response/forced departure can still lose a newly issued token; backend idempotency and recovery need separate contracts. Do not persist secrets or imply a warning recovers credentials.
8. **Exit write receipts.** Pending TLS read protection is present, hidden navigation warning now reconstructed (v127), and durable metadata-only GET receipts remain unimplemented. Do not store TLS-bearing requests or infer rollback from a failed response.
9. **Rule opened revision.** Rule-import UI recovery cannot establish the server’s opened-revision contract; keep this open after the composed UI candidate.
10. **Nodes-only output semantics.** Product-contract decision is still required before implementation. Neither UI counts nor a parser pass resolves it.
11. **Other explicit boundaries.** Resource inspection success schema remains unvalidated; processed template catalog observations are non-atomic; domain save/verify and template publication unknown outcomes are not closed; subscription current-access reads do not establish historical rotation receipts.

Items 3–10 are recorded in the checkpoint summaries, `RECONSTRUCTION-STATUS-2026-11-06.md`, and their related reconstruction notes. Do not promote a recorded risk into a reproduced failure without new evidence.

### MFA, authentication and session ownership

- `Security.tsx` local dismissal cleanup only: unknown enable outcomes, setup-secret handling, enable response rotation, malformed success, premature success feedback and shared cross-flow write ownership remain unresolved. Real MFA and authoritative reconciliation are unrun.
- Account-security reminders use actor-bound, nonsecret same-tab sessionStorage. Invalid/cross-actor data fail closed; repair UX remains absent. Storage is not an authorization boundary, cross-tab lock, server audit, or durable receipt. Password change with lost cookie response can require manual login.
- Same-actor session generation/rotation still relies on the existing `api.ts`/`SessionLifecycle.ts` transport. New component tests are not substitutes for installed session integration across token rotation, logout, actor switches, late responses and delayed validation.
- Subscription rotation reminders survive same-account page remount only, not full reload or new account epoch. Invitation creation reminders are form-mode-local; manual resubmission remains possible. These losses must be tested and described accurately.
- Diagnostic metadata supports same-tab reload but exact-ID acknowledgment is not execution success. A 404 stays unknown; abandonment does not cancel the old operation and can permit duplicate traffic. Storage failures, actor/epoch transitions and retired form callbacks need combined execution coverage.
- Bundle download lifetime fencing must be exercised with token changes, cookie-only sessions, unmount, review return, auth errors, body-read failure, and actual saving. No live authentication evidence exists for the audited branch.

Sources: `ACCOUNT-SECURITY-UNCERTAINTY-RECONSTRUCTION-2026-11-06.md`, `MFA-SETUP-DISMISSAL-SOURCE-2026-11-06.md`, `SUBSCRIPTION-ROTATION-UNCERTAINTY-RECONSTRUCTION-2026-11-06.md`, `INVITE-UNCERTAINTY-SOURCE-2026-11-06.md`, `DIAGNOSTIC-REQUEST-RECOVERY-RECONSTRUCTION-2026-11-06.md`, `BUNDLE-ACCESS-RECONSTRUCTION-2026-11-06.md`, and the execution plan, all under `docs/verification/`.

### Frontend execution gates

- Dependency restoration is not complete: read-only inventory found 129 matching Linux/x64 cached archives and 321 missing archives. The unchanged lockfile requires the official npm registry, outside the current allowlist. No substitute packages, partial node_modules, script execution or network bypass is authorized by this audit.
- After explicit permitted provisioning, record exact commit/tree, lockfile digest, tool versions, clean status and dependency integrity. Run baseline sensitivity cases separately, then focused reconstructed tests. Record true red/green outcomes instead of assigning historical results to new tests.
- Run typecheck, serialized full frontend suite and production build on the exact composed source. Preserve failed and interrupted runs accurately. Re-run affected tests after integration fixes; authored tests and source review do not constitute passes.
- Go, browser/server, native core and broader verification remain separate boundaries. The generic static/quick/full scripts may invoke these and cannot be substituted for a frontend-only gate. Saved source/readback checks do not authorize execution.

### Browser, native and full-product acceptance

- Real composed page/state review: desktop, narrow and short-height layouts; keyboard-only focus and return/reveal; accessibility names and assistive technology; meaningful copy and consequence visibility; empty/loading/error/offline/unknown states; Cancel, Back/Forward, repeated actions, delayed validation, departure and retry.
- Numeric interactions: raw incomplete strings, clear/default, units, arrows, wheel, locale, blur, correction, discard and review invalidation on actual host pages. Profile JSON replacement and malformed DNS must remain repairable after numeric errors. Calendar tests must use UTC, New York and Lord Howe with the locked DayPicker integration.
- Native file behaviors: same-file selection/retry, canceled file dialog, paired PEM loading, stale read suppression, backup inspection and actual bundle saving. Synthetic DOM/ZIP fixtures cannot establish these.
- Real test-backend wires: no unintended mutation on Cancel, no automatic replay after uncertainty, correct request ownership after actor/generation changes, fresh review before writes, and current-state reads never presented as historical receipts.
- Native-client contract and output: distinguish frozen review, legacy omission, rendered/validated configuration, applied state, parser acceptance, process liveness, actual traffic, and deployed enforcement. Optional digest is not reservation or idempotency. Nodes-only semantics still need a decision.
- Managed lifecycle consequences: separately verify admission/renewal denial, independent lease expiry and effects on shared instances. UI copy and cached observations do not prove immediate disconnect, online state or effective enforcement.
- Exact-source required project gates, migration/operator recovery, independent standards/spec review and all-page product acceptance remain open. Historical CI62 applies to the v88-equivalent tree; the historical v137 3,127-test report does not validate this source. No current deployment or publication result is claimed.

Primary execution reference: `docs/verification/RECONSTRUCTION-EXECUTION-PLAN-2026-11-06.md`. Repository `AGENTS.md` requires truthful tested/unsupported/unrun distinctions and public-seam evidence; no story or release acceptance should be marked verified from this audit.


## Additional acceptance required for newly composed scopes

- CollectionPreview: real Radix keyboard behavior, reorder/removal focus ownership, editor focus preservation, narrow layout, native nearest scrolling and empty/reappearing stages. Canonical stage identity uniqueness must not be inferred for malformed input.
- Invitation expiry: exact raw/blank/default/bounds, invalid tails, correction/revert, repeated discard, arrow/disabled semantics and accessible error/help rendering on desktop/narrow screens.
- Rule import: native picker cancellation/same-file retry, read abort and synchronous read exceptions, HTTPS mode, actual session changes during preparation, owner departure during session wait, late HTTP results and server opened-revision conflicts. Lifetime fencing does not cancel an already dispatched write.
- Enrollment: delayed form validation and duplicate submission, pending Cancel/Escape, actual departure warning, actor/instance replacement, success token lifetime, failure/retry and forced departure. Verify token material stays out of durable storage/cache; uncertain retry safety is not provided.
- Navigation composition: multiple custom owners plus an ordinary draft, duplicate messages, history-forward warning, hidden uncertain exit, terminal cleanup, enrollment coexistence and real browser Back/Forward/unload limitations. Source tests are not proof of actual history or focus behavior.
- Native creation contract: verify exact reviewed descriptor/digest handling and owner receipt reconciliation against a real test backend when permitted; native parse, process, traffic and deployment evidence remain distinct.

## Next decisions and preservation

The explicit source omissions identified in the earlier audit are addressed in this composition, but v97 still needs a better historical contract or a freshly defined bounded replacement. Keep the three partial and three aggregate-only rows open. Prioritize the documented backend/MFA/session contracts and separately authorized exact-source execution, not feature-count inflation.

Preserve this audit alongside the saved composition and its recorded bundle/readback receipt, retaining the distinction between audited application commit 6c6f2a3 and documentation-updated saved commit 10755d1. `checkpoint-coverage.json` contains all 49 historical identities; `AUDIT-RECEIPT.json` contains exact Git/input/output hashes and prior-audit preservation hashes. No application verification or upload was performed.
