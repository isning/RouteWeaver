# RouteWeaver task-first UI specification

Design revision: 2026-10-19. This document supersedes the earlier editor-first screen layout. It is a reviewable interaction specification, not implementation or test evidence. Product constraints and A01–A16 remain in SPEC.md; domain and IR details belong in DOMAIN-MODEL.md, not ordinary product screens.

## 1. What the interface optimizes

Invited users come to obtain a working subscription, occasionally change routing, and understand their allowance. Administrators come to operate routes, change them deliberately and resolve concrete incidents. Neither starts by inspecting an IR, resource manifest or deployment generation.

Default personal page: **我的订阅**. Primary action: **获取订阅**. Secondary: **调整分流**. Default admin page: **线路**. Healthy operation is the default screen scenario. Actual failures add a scoped reason and action; cautionary filler is not a substitute for state.

### Information hierarchy

| Layer | What belongs here | What does not |
| --- | --- | --- |
| Daily task | Current routing choices, Get subscription, usage summary; admin route list/status | Internal identifiers, hashes, core version matrices, contract lessons |
| Deliberate editing | Groups, source selection, rule ordering, DNS, graph/ordered path, pending change review | Runtime logs and generic reliability warnings |
| Troubleshooting | Affected object, specific cause, retry/fix action, relevant history | Unrelated diagnostics or all possible failure scenarios |
| Advanced diagnostic detail | Request IDs, digests, resource/version manifests, per-instance revision evidence | Default home/detail presentation |

The model keeps stable IDs; screens use names and contextual labels. Resolve duplicate names with source/region context first, with technical IDs available in detail if needed. Remove repeated Demo/Not implemented/Not verified badges from product chrome. Prototype evidence and test limitations are documented outside the simulated product; do not represent simulated state as live verification.

## 2. Navigation and common behavior

Personal navigation: 我的订阅, 我的机场, 用量. Account/settings stay in the account menu. Rule resources and DNS are reached from routing's advanced settings rather than top-level navigation. Additional profiles live in a compact subscription selector; a single-profile user does not see a profile-management dashboard.

Administrator navigation: 线路, 服务器, 用户与套餐, 用量. 部署记录 is reached from a route's activity or operations menu, not the default landing page. An administrator can switch to the personal workspace in the navigation header. Only roles with permission see the switch; authorization remains server-side.

Desktop has compact left navigation and a content header with one main action on the right. Mobile uses a navigation drawer and full-width content. Editors use a sticky footer without covering focused inputs. Lists keep search/filter controls immediately above their rows. Destructive actions belong in an overflow menu/detail section, not beside everyday primary actions.

Public state labels say what the user needs to know: 正常, 更新中, 未保存, 有待发布修改, 暂停, 更新失败. Add timestamps only where recency matters. Never turn missing observations into a healthy status. Missing observations alone are not evidence of connection failure. For an observed connection failure say “连接超时” with the appropriate retry action; while an actual state-sync operation is pending, show “状态同步中” only in the relevant administrative task. Do not show vague global “可用性仍待核对”. Underlying unknown/partial states remain distinct in the data and diagnostics.

Saving a draft and publishing it are different. Published information remains the main view; a compact pending-changes strip links to 继续编辑 / 查看修改. No modal confirmation for an ordinary rename or draft save. Changes affecting live paths, multipliers, authorization, deletion or credentials receive focused consequence review. Errors retain entered values. Uncertain action acceptance is reconciled before enabling retry; this is system behavior, not a dashboard lecture.

## 3. Personal: 我的订阅

### Normal published state

Header: 我的订阅, optional subscription selector. Header right primary 获取订阅; immediately left secondary 调整分流.

Main content, in order:
1. Compact current-routing summary: “ChatGPT · 英国线路”, “其他流量 · 我的机场” using actual published group selections. Clicking a row opens that group's adjustment. No server-hop diagram or rule syntax appears here.
2. Remaining quota with a compact used/total value and 查看用量 link. Show weighted quota as quota, with actual traffic in usage detail; do not add an accounting tutorial to this card.
3. If there are saved unpublished changes, one strip: “有待发布修改” with 查看修改. Main routing summary still reflects published configuration.

Optional source freshness/connection information belongs alongside the relevant source only when useful. No default warning banner, privacy essay, compatibility disclaimer, giant status grid or technical field list. Multiplier appears once next to a route when choosing/changing it, and in usage, not repeated on every summary card.

### Get subscription

