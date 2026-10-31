# RouteWeaver task-first interaction rules

Revised 2026-10-19 after user review. [UI-SPEC.md](UI-SPEC.md) defines the page/action design; [UX-REVIEW.md](UX-REVIEW.md) explains the changes. This replaces the earlier editor-first interaction layout without changing server/user authority boundaries.

## Core journeys

### Obtain a subscription

Open 我的订阅 → 获取订阅 → choose remembered/supported client → 复制订阅链接 or 下载配置. Use the current published configuration. A user with pending edits can still retrieve the published result; obtaining a subscription never silently publishes edits. Only when the selected target needs generation/changes does the flow show a concise review.

### Adjust routing

我的订阅 → 调整分流 → change a named application's group choice or default traffic → 查看修改 → 发布修改. Sources, membership, ordered rules, rule files and DNS are progressively disclosed in advanced settings. Automatic rules select the group; users can manually choose a connection within that group. No shared topology is changed.

### Operate a route

Admin opens 线路 list → concise route detail → 编辑线路 when needed → ordered-path editor or explicit graph mode → 查看修改 → validate/apply → observe outcome → publish availability where required. Current published state remains separate from draft and deployment state. Diagnostics are accessible from actual problems and history, not default page furniture.

## Information belongs at the moment of need

- Route multiplier: once beside selection and in usage detail; explain the arithmetic on demand.
- Source privacy: once beside adding a private subscription, with optional detail; no dashboard lecture.
- Capabilities: show a specific restriction when selecting/editing a target or when it blocks publication, not a permanent compatibility matrix.
- IDs, digests, generation counters, native instance versions: advanced diagnostics. Stable identity still governs references behind the UI.
- Published changes: compact pending strip; current summary reflects published settings until explicitly changed.
- Errors: object, concrete cause, one useful next action. No “nonavailability promises”, generic “availability still needs verification” or repeated prototype badges on product surfaces.

Healthy operation is the normal scenario. An error is shown when the state actually requires it; removing defensive text does not authorize fabricating healthy observations or hiding blockers. Prototype fixtures and missing verification are documented outside simulated product screens.

## Identity, graph and source update rules

Names are editable labels; stable IDs preserve grants and references. Duplicate labels use source/region context for human disambiguation, not a default wall of IDs. Imported records are matched within their source using trustworthy identity; labels/order/country alone cannot identify a connection. Cross-source private data is not globally merged.

Graph is an edit-mode tool. Ports identify endpoints under their actual instance/VPS. Direction and ordered path determine forwarding, not canvas position. An identical Link offers reuse; an alternate transport/policy is not silently merged. Shared-link changes expose affected routes before applying. Cycles/missing references/unsupported semantics produce field/context errors without discarding other edits.

Ordered path offers the same operations by keyboard: select entry, add/change next hop, move/remove, identify exit. Same validation in both views. Focus/announcements track the changed row. Narrow screens default to this form; drag is optional.

Source refresh with no material change updates quietly. A material selected-connection change shows a concise diff with affected groups. Proven rename preserves aliases and membership. Ambiguous replacement or vanished selection remains explicit until the user resolves it. Transport failure retains last accepted snapshot with truthful freshness; a valid empty feed is a removal diff, not an outage. Partial parse requires explicit review of unsupported/excluded items, never silent loss.

## Rule files and generation

Prefer supported external/packaged rules. Target-specific rendering preserves rule order, DNS intent, final default and failure behavior. Unsupported semantics block the affected new output with remedy; no silent omission, exit change, format weakening or inline flattening. File/version/delivery specifics expand only when editing or diagnosing that resource.

Retrieve/publish/download rechecks effective rights and resource eligibility. A failed candidate does not become the published result. Secret-bearing URLs/artifacts remain owner-scoped and redacted in logs/errors. Source deletion, feed rotation and revocation explain their concrete consequences at the action, including downloaded-copy limitations where relevant, not as recurring warnings.

## State transitions and recovery

Draft save can preserve incomplete work; publication/apply require validity. Review freezes exact inputs, and changed dependencies require refreshed review. Concurrent edits preserve local work and offer comparison. Ordinary edits need no ceremonial confirmation; consequential live changes get a focused impact review.

Accepted asynchronous work has a persisted identity; closing a page does not cancel it. Uncertain submission is reconciled before retry. Partial deployment shows a scoped cause/action, with per-target details available. Retry applies only to eligible fenced targets. Rollback is a new reviewed attempt to known-good state, with its own observations; no history rewriting or optimistic success claim. A partial live update must not claim the old state remains fully intact unless evidence supports that.

Global loading/error/empty/conflict states preserve context and input. Errors have retry/fix actions; failure is not an empty onboarding state. Controls are keyboard-operable, labels semantic, focus visible, statuses non-color-only and layouts narrow-screen usable.

## Confirmed product boundaries

Server-side private subscription processing was accepted in Sentinel_522e8560f0c08191b4a0ef25b0bf4b18; the operator is not cryptographically excluded from processing visibility. Ownership and secret controls still apply.

Whole-route multiplier accounting was confirmed in Sentinel_1031ed7a803c8191903abab89793e9da: actual traffic × multiplier debits quota once for the entire route, separately from provider IN+OUT. No per-hop repeated deduction or payment collection. Historical versions persist; detailed precision/cutover verification follows A16 and the accounting contract.

The latest user feedback requests less unnecessary information and a mature task-first UX. It does not approve all screens, implementation or unresolved compatibility/enforcement details.
