# 凭据轮换后的同一订阅恢复

记录日：2026-10-23；证据截点：19:17 UTC。**有界验证；15个代码/测试/配置文件已于19:15:49 UTC精确集成，最终源码审查已接受；本次文档补丁待审阅，归档待完成。** 本记录只覆盖本地合成 HTTP 与构建浏览器任务；没有真实凭据、外部账户、native 应用或部署。整套 924/946 加 8 项未捕获错误的历史结果仍非绿色。

## 问题 → 决策 → 可复用方法

以下是项目综合方法，不是 Google 认证、来源原文或真人研究结论。

| 已观察问题 / 边界 | 决策与应保留的不变量 | 复测方式 |
|---|---|---|
| 已发布 Output 的冻结平台凭据过期，最终 feed 拒绝，但取订阅仍返回看似可用的链接 | 发布历史不等于当前可交付。先验证所有权、账户、授权和当前身份，再判断当前凭据的完整确认；旧冻结快照不能证明当前 grant 可用。 | 轮换前后分别读 access 与最终 feed；缺少确认、当前已确认但冻结依赖过期、修复后可交付分开断言。 |
| 轮换后只有瞬时通知，管理员行中没有持续恢复入口；已知线路仍显示裸 ID | 同一行保留可见状态、命名线路及“检查并应用路径”；沿用准确路径/线路/用户，不自动应用。managed 与 legacy 名称空间分开，同字符串 ID 不互相借名。 | 通知消失后从 Users 与线路详情继续；已知managed/legacy同字符串ID冲突有浏览器覆盖；缺少名称元数据时回退ID仅经源码审阅，未单独运行验证。 |
| 390px 下名称逐字折行、动作被裁剪 | 使用一套响应式行结构重排身份、状态和动作，不复制两套移动/桌面任务逻辑，也不让水平滚动隐藏唯一恢复入口。 | 桌面及窄屏实际像素、名称可读性和所有行动边界分别检查。 |
| 关闭即卸载阻断组件最终关闭回调；晚到回调或通知仍属于旧任务 | **任务所有权可以先结束，视觉关闭生命周期必须完成。** 立即阻止旧任务更新/通知/重开，同时保留受支持的关闭生命周期，将焦点交还仍有效的原触发器。服务端写入不因此被声称取消。 | Close、Escape、嵌套取消、重新打开、账户切换、晚到读/发布/剪贴板结果；真实普通与减少动画分别测。 |
| 显式重新核对替换了原控件，使焦点掉到 BODY；异步恢复可能抢走新意图 | 用户发起重新核对时，同步聚焦稳定的命名状态区域，再开始读取；网络完成只更新内容，不延迟抢焦点。 | 焦点在读取前后保持，下一 Tab 到正确恢复动作；离开后无焦点回夺。 |
| loading 装饰改变动作可访问名称，局部操作的忙碌范围不清 | 保持稳定动作名称，仅目标行显示 busy；保守地禁用同一用户入口任务中的其他变更/导航。该取舍避免冲突，不表示其他行仍可操作。 | 核对精确可访问名称、仅目标行 busy及同任务冲突操作受阻；不将局部busy展示误报为其他行可用。 |

## 安全状态合同

- `/me/outputs/{id}/access` 仅在所有权、账户、授权与身份检查后返回 owner-safe 就绪信息。已知 HTTP409 **且精确代码** `OUTPUT_ENTRY_UNCONFIRMED` 表示当前入口缺少所需确认，显示“平台入口尚未确认可用”与“重新核对”。不能从通用 auth/session403、错误文字或任何409猜测此状态；缺少证明也不等于已证明物理上未应用，不建议盲目应用。
- `OUTPUT_REPUBLISH_REQUIRED` 仅用于当前入口已完整确认可用、同身份的冻结版本/摘要过期。显示“此订阅需要更新”，从“检查更新”进入原 Output 的既有预览与独立确认。保持 ID、链接、target、mode 和未选择兄弟 Output，不新建、不轮换链接、不自动保存或发布。
- 所有依赖先校验授权及身份；未知/无效/不可用优先于预期未确认，未确认优先于可修复的冻结版本差异。依赖顺序不能改变结论；冻结 RouteID 不匹配不是凭据轮换。撤销、缺失 grant、丢失授权及未知读取错误不提供猜测的更新建议。
- 已知阻塞不返回链接、token、凭据或敏感身份。未知读取/解码保持固定通用503；既有 feed/bundle 最终授权保持通用403，正常 access 保持200形状。GET 无写入；检查是当时观察，不保证之后客户端持续可用。

## 有界证据与保留失败

证据目录均为工作区内部定位，不随本文分发原始 trace、响应、夹具或认证材料。