获取订阅 opens a small sheet:
- Client selector, remembering the user's last valid choice. Show version constraints only when they affect this selection.
- Primary 复制订阅链接 when that client has a compatible published subscription.
- Secondary 下载配置; close control at top. A supported import action may replace Copy only when actually available for the target, not as a dead button.
- Success feedback: 已复制, inside the button/sheet. Do not reveal the URL elsewhere or include it in notifications.

This is retrieval of the current published result, not a forced trip through advanced preview. The service rechecks rights and delivery eligibility. A target requiring a new generation leads to a compact review of necessary differences and 发布并获取; it does not silently republish drafts. If the user has unrelated pending edits, the sheet still retrieves the current published subscription and offers 查看待发布修改 as a secondary link.

Compatibility blocker example: “此客户端不支持所选规则文件。选择其他客户端，或调整这条规则。” Actions: 选择客户端 / 查看规则. Show only affected details. Do not offer a misleading copy/download of invalid output or silently flatten rules.

### First use and empty states

An entitled new user gets a suggested basic configuration with one task: 设置订阅. A short setup chooses client, desired entitled route and default behavior, then reviews and publishes it. Adding a private airport is optional, not a prerequisite for using the platform's routes. If no entitlement exists, show “还没有可用线路” and the available contact/access next step; do not launch a technical editor or fabricate content.

## 4. Personal: 调整分流

Entry opens an editing page/sheet with published selection loaded into a distinct draft. Header: 调整分流; secondary 返回我的订阅. Default sections show human tasks, not an IR:
- 应用分流: named groups such as ChatGPT and their current selected route.
- 其他流量: explicit default group/action.
- Add a group via 添加分流, not an empty full rule engine on first open.

Select a route in a chooser grouped into 平台线路 and 我的机场. Each row shows name, useful region/source context and the platform multiplier once, such as 2×. Selecting the multiplier explanation shows “使用 1 GB，扣除 2 GB 额度”; this is on demand. Disabled choices have an actual reason and fix where available. Existing selected-but-unavailable entries remain visible for deliberate replacement. Names or geography never authorize automatic replacement.

Footer: 保存草稿 secondary left, 查看修改 primary right. Compact review groups changes by task: “ChatGPT：线路 A → 线路 B”, “默认流量：机场 A → 机场 B”, and relevant multiplier change. 发布修改 is primary only after valid review. On success return to 我的订阅 with new current summary. If anything fails, the current published result remains separate and the draft is retained.

### Progressive advanced settings

高级设置 is a collapsed section/link after ordinary choices. It contains:
- 分组: group membership and manual selection controls.
- 规则顺序: ordered matches/actions, editable with Move up/down or drag; explicit final default outside reorderable rules.
- 规则文件: resource name, version/update setting and any relevant problem. Manage/add resources here; technical manifest in 详细信息.
- DNS: target-relevant DNS choices and explicit defaults.

Expanding advanced settings does not apply changes. A change that cannot preserve semantics blocks publication with the specific affected rule/target. No automatic fallback, rule omission or unrequested inline expansion. A user can complete basic routing changes without opening any advanced section.

## 5. Personal: 我的机场 and rule-resource management

我的机场 header right primary 添加机场. List rows show source name, available options count and last successful update if helpful. Frequent row action 更新; More holds 编辑 / 暂停更新 / 删除. Healthy rows do not display identifiers, snapshot versions or verbose pipeline status.

Add form: 名称, 订阅链接, optional format override in advanced details. Place the confirmed trust disclosure once beneath the link input: “订阅由服务器处理；运营者理论上可接触处理中的内容。” A nearby learn-more detail can explain encryption/isolation without promising operator blindness. Do not repeat this notice on dashboard, every refresh or route picker. Mask credentials after save and redact errors.

Footer: 取消 / 添加并检查. During fetching show progress in the form. Failure retains fields with concrete cause, for example “订阅链接已失效，请更新链接” and 编辑链接. Preview shows usable options and any entries needing attention. Completely invalid response is an error, not a successful empty import. A partial import explicitly identifies excluded entries before acceptance.

Refresh normally needs no dialog for unchanged data. Material changes affecting selections open 更新内容 with Added/Removed/Connection changed and affected group names; accept deliberately. Proven identity with renamed label preserves aliases/membership. Ambiguous replacement is not guessed. Empty valid feed is a removal update, not a network failure. A failed fetch retains last accepted snapshot without treating it as current fetched data.

Source deletion review names affected groups/subscriptions and states that downloaded client copies are not recalled only where that consequence matters. Remove from a draft is distinct from deleting the source.

