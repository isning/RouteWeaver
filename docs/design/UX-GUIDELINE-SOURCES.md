# UX guideline set：来源与适用边界

研究基线 / 访问日期：**2026-10-21**。GS-01–14根据2026-10-21来源核验记录整理，沿用当时访问记录；GS-15及以后的增补另记实际核验日期。稳定 ID 不随标题更新而改变，不以新访问覆盖历史。

## 如何理解权威层级

1. **规范性标准**：GS-01 的规范性章节提供可测试要求；不等于本项目的法律义务判断或合规结论。Understanding 等解释材料不是新增规范。
2. **官方设计指导**：Google / Material、Android、IBM / Carbon 的建议依赖场景，不是强制架构或认证。
3. **产品案例**：GS-04、05 是厂商对自家产品的描述，GS-14 是私有静态样例；都不是独立用户研究或本项目效果证明。
4. **社区检查表**：GS-13 非官方，辅助检查视觉层级，不能替代无障碍标准。
5. **本项目综合方法**：UX-01–12、严重性和验收流程均是我们的选择，不能反向归称为 Google 或 IBM 的要求。
6. **研究方法**：GS-15 提供从用户目标选择测量的框架，不提供本产品的通过分数，也不能替代形成性用户研究。
7. **工程工具说明**：GS-27–30解释测试与构建工具的计时与输入语义，不是UX规范、用户延迟目标或放宽门槛的授权。

风格 token（颜色、圆角、字阶、阴影）和交互原则（范围、层级、可发现性、连续性、反馈、可访问性）分开审查。“像 Google”不是“Google 认证”，也不证明易用。

## 来源目录

