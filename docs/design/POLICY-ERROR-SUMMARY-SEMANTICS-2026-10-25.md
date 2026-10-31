# 授权错误摘要：焦点容器与被动通知分开

2026-10-25。**独立的语义候选，尚未运行或合入。** 基于已验证的直接聚焦alert候选准备；不修改该候选、其首次失败记录、已完成的150项测试及8场景/18张浏览器证据。那一轮实际可见反馈与焦点改善仍有效，但不自动覆盖此变体，也不能证明屏幕阅读器播报。

## 为什么再作这一处调整

新的官方指导核对指出：GOV.UK错误摘要的脚本聚焦外层摘要，`role="alert"`在内层；APG被动alert不改变键盘焦点；WAI-ARIA 1.2建议在有意将焦点移到alert消息时考虑alertdialog。此前直接聚焦Ant Alert不能因此被称作标准alert模式。

这不是观察到的辅助技术故障，也不授权新增alertdialog或第二个模态框。已有授权任务仍需一次可发现的失败反馈；本轮只分开“任务恢复的焦点摘要”和“现有被动错误通知”。

## 唯一生产改动

仅修改 `web/src/components.tsx` 的可选ErrorNotice路径：

- 有 `focusRef` 且有当前错误：外层 `div role="group"` 用 `aria-labelledby`、`aria-describedby`分别关联**现有可见标题**“操作未完成”和**当前原始错误消息**。useId无条件调用；不复制隐藏替代文案。
- 既有 `focus()`接口与所有连接、可见性、会话工作区、当前对话框和文档焦点检查原样保留；只把原生目标从Alert改为外层摘要。仍仅在拥有者交接时设置 `tabIndex=-1`，先聚焦、后一次nearest滚动。
- 内层Ant Alert继续是被动 `role="alert"`，不接收tabIndex或focus，不新增第二个live region、dialog、按钮或恢复动作。
- `.form-error`及原20px底部间距/焦点轮廓属于外层；内层不重复该class。原Alert视觉样式继续由Ant提供，不改字体/尺寸/颜色/文案。源码预期保持几何，真实像素仍须复核。
- 无 `focusRef`：维持原直接Alert结构、字符串及class，不增加容器或ID。无错误：仍返回null。

选择group是为局部摘要提供可命名的语义容器，而非增加页面landmark。它是项目适配，不是GOV.UK逐字组件移植或播报保证。

## 明确保留

`AccessPolicy.tsx`、ServicePolicyEditor、UserPolicyEditor和styles.css均不变；当前错误/草稿版本/上下文的一次请求、503保留、409关闭后交接、编辑/重试/取消/卸载、会话与隐藏目标丢弃规则原样保留。所有payload、CAS、数值/来源/比较、分页、阻止条件、确认、草稿和未知结果文案均不动。

本轮不影响直接聚焦alert源上的另行授权真实后端任务；该任务只覆盖其声明源码，不能转移为此候选的证据。

## 本轮核对的主来源

以下于2026-10-25读取；不覆盖[既有来源目录](UX-GUIDELINE-SOURCES.md)的历史登记。链接支持相应原则，不证明本产品已符合完整标准。

| 来源 | 本轮适用范围与边界 |
|---|---|
| [GOV.UK Error summary](https://design-system.service.gov.uk/components/error-summary/)及[alphagov官方组件代码](https://raw.githubusercontent.com/alphagov/govuk-frontend/main/packages/govuk-frontend/src/govuk/components/error-summary/error-summary.mjs) | 外层摘要接收焦点、内层为alert；原模式用于输入验证并链接错误字段。这里是服务端动作失败恢复，只借用结构分离，不捏造字段链接或声称相同适用场景。main分支读取未固定版本，不冒称长期不变。 |
| [WAI-ARIA 1.2 alert](https://www.w3.org/TR/wai-aria-1.2/#alert) | 2023-06-06 Recommendation；被动alert与意图聚焦消息的语义建议。不能把已有内联错误简单改成alertdialog而缺少相应交互。 |
| [WAI APG Alert Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alert/) | 模式实现指导；alert应不干扰当前键盘焦点。本组件的任务恢复焦点由独立拥有者交给外层摘要，不推广成所有通知自动聚焦。 |

沿用AGENTS的可见焦点/保留失败草稿，以及[内容规则](CONTENT-DESIGN-RULES.md)的“错误可读，恢复可找到”和“技术原因不变成用户小字”。上述权威指导与本项目适配分别记录；没有Google认证或完整WCAG符合性结论。

## 回归与证据边界

同一19例公共工作流测试保留全部失败、草稿、准确请求、版本、确认、默认行为和生命周期证据；仅迁移聚焦目标查询/监听，并新增外层名称/描述真实关联、唯一内层被动alert、margin class位置、默认无容器及无错误输出的结构断言。所有参数化所有者、延迟响应清理和预算不变。测试源码不新增框架或内部控制器依赖。

候选RED应证明旧组件没有具名描述的独立摘要，而不是安装/类型错误。GREEN预期沿用8文件150例，数量以原生运行清单为准。候选尚未执行，不沿用旧通过数。

浏览器须重新核对首次settled错误的**外层焦点与可见性、内层alert未获焦点、两者边界/间距/轮廓**；503、409、编辑器失败以及手动返回的原有任务证据仍需保持。真实辅助技术尚未测试：被动live通知加具名焦点容器仍可能有重复或打断播报，不能仅靠DOM角色及像素宣布无重复或正确播报。

## Post-validation status — 2026-10-25

This annotation was added after validation; it is documentation, not executed source. The final fifteen-path composition uses an owned, labelled/described outer error-summary group and a passive inner alert. Earlier direct-alert focus and failed capture/test evidence remain historical, not superseded passes. Semantic DOM150, focused browser8/18 and the real saved-service preview1/2 passed within their declared scopes. See `docs/verification/POLICY-FLOW-EXPERIENCE-2026-10-25.md` for exact evidence and exclusions. Integration and the next composed full gate still require separate admission.
