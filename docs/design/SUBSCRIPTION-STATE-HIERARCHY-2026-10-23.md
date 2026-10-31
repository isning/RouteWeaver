# Subscription state hierarchy — 2026-10-23

## Decision

Independent expert review, not user research. Existing desktop/mobile evidence (`device-update-workbench-evidence-20261023/browser-v6/06…1440.png`, `07…390.png`) showed a pending Android publication and matching MacBook with equally prominent green publication labels and timestamp-first muted comparisons. The important distinction required reading sentence tails.

Keep one model: a saved configuration owns independent frozen client subscriptions. A publication can exist while saved changes remain unpublished. Comparison is an explicit as-of observation, never actual-client synchronization.

Minimal changes: lead each comparison with its outcome; keep its full check date visibly secondary; emphasize only pending/repair outcomes with weight and existing primary text color; make list publication metadata neutral. Known changed rows offer “查看修改” through the unchanged preview handler; other states retain “检查更新”, revoked retains “检查重新发布”. The existing final publish confirmation remains mandatory. A failed comparison says “暂时无法比较”, without directing users to an absent row retry. Keep two row actions and the scoped batch comparison button; add no helper paragraphs or network/cache behavior.

The subscription detail keeps its existing action contract. Unknown, waiting, checking, invalidated and typed repair facts remain distinct. Neutral metadata applies only to published list rows, not revoked/other lifecycle statuses.

## Basis and limits

Project synthesis: [Content design rules](CONTENT-DESIGN-RULES.md) (“先读状态，再查身份”, concrete actions, truthful unknowns); [experience model](PRODUCT-EXPERIENCE-MODEL-2026-10-22.md) (shared Profile versus independent Output); [Refactoring UI audit](REFACTORING-UI-AUDIT-2026-10-20.md) (hierarchy before cosmetics). User-selected [unofficial Refactoring UI reference](https://github.com/edisonmbli/refactoring-ui-skill) was inspected; no framework/scripts or certification claim.

Verification uses the public rendered subscription workspace with HTTP-boundary fixtures, then a real local backend journey at 1440/390 CSS px. It does not establish human comprehension, native client application, or production deployment. Test-only old-code baseline was preserved before implementation; its later execution is a negative control, not a strict test-first execution claim.

## Verification receipt

- Old-code/new-tests negative control: both selected cases failed on the intended outcome-first receipt expectations. Tests were prepared before implementation but executed afterward; this is not strict chronological TDD.
- First six-file focused run: 62/63 passed. One three-device test used a formerly unique failure string; after both unknown outcomes intentionally shared the same copy, the query matched Android and Tablet. Scoped that assertion to the named Android row without removing Tablet's dated-unavailable or MacBook's repair assertion. Changed file then passed 16/16. The other five files passed unchanged; these results are not a second full six-file run.
- Typecheck, formatting check and Vite build passed. Existing large-chunk warning remains. No caching/API change, timeout extension, skipped-case addition or retry policy change.
- First browser run reached selected publication and preserved the sibling, then failed an immediate count assertion for MacBook's action. Its failure screenshot showed the expected action. A subsequent diagnostic uses the normal bounded locator assertion and records AX/timing; it passed with immediate count 1 and 56 ms including snapshots. The first zero-count condition was not reproduced; its cause remains unconfirmed, not a claimed product repair.
- Complete local built-frontend/real-backend journey passed: source acceptance, named draft repair, two changed outputs, one explicit publication, unchanged sibling revision/artifact/access, 1440/390 outcome hierarchy, injected single-device HTTP 503, batch recovery, detail revisit and search. Fixture creation used owner APIs after UI login. HTTP 503 was injected; the rest used the real local backend. No external/native-client application evidence.
- Actual desktop rows remain 61/60 px; action targets are at least 44 px at both widths. Outcome uses existing primary text with weight 600; date is visible, muted, weight 400. Desktop/narrow PNGs were inspected, including failure states. Narrow content scrolls naturally; no new helper block, status badge or action was added.

Evidence: `subscription-hierarchy-evidence-20261023/` (outside the deliverable source), including retained negative and first-attempt failures, focused logs, build/source manifests, final safe facts and 1440/390 screenshots. Root's separate full-suite result belongs to the pre-change canonical build and does not sign off this candidate; no aggregate/native/production pass is claimed.


## 更新检查的任务范围补充 — 2026-10-23

订阅卡片的比较来自已保存输入与冻结发布内容，不是当前可下载性、服务器应用确认或客户端连接检查。沿用上面的[内容设计规则](CONTENT-DESIGN-RULES.md)与[体验模型](PRODUCT-EXPERIENCE-MODEL-2026-10-22.md)，只把未检查、进行中、队列等待及失效提示改为“未检查更新 / 正在检查更新 / 等待检查更新 / 需要重新检查更新”；批量动作改为“检查 N 个订阅的更新”，详情比较重试改为“重新检查更新”。结果与完整核对日期保留。详情中的“已发布”与列表统一为中性历史元信息，撤销等其他状态不变。获取订阅仍在既有访问入口核对当前交付条件，其“重新核对”不改；检查更新与最终明确发布仍分开。没有新增接口、轮询、读写、缓存行为或常驻说明段落。

有界证据在 `subscription-check-copy-candidate-20261023/`（交付源码之外）：最终格式及类型检查通过；四个 DOM 文件 28/28，通过既有可见配置任务验证“两项正在检查、三项等待检查”和中性详情；新增单一真实本地后端浏览器案例通过，使用公开 API 创建带真实发布时间的五份合成订阅，核对仅按明确操作读取、无自动发布，覆盖 1440/390 下批量按钮、详情、Escape 与返回焦点。实施者检查四张稳定截图，协调者另行复核 390 列表/详情与 1440 详情；最长失效状态“需要重新检查更新”仍仅有 DOM 证据，未作视觉验收。独立源码复核接受这七文件范围；整合记录保留严格前后哈希、权限和其他源码不变检查，不替代完整回归或原生客户端验证。

保留首次清单选择为零、API 夹具创建后旧 UI 缓存导致的首次浏览器失败，以及相对临时目录造成的后端启动失败；均未算产品缺陷或通过。后续显式重新加载夹具，并使用绝对运行路径。首个通过案例的详情截图捕获了入场动画，未作为稳定视觉证据；仅调整截图为完成有限动画后，再次运行同一案例通过，没有延长预算。此前绿色列表徽标不对应本轮基线，缺失发布时间的合成数据也不建立“已发布却尚未发布”的产品缺陷。本轮不声称所有状态的人类理解、全量回归、生产部署或整体产品认证。
