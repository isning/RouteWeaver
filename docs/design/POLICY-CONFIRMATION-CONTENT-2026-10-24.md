# Policy confirmation: target, impact, and relevant consequences

> Historical proposal record. The staged/unrun status and future-tense statements below describe this proposal at its preparation time, not the current combined candidate. See [combined verification and limits](../verification/POLICY-CONFIRMATION-COMPARISON-2026-10-24.md) for subsequent RED, finite DOM, browser and pixel outcomes. Original rationale and history are preserved.

2026-10-24. Staged proposal; no content-candidate test, build, browser, or canonical integration has been run. The earlier ARIA candidate's bounded verification is not evidence that these later content changes pass.

## Observed problem

The actual 390px service-review screenshot has no target name while the parent form is scrolled. A general rules paragraph, “显示完整授权”, and an empty horizontally scrollable comparison occupy the confirmation before consent. The underlying form separately explains the cycle decision. This review supports changing the confirmation, not removing that independent field explanation or redesigning the form.

Screenshot reviewed: `policy-action-accessibilit-16264-and-retain-the-draft-on-503-narrow-390/apply-busy-narrow.png` from the corrected ARIA browser evidence. This is a local rendered observation, not user-comprehension research or Google/Cloudflare certification.

## One shared confirmation

The dialog title, consent, actions, comparison geometry, and preview/apply workflow remain unchanged.

1. Show the reviewed target: `服务方案：{name}`, `用户组：{name}`, or `用户：{name}`. Capture the target when proposing the one cloned change. Service/group names come from that submitted replacement; the user's display name comes from the matching user catalog at that same time, falling back to the stable ID. Keep IDs in the local target record, never infer creation from missing catalog entries, and never serialize review display metadata to the API.
2. With no blockers and zero affected rows, show `现有用户授权不变。`; omit the empty comparison and its full-authorization control. Zero does not establish a new object or future-only allocation, so the old shared “配置将供后续分配使用” claim is removed.
3. With no blockers and rows, show `涉及 {N} 位用户。` and the existing comparison. The count comes only from the authoritative affected array. It is not labelled changed access: the backend compares full policies, including GroupIDs and the embedded Service, while the existing visible projection can correctly report `当前生效授权保持不变`.
4. With any blocker, preserve its heading and every blocker. Keep comparisons if rows exist, but display neither an unqualified total-impact count nor a zero/no-impact claim. A guard can emit a blocker before complete comparison results exist.
5. Reuse the existing Ant Collapse pattern locally as `授权规则`. General non-additive-quota guidance is supplemental. Keep the no-reset consequence visibly beside nonempty comparisons; for zero rows retain it in the disclosure. Reset disclosure state on every new accepted review, without touching revision/ownership logic.
6. Keep the save/application distinction visible: `保存策略不代表受管入口配置已应用；应用状态请在线路中查看。`

All backend blockers, explicit consent, action labels/ARIA busy state, exact values and provenance, cancellation, 409 re-preview, 503 retention, draft ownership, CAS, and server-side authorization remain in force. No model, API, deployment, or table-geometry change is proposed.

## Source rationale and limits

- [Project content-design rules](CONTENT-DESIGN-RULES.md): object/action/state/consequence first; preserve material consequences; distinguish zero, unknown, and blocked; do not add a helper to every slot.
- [Project UX methodology](UX-METHODOLOGY.md), “确认强度跟随实际后果”: confirmation identifies its object and action; supplementary detail does not replace the decision.
- [Source register](UX-GUIDELINE-SOURCES.md), GS-35: [IBM Carbon Modal guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/modal/guidelines), relevant object/action/consequences.
- Source register GS-37: [GOV.UK Details](https://design-system.service.gov.uk/components/details/), supplemental information can be disclosed while decision-critical information stays visible.
- Source register GS-16/21: [GOV.UK Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces) and [Designing good questions](https://www.gov.uk/service-manual/design/designing-good-questions), structure and relevant help before more prose.
- [Domain contract](effective-access-and-stream-limits.md), `internal/store/effective_policy.go`, `internal/store/policy_updates.go`, and `web/src/access-policy-model.ts` establish authoritative affected/blocker semantics, exact comparisons, stable cycles, and preview/apply boundaries.

These are project adaptations of already registered guidance, not a fresh external-guideline audit, a mandatory vendor layout, or an accessibility certification.

## Staging and verification boundary

The only changed production file is `web/src/AccessPolicy.tsx`, based on the exact validated ARIA overlay (base SHA-256 `6199411ca9f104aea407759b4053a29599c7b36e81badc78caba30e42678e30d`). Other ARIA files must remain in the composed candidate. Existing native/domain/DOM/browser tests are not rewritten or weakened.

New `web/src/policy-confirmation-content.dom.test.tsx` has 13 expanded public-seam cases: real service/group/user editors for zero affected rows and explicit consent; nonzero values/provenance/full view; zero/populated blockers; a GroupIDs-only affected row with unchanged projected fields; held previews for all three target kinds with input/catalog changes and exact preview/apply payloads; absent service/group catalogs; and a frozen user-ID fallback. The held apply is rejected with 503 and must retain the frozen review. Existing 409 and other ownership/error tests remain unchanged.

Seams are rendered actions/content and intercepted HTTP requests, not mocked internal hooks or private state. `usePolicyChange` is exercised through a small caller using its exported interface for the metadata cases. Pinned TDD/codebase-design guidance and TDD-linked tests/mocking references were read. Tests were written before the staged production change, but runtime is intentionally deferred: this is not an executed red-to-green result. A tests-only overlay is supplied for a subsequent baseline RED run.

The runtime owner must run the approved serialized DOM/browser/typecheck scope against the composed ARIA-plus-content source and independently inspect desktop/narrow pixels before integration. Passing earlier ARIA busy/error/draft checks does not settle this content review.
