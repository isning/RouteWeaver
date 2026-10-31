# 授权失败反馈：当前上下文的一次焦点交接

2026-10-25。**分阶段候选，尚未执行、合入或验收。** 本轮是已冻结来源层级候选的增量，不覆盖原候选或其失败证据，也不改变授权内容设计与比较布局。

## 真实问题，而非补拍方法

原候选的窄屏 `busy503` 首个 settled 失败画面中，错误摘要位于 y=-642、高119.14px，390×844视口不可见；焦点仍在 y=785.70 的已恢复可用“更新授权”按钮。原始 `first-error-unmoved-narrow.png` 与 `candidate-receipt.json` 分别为 SHA-256 `4627e60c1fb86aaf728c5e1642d69d77773a0bd1584276aa3633494833f6d548`、`e8972403ee0c13d6905e3a769526091105ee844771577d2164ea4cb78a9f1fab`。它们位于 `policy-source-hierarchy-proposal-20261025/browser/run/results/candidate-source-hierarchy-busy503-narrow/`。人工后续滚动不能证明首次反馈可发现。

原显示结果 `DISPLAY-RESULT.json`（`81b79bfaf95d21d47ca037be603f063befc86af90f3e73d2c930b43d41ab7e35`）保持 FAILED，不能因修复准备而重写。这个真实恢复问题与两项截图几何断言失败分别记录。此前131项组件/模型测试通过不证明首次真实浏览器反馈可见；桌面与窄屏均须复核。

## 一个局部方案

保留既有真实错误摘要，只在当前动作失败落定时，将焦点和滚动一次交给它。不是增加 toast、底部错误副本或全局自动聚焦。

| 动作结果 | 错误唯一拥有者 | 交接时机 |
|---|---|---|
| 预览失败 | 当前编辑器 | 本次失败落定且版本仍属当前草稿 |
| 非409的更新失败，审阅保留 | 当前授权审阅 | 更新落定后；同一确认和草稿保留 |
| 409要求重新预览 | 当前编辑器 | 审阅关闭且组件完成原有焦点恢复之后 |
| 401/403 | 沿用既有会话恢复 | 本能力不抢焦点，不添加另一套会话状态 |

审阅存在时，父编辑器不重复渲染同一错误；返回编辑后错误仍可读，但手动返回不会重新触发失败聚焦。409沿用现有清除审阅/同意逻辑，下一次审阅仍需重新同意。

`ErrorNotice`只新增可选原生焦点句柄；普通调用者仍不自动聚焦，也不新增 tabindex。授权 hook明确选择编辑器或审阅的句柄。只有实际交接才令原生 alert可程序聚焦，先 `focus({preventScroll:true})`，确认焦点落到它后再一次 `scrollIntoView({block:"nearest",inline:"nearest"})`。聚焦摘要有可见轮廓。

请求由错误对象、草稿版本和当前上下文共同限定；调用前先消费，避免StrictMode及普通目录/值重渲染重复抢焦点。新提案、编辑、成功、手动关闭或组件卸载结束其生命周期。目标断开、隐藏、inert、aria-hidden、会话工作区busy、CSS不可见、文档未获焦点或当前焦点属于另一对话框时，丢弃而不延后重放。只有已知的409关闭生命周期可以等待；不用轮询、全局观察器或任意后续渲染重试。

## 源码依据与保持不变

- 现有 `usePolicyChange`已有草稿版本、冻结提案、预览/更新mutation、409与503不同恢复语义。新增状态仅拥有反馈，不改变请求内容、CAS版本、错误正文或是否提交的判断。
- 安装的 rc-dialog在 `doClose`恢复触发点后调用 `afterOpenChange(false)`；使用该已知生命周期，不全局禁用正常焦点恢复。实际动画行为仍须浏览器证明。
- 安装的 Ant Design `AlertRef.nativeElement`提供实际摘要节点，Alert不转发tabIndex；可选句柄在明确交接时设置，不增加替代包装摘要。
- `SessionBoundary`已有按accountEpoch重建的私有工作区和hidden/inert/aria-busy约束；API已有401/403恢复。生产hook不引入会话provider依赖。旧账号响应不应穿透新账号，由既有生命周期及回归共同约束。
- 授权差异投影、全部数值与来源、分页、零影响/阻止规则、冻结目标、明确同意、更新动作、未知结果文案、错误后草稿/确认保留、原始关闭/重试守卫和失效通知时机保持。没有发布、部署、网络协议或后端改动。

