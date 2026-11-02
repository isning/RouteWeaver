# RW-07.3 — opened Profile draft revision

Scope: existing Profile editing through the real HTTP/durable-store seam and the basic/full web editors. This closes the identified stale-editor overwrite mechanism; it is not evidence of native activation, deployment, or full-checklist readiness by itself.

## Defect and repair

The prior `templateInputs.expectRecord` read the latest stored draft at request start. Two editors could open A; after the first committed B, the second submission read B as its transaction baseline and overwrote it. The pre-existing publication-preview digest and synthetic UI 409 tests did not cover this editor-opening baseline.

`TestProfileOpenedRevisionRejectsStaleWriteAndPreservesPublishedFeed` was independently RED on baseline `7a101032f55c1bde5ff308ffa1ddfcdd97b8d79e`: the second real HTTP PUT returned 200 with `Editor B submitted draft` rather than 409. The repair reuses existing `recordRevision`/`expectedRecord` HMAC and transactional compare contracts, scoped to the private tenant record. There is no new persistence version field or backup migration.

- Reads and saves expose a transport-only `revisionToken` for the complete private record; redacted and revealed views share it.
- PUT requires the token the editor opened as `If-Match`; the same private snapshot is included in the atomic write comparison, together with materialized dependencies.
- POST is create-only. Missing/stale/wildcard update tokens and existing-ID POST return typed 409 `PROFILE_DRAFT_CHANGED`; older tokenless update clients fail closed and must migrate. Missing records remain 404; JSON token metadata is rejected rather than persisted.
- Full and basic editors retain only opening/successful-save tokens. Rejected forms stay editable but save/publication actions cannot overwrite a newer revision. Recovery uses an explicit discard confirmation; cancel preserves input and returns focus. No latest-token fetch silently upgrades a retained form.
- Published Output records/artifact bytes/access are not changed by draft saves. Auth/CSRF/tenancy and explicit secret-reveal boundaries remain.

## Focused evidence

- New real HTTP tests cover sequential stale editors with durable reopen and frozen feed bytes; missing/wildcard token and POST-upsert refusal; CSRF/tenant isolation and foreign-token rejection; clone creation; legacy stored profiles; and exactly one accepted writer across two SQLite store/server handles.
- New full-editor DOM regression was RED because If-Match was absent; GREEN verifies request header/body separation, retained form, blocked repeated write/review, explicit discard/cancel focus, successful-token advancement, clone creation, and token-free draft previews.
- Required BasicRouting caller migration was RED because the second save sent no accepted token; GREEN retains each success token and preserves the typed-conflict form. A separate no-local-edit resave regression was RED because a rejected save retained the previous `草稿已保存` label; typed rejection now marks that retained draft unsaved.
- Existing HTTP fixtures migrate intentionally through named current-state fixture helpers or explicit opened tokens. The generic request helper is unchanged; concurrency tests keep their pre-race token. Existing browser/API fixtures likewise use an explicit fixture-only helper. Negative precondition tests remain unguarded.
- Caller migration verification: 35 changed-fixture Go tests plus subtests under `-race`, and 8 tests across workspace/native-diagnostics/template-follow API suites. One worker; fresh loopback control plane. No browser/native execution in that slice.
- Independent review found a delayed-discard race: waiting for the catalog refetch after confirmation left the form editable until a later close. A focused pending-catalog test was RED; confirmed discard now starts invalidation and closes synchronously, preserving confirmation ownership. Standards and Spec review then reported 0 open findings; a separate backend/CAS/security/caller audit reported 0 actionable findings. These are source reviews, not browser execution.
- Focused implementation verification: new 3 HTTP tests with `-race`; 71 web tests across 5 relevant files, followed by a final 34-test full/basic editor rerun after lifecycle corrections; TypeScript typecheck. These do not replace the coordinator’s final aggregate.
- `web/tests/profile-revision.ui.spec.ts` adds real backend desktop/narrow journeys: open editor, competing accepted HTTP edit, actual stale 409, preserved name/DNS/sniff values, frozen subscription bytes, cancel/reopen recovery, then two successful saves using consecutive accepted tokens. Local execution is **not claimed**: Chromium is denied on this host. The final consolidated CI must execute these journeys and review their retained screenshots.

Final aggregate, independent-review, and source/tree custody results belong to the coordinator's consolidated acceptance record; earlier CI9 does not cover this patch. No local Chromium, stock sing-box startup, remote publication, live-node action, or deployment was performed for this repair.