### Rule-resource diagnostics, reached in context

A problem appears beside the affected rule, with 查看原因. Details show resource name, concrete cause and one primary fix. Advanced details contain format/version/digest/cache provenance when relevant.

| Actual condition | User-facing message/action | System behavior |
| --- | --- | --- |
| Unsupported file format | “此客户端不支持该规则文件” → 更换格式/客户端 | Block incompatible publication; no silent inlining |
| Semantics not preserved | “此规则包含客户端不支持的匹配方式” → 编辑规则 | Preserve old published state; identify specific matcher in detail |
| Integrity check failed | “规则文件校验失败” → 重新获取 | Reject candidate; never accept changed bytes under a pinned digest |
| Fetch failed with permitted cached version | “规则更新失败” → 重试更新 | Retain accepted version within its policy; show age in detail |
| Required file expired/missing | “规则文件已过期” → 更新规则文件 | Block affected new publication; do not omit/widen routing |
| Private delivery unsupported | “此客户端无法读取私有规则文件” → 选择客户端 | Offer a safe supported bundle only if explicitly available |

No generic “不保证可用” copy. Do not surface an internal security detail that exposes another user's source or a credential.

## 6. Personal: 用量 and subscription access settings

用量 summary: 本周期已用额度 / 总额度 / 剩余额度 and cycle dates. Detail has per-route 实际流量, 倍率, 扣除额度. Explain the relationship on demand; no payment currency, invoice or checkout. Historical rows retain their applicable multiplier. Provider IN+OUT belongs to administrator scope, not the user's deducted quota. Unknown measurement is not rendered as zero.

Credential rotation/revocation lives under subscription settings reached from the subscription menu, not beside 获取订阅. Confirm “旧链接将停止获取更新，需要在客户端替换链接”, then show the new link in that controlled surface. Already downloaded material is not recallable. User-visible state reflects actual revocation progress rather than a control-plane write alone.

## 7. Administrator: 线路 list and concise route detail

Landing header: 线路; primary 新建线路. Search and status filter above list. Columns: name, concise entry → exit, multiplier, status, assigned offering/users summary where useful. Row name opens detail. Frequent action 编辑 in row; More holds 暂停 / 归档. No graph, global deploy console or core matrix on landing.

Normal route detail:
- Header name and operational status; primary 编辑线路, secondary More.
- Compact path summary “FRA → UK”, multiplier and who can use it.
- Recent relevant activity, collapsed beyond the latest few entries.
- Pending-change strip if draft exists, with 查看修改.

No routine ID/digest/generation table, raw config, “可用性仍待核对” or abstract guarantees. Actual issue adds a concise card, such as “UK 服务器连接失败，线路更新未完成” with 查看处理. Diagnostics are drill-down, not the page's default identity.

Published state and draft are explicit. Editing does not mutate published route. A previous published revision remains visible only under its real operational state; do not use “previous revision unchanged” as a blanket claim when a partial live apply has changed some targets.

### New/edit route

Editor header: 编辑线路 (or 新建线路), selected draft state. Sections: 路径, 访问与倍率, 高级规则. Default path view is a concise ordered sequence; 图形编辑 opens graph mode inside this editor. Route graph is a tool for deliberate changes, not the product homepage.

Graph mode: endpoint palette grouped by VPS/core, central directed graph, selected-item inspector. Fit/Zoom controls stay inside canvas toolbar. Properties are shown only for the selection. Compatible destinations are selectable; invalid targets explain why. Duplicate identical Link offers existing relationship. Moving the drawing changes layout only. Inspector lists affected shared routes before editing reused links.

Keyboard equivalent: ordered rows with endpoint selector, 添加下一跳, 更换, 上移/下移 and 移除. Entry/exit are explicit. Same cycle, missing-reference and capability validations apply in both modes. Focus follows edited row; announcements convey order; no essential drag or hover. On mobile use ordered mode by default. No bare Delete key can unexpectedly delete a live object.

访问与倍率 sets offering/access and the whole-route multiplier. Display current multiplier beside pending value, with a short calculation example on demand. Effective-time/version details appear in change review, not every route card. No per-hop weighted deduction. Detailed arithmetic/cutover remain the accounting contract, not UI improvisation.

Footer: 保存草稿 / 查看修改. Review shows changed path/exit, access, multiplier/effective boundary and affected users. Technical diff/resources are expandable. 校验并应用 proceeds only for eligible validated changes. Live impact confirmation is specific; ordinary draft edits need no repeated confirmation.