## 指导来源与项目综合

沿用[来源登记](UX-GUIDELINE-SOURCES.md)，不新增认证或宣称整体Google/WCAG达标：

- **项目规则**：[CONTENT-DESIGN-RULES](CONTENT-DESIGN-RULES.md)的“错误可读，恢复可找到”“返回父任务后检查动画结束时的实际焦点”及“技术原因不变成用户小字”；AGENTS要求失败保留表单、真实错误和可见焦点。
- **GS-07，IBM Carbon Forms**：[官方指南](https://www.carbondesignsystem.com/building-blocks/core/patterns/forms)，本轮2026-10-25复核。按任务组织输入和验证，不能通过披露隐藏所需错误。它不规定本项目mutation或组件生命周期。
- **GS-01，W3C解释材料**：[Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)，2026-10-25复核。获焦点组件不应被作者内容完全遮住；解释材料非新增规范。此处“失败首先可发现、摘要适当聚焦并可读”是项目更具体的恢复目标，不能仅凭这张截图直接宣称某条完整符合性结论。

**项目综合**：一次失败由一个当前上下文拥有，当前错误摘要同时承担可见与键盘反馈；失败通知生命周期和一般渲染生命周期分开。无需用更多文字弥补不可发现的状态。

## 公共缝隙回归与待验收

新增文件 `web/src/policy-error-focus.dom.test.tsx`，静态预期19例（9普通、2编辑器类型、6隐藏/非活动条件、2认证状态），不是运行通过数。使用真实公共编辑器、原生焦点和HTTP边界，原生beforeEach拥有测试生命周期；StrictMode保留。不修改旧测试、超时、重试或断言预算。

覆盖：保留审阅503的唯一错误/焦点/原始payload/确认/草稿；每次重试一次且目录重渲染不抢焦点；预览失败继续编辑；409关闭后交接及重新同意；组/用户编辑器；过期草稿错误；隐藏/inert/非活动工作区不重放；另一活动对话框；401/403；卸载；旧账号响应；普通ErrorNotice负对照。测试专用HTTP延迟响应在本例结束时有清理所有者，不引入运行时等待框架。

建议RED只执行首例，旧候选应在“实际错误已出现，但不是document.activeElement”处失败，而不是类型/夹具准备失败。GREEN可重跑此前7文件131例加新19例，静态预期8文件150例，最终数量以原生运行清单为准；公共ErrorNotice及会话邻接用例由运行协调者按范围纳入。

**关键验收仍待真实浏览器**：503与409桌面/窄屏，在操作完成后的首次settled画面、任何摄影滚动/定位之前，记录实际焦点和摘要几何；摘要可见、处于正确上下文，草稿/确认保持正确，409不与关闭动画争抢焦点。组件focus成功不替代这一证据。原来源层级/配对布局的实际像素判断继续独立保留。

## Post-validation status — 2026-10-25

This annotation was added after validation; it is documentation, not executed source. The final fifteen-path composition uses an owned, labelled/described outer error-summary group and a passive inner alert. Earlier direct-alert focus and failed capture/test evidence remain historical, not superseded passes. Semantic DOM150, focused browser8/18 and the real saved-service preview1/2 passed within their declared scopes. See `docs/verification/POLICY-FLOW-EXPERIENCE-2026-10-25.md` for exact evidence and exclusions. Integration and the next composed full gate still require separate admission.
