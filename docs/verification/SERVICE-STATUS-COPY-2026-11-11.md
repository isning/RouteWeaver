# Platform service status copy review

Baseline: 0cbc9fa. Candidate only; checkout untouched. No tests, builds, browser, publication or deployment performed. No Users or UserEntries edits.

## Before / after and source semantics

- `平台授权有效` → overview `已开通`, shared administrative status `服务已开通`. `internal/service/effective.go:58–159` initializes active, then checks plan resolution, account enablement, pause, start and expiry. This is the service opening/eligibility state, not a claim about route availability, deployed entries, traffic or external client reload. Even no service plan and zero granted routes can be active. `AllowsRoute` additionally requires membership in route IDs. The service-focused label matches the existing 开通 / 到期 field in AccessPolicy and avoids the implementation-facing “平台授权”. Do not substitute “连接正常”, “线路可用” or “已生效”.
- `尚未开通` → `未到开通时间`. This branch is precisely now.Before(ent.StartsAt), not missing configuration or a failed provisioning job. The time condition is explicit; 待开通 was rejected because it could imply a pending administrative action. Retain the start date in policy detail.
- `服务方案已缺失` → `服务方案不存在`. The selected plan ID has no match in supplied plans (`effective.go:99–112`). This is an authoritative missing ID, not a read failure: internal/store/effective_policy.go:34–47 returns errors for failed list reads or invalid plan records before ResolvePolicy is called. A successfully loaded plan set has no matching selected ID. The label does not claim deletion.

Shared label consumers: `Subscriptions.tsx:130–142` usage badge; `AccessPolicy.tsx:84–89` comparison status; `PublishedRoutes.tsx:2094` user service status beside the independently computed route grant. No route grants or control behavior change.

## Audited and deliberately retained

- `平台服务已暂停`, `账号已停用`, `已到期`, `用户组方案冲突`: distinct actual states. The paused-service admin recovery action remains visible. No reason to mechanically shorten or remove these negative facts.
- `额度已用尽`, `等待统计同步`: overview extends policy status in `internal/httpapi/admin.go:326–336`; do not replace with general service eligibility.
- `平台入口尚未确认可用`: separate output-readiness state. `internal/httpapi/output_eligibility.go` checks account, service status, frozen grant ownership/revocation/route identity and managed-entry proof. Missing application proof produces OUTPUT_ENTRY_UNCONFIRMED. Retain the uncertainty and 重新核对 action; “正在开通” or “即将可用” would invent progress.
- `平台入口暂无法核对`, missing selected-entry count and preserved selection in Profiles: separate inventory-loading/error/identity states. Retain them.
- `平台授权已更新`: mutation success describes the changed object, not the complained-about standing status. Retain it and the partial-audit-save warning; do not turn successful policy storage into node-application success.
- Existing missing/unknown overview fallback is unchanged (blank uses generic 未设置; unrecognized values stay visible). This candidate does not collapse missing, unknown or error into active. Separate follow-up may improve 未设置 to an explicitly unknown-state label, but that is a distinct status-contract change.

## Proposed verification

Existing public component seams (AGENTS): update the all-status overview cases and before/after policy comparison pairing. Strengthen each non-active case against the active label; retain unknown/blank cases and no-route/unlimited-quota case. Existing published/revoked output separation and paused recovery cases remain intact. Candidate files include these assertions. This is prepared test coverage, NOT a red/green result.

Coordinator after full-suite lock releases: apply patch, run the two changed DOM suites with one worker, typecheck, and inspect actual desktop/narrow overview plus policy comparison. Keep existing rotation-recovery tests to protect entry-unconfirmed states. No new runtime dependency or backend change.

Read AGENTS.md, CONTENT-DESIGN-RULES.md, CONSOLE-CONTENT-REFINEMENT-2026-11-02.md and relevant current source. Pinned engineering skill directory was absent. Official pinned code-review and tdd SKILL.md were read through web retrieval; standalone engineering/tests/SKILL.md returned 404 (tests is linked under tdd). This is scoped copy preparation, not a claimed independent code-review workflow or executed TDD loop.

Artifacts: platform-status-copy.patch plus full candidate files under candidate/web/src/.

## Context-specific active wording

Subscriptions.tsx:979 already titles the card 平台服务用量, so its badge says 已开通 without repeating 服务. AccessPolicy.tsx:84–89 labels its field only 状态, and PublishedRoutes.tsx:2082–2094 places the badge in 用户授权 beside a separate route permission statement. Keep 服务已开通 in that shared map to avoid implying that the route/entry itself is open. This is a local render distinction, not a second status model. Paused/expiry labels remain unchanged rather than broadening the task with arbitrary uniform shortening.

Updated proposal includes a one-line Subscriptions.tsx hunk. Apply the patch, not full candidate file replacement, if concurrent layout edits touch that file. No tests were run.

## Integrated verification

Applied localized hunks without replacing concurrent layout work. Independent
composed source review confirmed backend semantics and unchanged unknown/error
handling. Combined ten-file run passed 106 tests in 35.35 seconds, including overview
and comparison status assertions; production build passed. No matches for the
three replaced phrases remain in web/src or web/tests. Full aggregate and native
rendered review remain separate checks. No connectivity claim, backend policy
change or deployment was introduced.