## 8. Administrator: update, partial result and recovery

After apply, a focused progress surface shows overall task and per-target status only as needed. Success updates the route's applied/observed state. Publication to an offering remains a deliberate separate step when required, presented as 发布线路 in the completed workflow rather than a permanent array of Apply/Publish/Render buttons.

Actual partial result example: “1 台服务器更新成功，UK 服务器连接失败。” Primary 重新连接并继续; secondary 查看详情. Retry first reconciles accepted request/target state and fences against newer generations. Those details are system controls; users do not need a generation lecture.

查看详情 opens target outcomes, last relevant observation and log excerpt. Advanced diagnostics reveals native versions, desired/applied/observed revisions, identifiers and redacted artifacts. A failure of one route does not put all healthy pages into a warning state.

恢复到上一版本 is an explicit secondary recovery action only with a usable known-good candidate. Review names affected route/targets and missing prerequisites. Rollback creates a new attempt; original history is retained. Actual unknown result says “正在确认服务器状态” with refresh/reconcile, not a guessed success or blind retry. Closing progress does not cancel accepted work. Success requires observed outcome; a failed rollback remains visibly failed with the concrete next step.

## 9. Supporting administrator pages

服务器: list of named VPSs and status; Add server primary. Open server for core instances, endpoints and provider allowance; core/version details belong here, not user route choice. Add instance/endpoint lives in the corresponding section. In-use removal shows affected routes before action.

用户与套餐: Users/Offerings tabs; Invite user/Create offering primary per tab. User detail shows grants and allowance, not private source credentials. Grant/revoke actions show affected routes and propagation state. Offering change preview summarizes actual membership/limit changes. No purchase/payment flow.

用量: Provider/User scope selector. Provider view uses provider-defined actual counters and cycle; user view shows actual and weighted quota distinctly. Do not use today's multiplier to rewrite history. Cycle/limit editing stays next to scope settings, never erases ledger history. Precise accounting freshness and enforcement are shown only where they affect decisions, with affected route/user and fix.

部署记录: route activity deep-link or operations menu. Searchable history with state/time/route; open an attempt for troubleshooting. Not an alternative home screen requiring every user to interpret a deployment pipeline.

## 10. Universal recovery and accessibility

- Initial loading uses a compact skeleton, not fabricated totals. Refresh keeps existing content with an unobtrusive indicator.
- Genuine empty offers one relevant next step; filtered empty offers Clear filters; a read failure offers Retry, not a new-account empty screen.
- Validation appears beside the field and in a linked summary on submit; keep input and focus first actionable error.
- Draft conflict: “此配置已被更新” with 查看差异; retain local draft until deliberate replacement. Do not silently overwrite.
- Changed inputs invalidate the relevant review; ask to refresh that review without discarding unrelated draft edits.
- Permission loss blocks retrieval/apply and exposes no other-owner metadata. Give a contextual next step without pretending permissions are intact.
- Dialog focus returns to trigger; destructive confirmation defaults to Cancel. Text/icon convey status without color alone. Respect reduced motion.
- Polling never steals focus, reorders the current selection unexpectedly or announces every tick. Narrow layouts retain controls and readable labels.

## 11. Design review and acceptance evidence

These are review/test tasks, not product-screen copy or passed-test claims:
1. A user retrieves a published subscription without opening groups/rules/DNS or diagnostics (A04,A08,A11).
2. A user changes ChatGPT's chosen route, sees multiplier once at choice, reviews a concise diff and publishes; current and pending are never conflated (A06–A08,A16).
3. A user adds an airport, sees trust disclosure once, fixes a concrete failure and preserves input; ambiguous refresh never swaps a selection (A05,A06,A14).
4. A selected incompatible/private rule resource blocks publication with cause and remedy, without silently flattening (A15).
5. An admin starts from route list, edits by keyboard or graph, previews live impact and recovers a partial update (A01–A03,A10,A12).
6. Usage distinguishes raw, weighted and provider measurements, retaining historical multiplier versions (A09,A13,A16).

Default prototype scenario is a healthy published configuration with fixture-backed values. Error scenarios are separately selectable and describe one actual simulated cause. The prototype's documentation identifies fixtures and untested behavior outside the product UI; no real connection/uptime is inferred. Product direction is being refined, not broadly approved. Exact compatibility versions, enforcement/accounting contracts and usability evidence remain in engineering/design records rather than dashboard disclaimers.