| ID / 来源与作者 | 直接链接 | 原研究核验版本 / 日期 | 类型、适用范围与限制 |
|---|---|---|---|
| GS-01 — Web Content Accessibility Guidelines (WCAG) 2.2；W3C / AGWG | [当前文档](https://www.w3.org/TR/WCAG22/) · [固定版本](https://www.w3.org/TR/2024/REC-WCAG22-20241212/) | Recommendation，2024-12-12 | **规范性标准**。键盘、焦点、标签、状态、对比度、重排、错误恢复、目标大小。方法中仅摘选 A/AA 条款；组件和自动扫描通过不等于完整页面/流程符合 WCAG。逐条阅读定义与例外。 |
| GS-02 — Foundations；Google / Material Design | [来源](https://m3.material.io/foundations/) | Material 3；发布/更新日未知 | **官方设计指导**。区分可访问性、内容、布局、交互与可定制风格。不是认证，不机械移植移动端视觉惯例到管理控制台。 |
| GS-03 — App bars；Google / Material Design | [来源](https://m3.material.io/components/app-bars/) | 页面标示 M3 Expressive 更新；精确日期未知 | **官方设计指导**。识别页面和关键操作，区分导航与任务工具栏；平台变体不是桌面 Web 强制模板。 |
| GS-04 — Introducing a new homepage for Google Cloud；Google Cloud | [来源](https://cloud.google.com/blog/topics/developers-practitioners/introducing-new-homepage-google-cloud) | 精确发布日期未记录 / 未知 | **产品案例**。组织/项目身份、相关入口、可执行建议。历史改版理由，不是当前整个控制台的验收或通用导航标准；不把搜索结果相对时间写成发布日期。 |
| GS-05 — Making Application Security simple with a new unified dashboard experience；Cloudflare；Michael Tremante、Pete Thomas、Jessica Tarasoff | [来源](https://blog.cloudflare.com/new-application-security-experience/) | 发布 2025-03-20 | **产品案例**。以任务跨越产品边界，串联总览、调查、规则、设置。厂商自述收益不等于本项目收益；新旧版迁移开关不支持永久“简单/专业”双模式。 |
| GS-06 — Data table: guidelines；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) | Carbon Core 当前页；精确更新日未记录 / 未知 | **官方设计指导**。比较、工具栏、展开、选择、批量操作。表格不是电子表格替代品；跨分页选择语义需本项目另行定义。 |
| GS-07 — Forms；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/patterns/forms) | 页面更新日 2026-08-11 | **官方设计指导**。逻辑分组、说明、内联验证、可理解顺序。明确警惕用折叠/页签隐藏表单信息；渐进披露不能隐藏必填项或错误，无说明的禁用按钮不是解决方案。 |
| GS-08 — Form: accessibility；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/components/form/accessibility) | 更新 2026-09-30；测试部分 React 组件版本 1.114.0 | **官方实现指导**。标签/描述关联、必填语义、键盘可操作帮助。组件自身测试结果不能自动转移到我们的组合实现或应用合规结论。 |
| GS-09 — Notification: guidelines；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/components/notification/guidelines) | 更新 2026-09-30 | **官方设计指导**。上下文反馈、适度打断、恢复动作和持久信息入口。不能每次更新都抢焦点；实际产品状态而非 toast 动画决定是否成功。 |
| GS-10 — Empty states；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states) | 发布/更新日未知 | **官方设计指导**。区分首次使用、无匹配、错误；在内容缺位处给出下一步。避免空组件重复插画/长文，不把未知当零。 |
| GS-11 — Loading: guidelines；IBM / Carbon | [来源](https://www.carbondesignsystem.com/building-blocks/core/components/loading/guidelines) | 更新 2026-09-28 | **官方设计指导**。首次结构占位、局部进度，避免冗余转圈。延迟阈值依上下文；不虚构速度收益，只禁用处理中无效的操作，保留真正支持的取消。 |
| GS-12 — Adapt layouts；Google / Android Developers | [来源](https://developer.android.com/design/ui/mobile/guides/layout-and-content/adapt-layout) | 发布/更新日未记录 / 未知 | **官方设计指导**。按空间重排导航、筛选、内容，不整体等比缩小。移动平台原则可借鉴，不是 Web 断点配方。Material 详细布局页仅返回 JavaScript 文本，未用非官方镜像替代权威来源。 |
| GS-13 — refactoring-ui-skill；GitHub 用户 edisonmbli | [来源](https://github.com/edisonmbli/refactoring-ui-skill) | 2026-10-21 检查 live 默认分支 README；固定 commit/release 和发布日期未知 | **社区/实践检查表**。用户指定，用于层级、分组、字阶、颜色、一致性审查。非 Google/Material/IBM 官方，亦非原 Refactoring UI 作者关联项目；不是原书替代品或易用性证明。保留现有 React/Ant Design 和 token，不因阅读而授权安装脚本、迁移框架或替换设计系统。 |
| GS-14 — 用户提供的订阅转换页面快照 | 私有快照，**有意不公开 URL/HTML/账号/资产** | 提供日 2026-10-21；在线版本/原发布日期未知 | **产品案例 / 静态标记证据**。本目录仅依据匿名化 markup 审查摘要，未重新读取私有 HTML。应用分类、分组、结果列表、保存/客户端控件可启发任务连续性；不能推断渲染、交互、响应式或可访问性通过。其简单/高级分流与本项目要求冲突，明确不采用。 |

## 冲突处理与维护规则

### 2026-10-22 增补：目标与测量

**GS-15 — Measuring the User Experience on a Large Scale: User-Centered Metrics for Web Applications**；Kerry Rodden、Hilary Hutchinson、Xin Fu，CHI 2010，Google Research。[官方条目](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/) · [官方作者 PDF](https://research.google.com/pubs/archive/36299.pdf)。访问/核验：2026-10-22，官方条目与论文正文；未复制或分发论文。

类型：研究方法。借鉴 HEART 与 Goals–Signals–Metrics，以目标决定信号和测量，而不是先收集易取得的数字。用于区分任务完成、错误、效率与主观体验；不要求每个任务都测所有维度。不把自动化通过率解释为用户满意度或“Google 水准”。本项目的具体任务、严重性和验收阈值仍是项目决定，见[本轮实施简报](PRODUCT-QUALITY-ITERATION-2026-10-22.md)。本增补不改变其他来源的历史访问日期。

### 2026-10-22 增补：界面内容设计与学习资料

下列8项均于2026-10-22读取官方/原发布机构正文，记录页面显示日期而非搜索抓取时间。综合应用规则见[内容设计规则与学习路线](CONTENT-DESIGN-RULES.md)；不复制整篇原文。

| ID / 标题与组织 | 直接来源 | 页面日期/版本 | 用途与限制 |
|---|---|---|---|
| GS-16 — Writing for user interfaces；GOV.UK Service Manual / Design community | [原文](https://www.gov.uk/service-manual/design/writing-for-user-interfaces) | 发布2017-10-10，更新2018-04-16；无语义版本 | 官方服务设计指导：先减少不必要文字，标题描述功能，需要解释操作时检查界面本身。政府事务场景，不机械套用单问题页面布局，不禁止所有品牌表达。 |
| GS-17 — Hint text；DWP Design System team | [原文](https://design-system.dwp.gov.uk/guidance/hint-text) | 更新2026-07-15；无页面语义版本 | 官方指导：不是每个问题都需要hint；提示服务当前问题，必读重要信息不能降格为hint。不是禁止简短格式/术语帮助，也不是中文硬字数限制。 |
| GS-18 — Writing style；Microsoft Windows developer documentation | [原文](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style) | 更新2021-06-24；在线Windows应用指南 | 官方指导：适合扫读、按钮表示动作、对话框与错误支持决定/恢复。Windows/英文约定不是中文Web强制模板。正文可读，通用授权提示不代表本次正文受阻。 |
| GS-19 — Voice and tone；Google Developer Documentation Style Guide | [原文](https://developers.google.com/style/tone) | 更新2026-05-27 UTC；无页面语义版本 | 官方技术文档写作指导：信息优先于俏皮，减少无必要隐喻/行话。不是Material界面规范，不声称Google禁止全部界面修辞。 |
| GS-20 — Tooltip guidelines；IBM Carbon Design System | [当前原文](https://www.carbondesignsystem.com/building-blocks/core/components/tooltip/guidelines) | 更新日/独立版本未显示；旧usage入口重定向当前页 | 官方组件指导：简短补充、图标解释；完成任务必需信息不能只放tooltip。交互式补充采用适当disclosure/toggletip，不把tooltip当垃圾箱。 |
| GS-21 — Designing good questions；GOV.UK Service Manual / Design community | [原文](https://www.gov.uk/service-manual/design/designing-good-questions) | 发布2018-06-22，更新2026-06-24；无语义版本 | 官方服务指导：改问题/标签/结构，必要帮助就近放置，部分用户需要的背景可展开。复杂决定可有正式说明；“三行”等语境建议不是跨视口硬规则。 |
| GS-22 — UX Writing: Study Guide；Anna Kaley / Nielsen Norman Group | [原文](https://www.nngroup.com/articles/ux-writing-study-guide/) | 发布2024-05-08，复核2026-08-20 | 专业研究机构的学习导航：扫读、简明语言、标题与短文案。不是产品官方组件标准，也不替代本项目真实用户观察。 |
| GS-23 — UI text guidelines for SharePoint web parts；Microsoft Learn | [原文](https://learn.microsoft.com/en-us/sharepoint/dev/design/ui-text-for-web-parts) | 更新日未核验；在线SharePoint页面 | 官方产品文案指导：简单清楚、减少重复、帮助链接按需、错误支持恢复。其hint/ghost text指输入框内提示，不与DWP字段外hint混同；英文标点不照搬中文。 |

### 2026-10-23 增补 核验来源与富编辑器操作

本轮新增 GS-24/25，并于 **2026-10-23** 读取下列官方正文。访问日不是规范发布日期；保留上表历史记录，不把旧轮次全部标成重新核验。来源仅支持相应原则，实际问题与待完成验收另见[真实状态与编辑任务审查](UX-STATE-AND-EDITOR-REVIEW-2026-10-23.md)。

| ID / 来源 | 直接链接与本次核验 | 权威类型及适用边界 |
|---|---|---|
| GS-01 复核 · W3C / AGWG WCAG 2.2 | [固定 Recommendation 2024-12-12](https://www.w3.org/TR/2024/REC-WCAG22-20241212/)；访问2026-10-23 | 规范性要求。仅以已核验条款判定具体局部问题；本次文档整理不构成全页或全流程符合性审计。 |
| GS-24 · W3C WAI APG Accordion Pattern | [官方正文](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/)；访问2026-10-23；页面未显示独立版本/更新日 | 官方模式实现指导，非独立WCAG标准。披露按钮语义、展开状态、Enter/Space与Tab行为；相邻操作独立于披露按钮，不以套用组件替代实际组合测试。 |
| GS-25 · W3C WAI APG Menu Button Pattern | [官方正文](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)；访问2026-10-23；页面未显示独立版本/更新日 | 官方模式实现指导。打开、焦点和展开语义用于制定检查；初次审查的菜单即时快照不足以判定失败；后续真实生命周期发现与局部复测见UX23-C05，不能倒推早期未记录的时序。 |
| GS-10 复核 · IBM Carbon Empty states | [官方正文](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states)；访问2026-10-23；本次页面显示更新2026-08-11 | 官方设计指导。首次空、无搜索结果、错误需要不同下一步；零目标直达所需权威数据条件是本项目的安全合同，不归称为Carbon原文要求。 |
| GS-16 复核 · GOV.UK Writing for user interfaces | [官方正文](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)；访问2026-10-23；沿用先前已记录发布日期，不以本次抓取时间替代 | 官方内容设计指导。先修结构/控件，再增加短而必要的文字；不把本轮工程证据限制塞进产品状态，也不机械照搬英文句式。 |

**GS-01解释材料。** 下列 W3C WAI Understanding 正文均于2026-10-23读取；页面独立更新日未核验。它们是 informative 解释，不新增规范要求：

- [1.4.3 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)：普通活动文字按4.5:1及相应例外检查。处理不执行不代表字段不可操作；使用真实颜色、祖先透明度和背景合成。
- [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：识别控件/状态所必需的视觉信息按3:1及例外检查，不把所有装饰边框都当必要边界。
- [1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)：检查320 CSS px等效宽度及适用二维内容例外；无水平溢出不证明标题容易扫描，严重挤压也不自动等同已经建立此条违规。
- [1.4.12 Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)：检查用户覆盖间距后的内容/功能保留与语言适用性，不要求产品默认采用测试间距。
- [2.4.11 Focus Not Obscured Minimum](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)：AA要求获得焦点的组件不被作者内容完全遮住；项目希望整个操作及焦点清楚可见，是更强目标。
- [2.5.8 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)：24×24 CSS px及间距、等价、行内、用户代理、必要性例外分别判断。项目44px舒适目标不等于AA统一要求；需测实际命中区而非外层盒子。

本次未新增或重新下载社区脚本，未把GS-13改列官方。来源、项目设计规则、已复现问题、候选实现和最终复测仍须分开记录；不因参考Google/W3C而声称认证，也不为遵循建议更换React/Ant Design或重写现有框架。

### 2026-10-23同轮补充 交互生命周期 命名与测试预算

以下官方/工具维护者正文均于 **2026-10-23** 读取。不替换此前来源记录；本项目从诊断形成的方法见[第15节](UX-METHODOLOGY.md#15-整合失败如何转化为方法-而不是放宽验收)，实际结果见[验收记录](../verification/UX-STATE-EDITOR-2026-10-23.md)。

| ID / 标题与组织 | 直接来源及版本记录 | 类型与适用限制 |
|---|---|---|
| GS-25补充 · Menu and Menubar Pattern；W3C WAI APG | [官方正文](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/)；页面独立版本/更新日未显示 | 模式指导，配合既有Menu Button条目理解Escape、Tab与焦点。关闭时卸载节点是本菜单实现合同，不是APG对所有隐藏内容的要求。 |
| GS-26 · Providing Accessible Names and Descriptions；W3C WAI APG | [官方正文](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)；页面独立版本/更新日未显示 | 命名实现指导；结合可见文字、原生语义及真实计算名称检查，不机械照搬英文词数或一律增加aria-label。 |
| GS-27 · Timeouts；Microsoft Playwright | [官方文档](https://playwright.dev/docs/test-timeouts)；当前在线页，无本页固定语义版本/发布日期 | 工具说明，区分测试、断言及相关fixture/清理计时；默认值不代表本项目配置或用户响应目标，不授权延长交互等待。 |
| GS-28 · testTimeout；Vitest维护者 | [官方配置文档](https://vitest.dev/config/testtimeout)；当前在线页，更新日未显示 | 工具说明，测试总时限不等于每个用户步骤的响应时限。安装版本/实际配置和计时证据仍需单独记录；本项目不采用禁用时限来通过。 |
| GS-29 · Clipboard；Testing Library维护者 | [官方文档](https://testing-library.com/docs/user-event/clipboard/)；页面标示2024-01-12，Ernesto García | 工具输入语义。粘贴可用于真实完整内容输入；不证明OS剪贴板、真实浏览器权限或生产性能，也不允许用直接赋值替代所有键盘/选择操作。 |

GS-01同日复核：[SC 2.5.3 Label in Name](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#label-in-name)要求名称包含可见标签，[SC 4.1.2 Name Role Value](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#name-role-value)约束可确定的名称、角色和状态。稳定动作名与独立busy表达是项目应用，不能仅因名字多出loading就宣称2.5.3失败；也不声称整个应用已符合这两条。规范版本仍为2024-12-12 Recommendation。

诊断聚合、未知代码分类与不扩大敏感信息披露沿用AGENTS隐私边界、GS-09/16内容原则及真实负向回归；它们是项目决定，不附会为新WCAG要求。原始报告和测试正文不是对外guideline来源，不复制入目录。

### 2026-10-23同轮补充 分层预算与本地构建预览

以下直接官方正文于2026-10-23重新读取。无页面独立更新日/固定文档版本时如实记为未知，不用访问日期充当发布时间。

- **GS-28补充，Vitest维护者：** [vi.setConfig](https://vitest.dev/api/vi#vi-setconfig)、[vi.dynamicImportSettled](https://vitest.dev/api/vi#vi-dynamicimportsettled)、[setupFiles](https://vitest.dev/config/setupfiles)、[environment](https://vitest.dev/config/environment)。官方API说明支持当前文件运行时配置、动态导入等待、逐文件setup及jsdom标记；执行证据对应本地安装Vitest5.0.5。10秒DOM/5秒Node分层是项目授权的测试政策，不是官方推荐的UX时限；正负边界夹具与全套产品结果分开。
- **GS-30，Vite维护者，Deploying a Static Site：** [Testing the App Locally](https://vite.dev/guide/static-deploy.html#testing-the-app-locally)。官方工具说明；当前在线页，独立更新日未显示。用于界定`vite preview`是本地构建预览而非生产服务器。选择本地built前端连接真实本地后端是本项目验收lane决定，不证明生产部署、性能改善或原dev故障已修复。

### 维护规则

- 用户要求单一完整界面优先于案例的简单/高级分流；借鉴任务分组，不照搬信息架构。
- 渐进披露用于次要详情/帮助，不隐藏完成任务必需的信息、错误或关键后果。
- 社区视觉建议服从产品安全、无障碍和现有组件合同；不为视觉一致而隐瞒真实失败、权限或未知状态。
- 每条新增来源必须记录作者/组织、标题、直接 URL、已核验版本/日期或明确未知、访问日、权威类型、适用范围、限制及冲突。
- 变更时追加核验历史；记录页面迁移和规则实质变化。来源、项目决定、发现的问题、复测证据分别存放，并通过稳定 ID 关联。
- 2026-10-20 历史审查读取过 GS-13 的其他文件；这不等于 2026-10-21 研究重新核验了那些文件或固定版本。保留各自日期和范围。

下一步：[方法与验收](UX-METHODOLOGY.md) · [问题/证据登记](UX-EVIDENCE-REGISTER-2026-10-21.md) · [文档索引](README.md)

## 2026-10-23 持续审查补充：条件编辑与上下文反馈

以下来源于2026-10-23重新读取；本轮项目应用和发现见[持续审查记录](CONTINUOUS-UX-REVIEW-2026-10-23.md)，不替换历史来源或把局部通过当作整体达标。

- **GS-31 · Cloudflare Ruleset Engine，Edit expressions in the dashboard**：[官方文档](https://developers.cloudflare.com/ruleset-engine/rules-language/expressions/edit-expressions/)，页面标示更新2026-04-16。产品行为案例：构建器与完整表达式编辑的表示能力不完全一致，无法表示时须明确处理切换。项目采用“不能默默损失意图”的原则，不照搬两套模式。
- **GS-32 · GOV.UK Design System，Text input**：[官方指南](https://design-system.service.gov.uk/components/text-input/)，独立更新日期未记录。可见标签、输入后仍可理解的字段语义；placeholder不能独自承担必要标签或例子。不据此机械给所有字段添加小字。
- **GS-33 · OpenAI Help Center，Network recommendations for ChatGPT errors on web and apps**：[官方排障文档](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)，抓取只显示相对更新时间，未换算为发布时间。网络放行清单不是选择性代理规则规范，共享第三方依赖尤其不能被当作专属应用的完整识别。本轮未据此创建自动路由模板。
- **GS-09复核 · IBM Carbon，Notification guidelines**：[官方指南](https://www.carbondesignsystem.com/building-blocks/core/components/notification/guidelines)，页面标示更新2026-09-30。反馈应及时且与任务相关，并控制打断程度。项目据实际按钮命中检查选择局部状态反馈；指南本身不证明当前Ant组件有缺陷，也不授权全局删除通知。
- **GS-16复核 · GOV.UK，Writing for user interfaces**：[官方指南](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)，本次未核验独立更新日期。先改善结构、控件和用户语言，再考虑增加说明。所谓“一套完整UI”是本项目用户要求，不是该指南的逐字要求。


## 2026-10-24 确认强度与实际后果

以下直接官方正文于2026-10-24核验；独立页面更新日未核验，不把访问日当作发布日期。仅支持对应原则，不证明本项目恢复操作无风险，也不授权删除既有确认。

- **GS-34 · GOV.UK Design System，Button**：[官方指南](https://design-system.service.gov.uk/components/button/)。官方组件指导；警告按钮与额外确认对应不易撤销的严重破坏性后果，需克制使用。颜色不能代替清楚表达后果，不据操作名称自动判定危险等级。
- **GS-35 · IBM Carbon，Modal guidelines**：[官方指南](https://www.carbondesignsystem.com/building-blocks/core/components/modal/guidelines)。官方组件指导；标题和按钮表达动作，说明相关后果；danger modal针对破坏性或不可逆操作。不是所有创建操作免确认的规则。
- **GS-36 · Google Material Design 1，Confirmation & acknowledgement / Dialogs**：[确认与回执](https://m1.material.io/patterns/confirmation-acknowledgement.html) · [对话框](https://m1.material.io/components/dialogs.html)。**已归档的Material 1官方指导，非当前Material 3规范**；区分事前确认与事后回执，减少不必要打断，使用明确动作。不机械移植移动端布局，也不能据可撤销原则忽略保密与资源后果。
- **GS-37 · GOV.UK Design System，Details**：[官方指南](https://design-system.service.gov.uk/components/details/)。官方组件指导；只折叠部分用户才需要的补充内容，多数用户完成任务必需的信息保持可见。不是将全部安全后果折叠的依据。
- **GS-01补充 · W3C / WAI，Understanding SC 3.3.4（WCAG 2.1解释页）**：[错误预防](https://www.w3.org/WAI/WCAG21/Understanding/error-prevention-legal-financial-data.html)。标准解释材料，非新增规范；适用提交可通过可逆、检查纠正或审阅确认纠正等方式防错，意图不要求每次简单创建都确认。没有规定必须抄写短语；也不据此宣称本流程符合全部WCAG。保留GS-01既有WCAG 2.2规范版本登记。


### 2026-10-25 错误摘要与被动通知的语义边界

以下主来源于2026-10-25读取，不替换既有访问记录；页面独立更新日未核验，不把访问日当作发布日期。

- **GS-38 · GOV.UK Design System，Error summary**：[官方指南](https://design-system.service.gov.uk/components/error-summary/)及[官方组件实现](https://github.com/alphagov/govuk-frontend/blob/main/packages/govuk-frontend/src/govuk/components/error-summary/error-summary.mjs)。官方模式与实现指导：输入验证错误采用可聚焦的外层摘要、内层alert及字段链接。这里借鉴外层焦点与内层通知分离；服务端503恢复不是原模式的同一情境，不虚构字段错误或链接。实现读取main分支，未固定发行版本，不据此承诺长期不变。
- **GS-39 · W3C WAI APG，Alert Pattern**：[官方模式指南](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)。非规范性模式指导；被动alert不应改变键盘焦点。不能将当前操作失败的恢复交接推广为所有通知自动聚焦。
- **GS-40 · W3C，WAI-ARIA 1.2，alert / alertdialog**：[alert](https://www.w3.org/TR/wai-aria-1.2/#alert) · [alertdialog](https://www.w3.org/TR/wai-aria-1.2/#alertdialog)。2023-06-06 Recommendation，规范性角色语义及作者建议；alert具有assertive/atomic通知语义，规范明确使用 **SHOULD**：如果alert消息预期接收焦点，作者应使用alertdialog角色。但alertdialog要求相应的对话框交互，不能仅给普通内联错误换角色。外层摘要/内层alert是本项目的有边界适配，不据此宣称完整符合性、WCAG失败或辅助技术播报已验证。

本次来源指导与项目方案分开：受控浏览器证据能验证当前上下文、可见性与焦点目标，不能证明屏幕阅读器只播报一次、不会打断或所有平台表现一致。



### 2026-10-25 打开记录与条件写入

以下官方正文于2026-10-25读取；访问日不是发布日期。它们解释新鲜度/并发模型，不是界面风格或产品认证。

| ID / 来源 | 直接链接与版本 | 类型、项目应用及限制 |
|---|---|---|
| GS-41 · IETF，RFC9110 HTTP Semantics §§13.1.1–13.1.2 | [If-Match / If-None-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)；Standards Track、STD97，2022-06 | HTTP规范：条件写入避免并行覆盖；If-Match使用强实体标签比较，If-None-Match:*可保护创建。项目借鉴打开状态前置条件，但自定义JSON基线/token不是HTTP ETag/If-Match实现，不据此声称协议符合性。 |
| GS-42 · Google API Improvement Proposals，AIP154 Resource freshness validation | [官方正文](https://google.aip.dev/154)；Approved在线页，Created2019-07-24，变更记录含2021-04-01；非独立发行版 | 官方API设计指导：服务端新鲜度值、失配拒绝、声明比较语义及自定义方法请求上的validator。项目字段位置、强制guarded envelope、409/428和独立preview ticket是自身适配，不是AIP154合规或Google认证。 |

具体合同见[API说明](../verification/CONTROL-PLANE-API-NOTES.md#service-policy-opening-record-review)；真实缺陷、候选测试与像素证据在[独立验证记录](../verification/POLICY-EDIT-INTENT-2026-10-25.md)，不以来源替代产品实测。


### 2026-10-25 焦点可见性复核

**GS-01补充，非新标准。** 2026-10-25重读既有2024-12-12固定Recommendation的[SC 2.4.7 Focus Visible](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#focus-visible)和[SC 2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/TR/2024/REC-WCAG22-20241212/#focus-not-obscured-minimum)：前者涉及可见的键盘焦点指示；后者要求获得焦点的组件不被作者内容完全遮住，适用定义与例外仍须逐条判断。[WAI解释页](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)明确区分组件与外置焦点指示，属于解释材料，不是新增规范。

本项目要求当前操作及其指示清楚可见，以当前Drawer内揭示既有焦点和逐张像素审查实现，是具体适配，不把“完整四边”归称为2.4.11的统一要求。前后值的逐侧适用性来自本项目实测，不附会为WCAG条款；本轮没有新增APG模式或AT/符合性认证。见[验证记录](../verification/TEMPORAL-PLAN-DEFAULTS-2026-10-25.md)。


### 2026-10-25 身份与展示名称

以下直接官方正文于2026-10-25读取；来源与本项目实际用户组修正分开。

- **GS-43 · Google API Improvement Proposals，AIP148 Standard fields / display_name**：[官方正文](https://google.aip.dev/148#display_name)。Approved在线指导，页头Created/Updated为2020-10-06，变更记录另含2023-10-05；不是独立发行版。区分资源身份与可变、供界面阅读且不要求唯一的展示名称。项目沿用自己的ID/name字段，不照搬字段命名、长度限制或资源URI，不声称AIP合规；按读取快照冻结标签是项目自己的审阅合同。
- **GS-37复核 · GOV.UK Design System，Details**：[官方指南](https://design-system.service.gov.uk/components/details/)。官方组件指导；独立页面更新日未显示，Recent changes含2024-10组件v5.7.0，不能把它当成整页规范版本。仅少数用户需要的补充信息可展开，多数用户完成决定所需事实不能隐藏。本项目把完整ID清单置于详情，但实际新增/移除身份和必要同名消歧保持可见；不是GOV.UK要求采用本项目的比较表。

复用GS-41/42的并发前置条件边界，不另造token或把显示名称纳入记录身份。方法见[身份与展示](UX-METHODOLOGY.md#身份由标识决定名称解释当前审阅)，证据见[用户组验证](../verification/GROUP-POLICY-EDIT-2026-10-25.md)。


### 2026-10-25 模态确认的局部键盘边界

**GS-44 · W3C WAI APG，Dialog (Modal) Pattern**：[官方正文](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)，2026-10-25读取；在线页未显示独立固定版本/更新日，不以访问日充当发布日期。官方、非规范性的模式实现指导，描述当前模态层内的Tab/Shift+Tab顺序及首尾循环、Escape和关闭后焦点返回。

本项目仅据此修复授权确认的局部边界，并依据已安装组件源码保留现有Escape/遮罩及pending期间不可关闭合同；不是对所有对话框照搬处理，也不声称完整APG一致性。原生复选框与可见绘制节点分离、Wave装饰识别及向外整像素滚动是实际失败推动的项目实现，不是APG要求。焦点可见性的规范/解释区分沿用上方GS-01复核；真实AT与完整WCAG符合性未验证。结果见[局部验证记录](../verification/POLICY-MODAL-KEYBOARD-2026-10-25.md)。