| 证据 / 终态 UTC | 结论与限制 |
|---|---|
| HTTP corrected tracer，17:58:40 | 真实公共 handler + 合成 transport 复现 access200 与旧 feed403 的不一致；原 Output 显式修复保持身份/target/mode/link/兄弟对象。更早 UTC 时区夹具错误不是产品 RED。 |
| HTTP 有界回归，18:40:50 | 20 个父测试及 40 个子例通过，0 skip；包含新的6个父用例。不是两批相加，也不是完整 HTTP/native 套件。 |
| 构建浏览器 baseline，18:24:14 | 1280/390 两任务到达轮换后缺少持续入口的失败；390 像素还证实名称折行与动作剪裁。更早 cwd/config 启动失败不是产品证据。 |
| 最终冻结源构建浏览器，19:04:55 | 精确6任务全部通过：普通/减少动画 owner 恢复、旧账户迟到响应、Users1280/390、线路详情390。包含同一 Output 显式更新、取消/最终关闭/后续 Escape 焦点、稳定命名与窄屏行动边界。 |
| 既有 DOM 兼容选择，19:11:16 | 7文件中25个展开用例通过；74个未选择（runner 显示 skipped），不能计作通过或完整套件。 |
| 新16个组件 seam，19:12:19 | 修订16/16通过；最终TypeScript于19:11:54通过。原19:03:30运行15/16与 jsdom `motion:false` 取消焦点差异保留，未修复或宣称无害。经审阅批准，仅取消activeElement断言迁移至必需的实际普通/减少动画浏览器任务；DOM仍保留取消无写入、原对象/目标/模式、原阻塞上下文、读取次数及新焦点不被抢夺。 |

保留中间失败：18:43:15 的9通过/3失败及1项未捕获错误（包含真实取消焦点与迟到 revoke 拒绝）；18:50:03 的1/5（标签与前置问题）；18:56:10 的1/5（真实最终 Close 丢焦点、框架 loading 名称和错误等待装饰）；测试专属类型错误时没有执行测试。最终浏览器通过不抹去这些失败，也不证明原 DOM 整套可靠性问题已解决。

实际像素审查限于命名入口、阻塞状态、恢复与还原 access。普通动画部分 review/access 截图处在过渡中，不用作呈现签收；减少动画截图已稳定。合成 review 未提供完整路由摘要，其重复不可用回退不是最终 impact-review 层级通过证据。未做屏幕阅读器研究、真人理解研究、完整 WCAG 符合性或所有浏览器认证。

内部证据锚点（相对于工作区根）：

- `rotation-recovery-design-20261023/CONTRACT.md`：原合同、授权与身份优先级。
- `rotation-recovery-evidence-20261023/REPORT.md`：失败历史、追加终态与分层结果。
- `rotation-recovery-evidence-20261023/http-bounded-regression/receipt.json`：18:40:50结果及后端受测hash。
- `rotation-recovery-evidence-20261023/ui-final-ownership-freeze.json`、`browser-final-ownership.log`（后者同目录）：浏览器受测源绑定及6任务终态；测试后续迁移不得冒称同一测试hash。
- `rotation-recovery-evidence-20261023/ui-bounded-compatibility-scope-corrected.log`、`ui-compatibility-binding.json`（同目录）：25例选择、源绑定及终态。
- `rotation-recovery-evidence-20261023/verification-summary.json`、`FOCUS-COVERAGE-MAPPING.md`、`ui-final-coverage-mapped-freeze.json`、`ui-sixteen-coverage-mapped.log`（同目录）：修订16例终态、测试hash及焦点覆盖迁移边界。
- `continuation-readiness-triage-20261023/README.md`：全套非绿色与其他诊断的独立状态。

## 来源依据（沿用原核验，不新增访问声明）

完整权威分类、版本与历史日期保留于[来源登记](../design/UX-GUIDELINE-SOURCES.md)，本补丁不修改它。本次只是整理已提供的来源记录，未重新抓取外部网页。

- GS-09：[IBM Carbon Notification guidelines](https://www.carbondesignsystem.com/building-blocks/core/components/notification/guidelines)，原访问2026-10-21、另有2026-10-23复核；页面记录更新2026-09-30。支持及时、相关且适度打断的反馈，不规定本项目的恢复代码或路由。
- GS-10：[Carbon Empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states)，原访问2026-10-21、复核2026-10-23；支持区分未知/错误与相应下一步。GS-11：[Carbon Loading](https://www.carbondesignsystem.com/building-blocks/core/components/loading/guidelines)，原访问2026-10-21、记录更新2026-09-28；支持局部等待，不定义任务所有权实现。
- GS-12：[Android Adapt layouts](https://developer.android.com/design/ui/mobile/guides/layout-and-content/adapt-layout)，原访问2026-10-21、更新日未知；是平台设计指导，不是 Web 断点配方。GS-16：[GOV.UK Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)，原核验2026-10-22、复核2026-10-23；先改善结构和控件，而非增加解释。
- GS-01：[WCAG 2.2 固定 Recommendation](https://www.w3.org/TR/2024/REC-WCAG22-20241212/)，版本2024-12-12，原访问2026-10-21、复核2026-10-23；相关键盘、焦点、重排、名称与状态条款仍需逐项判断。GS-26：[WAI APG Names and Descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)，访问2026-10-23、独立更新日未知，是实现指导。稳定命名/独立 busy 是项目综合方案，不因框架名称带 loading 就宣称 WCAG 失败。

最终源码审查已接受；`rotation-recovery-evidence-20261023/canonical-integration-receipt.json`记录19:15:49 UTC的15文件精确集成，包含前镜像、新文件缺席、hash/mode及其他文件不变检查。本次三文档补丁仍待独立审阅/集成，归档待完成；不据代码集成宣称归档或部署。来源原则、候选实现、有界通过和完整验收始终分开。
