# 订阅更新确认：比较层级与平台入口输入刷新

日期：2026-10-23。状态：隔离候选已冻结；平台计数后端已集成，UI与本文待根协调者审查。本文是有界工程验证和专家走查，不是真人研究、厂商认证或全套绿色结论。

## 项目决定与保留边界

- 同一个「检查订阅更新」界面按任务顺序组织：完整订阅身份、次要分流配置/客户端信息、检查状态、比较结论及紧邻的覆盖边界、展开的实质规则变化、可选详情、精确目标/链接后果/显式确认。短屏用同一DOM顺序滚动，不另造手机或专家版，不让固定大页脚挤走证据。
- 「配置数量与说明」「查看待发布规则明细」「查看待发布技术配置」各有不同目的；实际规则变化默认可读，不为减少文字隐藏未知、缺失、部分比较或关键后果。创建流程和共享RoutingReview默认展示不改；`decisionReview`只限定展示，不改比较算法。
- 可选事实「将采用 N 个平台入口的最新连接信息。」只指本次检查捕获的输入更新。它不替代规则比较，不代表完整连接差异、字节变化、存活、客户端应用或native验证；不参与可发布资格。前端要求有效同对象/用途preview、version=1、正安全整数；缺失/未知/非法值不显示，绝不推断为0。
- 两个位置保留完整对象是有意的：开头辨认当前任务，决定处确认作用对象。短可见动作仍包含在完整对象的可访问名称中。

这些是项目综合选择，不是外部指南指定的布局。依据沿用[来源登记](../design/UX-GUIDELINE-SOURCES.md)：GS-16 [GOV.UK UI写作](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)支持先改善结构再补说明；GS-07 [Carbon Forms](https://www.carbondesignsystem.com/building-blocks/core/patterns/forms)用于逻辑分组和不隐藏必要信息；GS-26 [APG名称指导](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)用于核对实际名称；GS-01 [WCAG 2.2固定版本](https://www.w3.org/TR/2024/REC-WCAG22-20241212/)提供可测试要求，但局部通过不等于符合全部WCAG。登记内保留原核验日期/适用边界；本轮不声称新做厂商研究。

## 计数后端与真实响应

`platform-entry-refresh-evidence-20261023/canonical-integration-receipt.json`确认20:19:46集成四文件，均0644：

| 文件（internal/httpapi/） | SHA-256 |
|---|---|
| output_platform_entry_refresh.go | ce7edb87c55255221d461a105cff828f93185f1659a2d33b1e9a538af28356d5 |
| output_platform_entry_refresh_test.go | be7c5b228e30632db6434539b0147c296e6fc21e7f691e067745f01584616ed9 |
| output_review.go | 38d0da766ca24d7323730d3ce721ec94ef9eeebc5fcc06fb246747549ad8f1fb |
| tenant.go | 5e0e66555b5121917c14fe9fa49c37e58b5717ee602c9b5e1e4136de13bc4995 |

只比较同平台入口ID+RouteID、有效捕获凭据版本及规范小写SHA-256连接摘要，在已知portable适配器/模式中有版本或摘要变化时计数。未知/native/缺失或无法证明的旧快照/非法证明/重复身份不补事实；新增删除、导入节点、路由替换等不是完整比较。已知v1 summary即使缺少较旧的private intent仍有明确支持和测试，不将所有旧快照一概排除。原prepareOutput/digest绑定、publicationEffect和outputs.go不改，不新增持久化、轮询或自动发布。响应仅暴露version/count，不披露依赖身份、摘要或凭据。

保留修正后的HTTP RED、primary GREEN和最终有界HTTP选择日志；`backend-completion-receipt.json`记录selection_exit=0。覆盖适配器/模式、version-only/digest-only、count2、错误路由混合、零/未知/非法/duplicate/native省略及无preview发布写入。profile存储键不一致守卫仅源码审查，未单独HTTP验证；全套架构检查未重跑。

`real-owner-preview.json`是合成managed-entry轮换后的实际owner HTTP响应，SHA-256 `a4533f57410b9beb52ce230777dbf36f02135ecfc3391902b035467531472460`。相邻provenance记录：outputId=refresh-phone，valid output-update，前后nodes-only，effect preserve，count1，artifact为服务端脱敏。临时捕获测试已从集成源移除。新增DOM seam逐字节使用该响应，外部cmp及SHA-256 receipt核对原件，匹配refresh-phone/rotation-profile/mihomo 1.19.32/nodes-only选择；传输明确为mocked response-driven，不能冒称live rotation UI。`bridge-dom-2`两项选择2/2通过，typecheck=0、源码哈希不变，核对原件字节和SHA-256；保持nodes-only范围、已知链接后果和确认前无publish。未执行该响应的浏览器replay。最终真实浏览器规则/后果/焦点测试并不覆盖真实managed-entry count显示。

## 实际发现与修正

基线普通合成「日常订阅」及长名称截图表明：固定头/尾在窄短屏挤压证据，未变化结论与范围分离，动作反复携带长名字。direct-only空规则只是夹具，不推断产品规则都为空或名字有bug。新分组的DOM测试先RED再GREEN；富变化夹具仍展示顺序、去向、条件、增加/删除和默认去向，不折叠实质变化。

实际浏览器另发现Cancel后焦点掉到BODY；独立canonical基线同样RED（`update-review-focus-baseline-20261023/evidence/browser-1`）。修正将即时任务失效与关闭表面生命周期分开：同步捕获尚未禁用的入口，取消立即失效，Ant afterClose时只向仍连接/可见/可用且没有新焦点所有者的入口归还，然后调用父级续接；成功发布不走旧入口恢复。无定时器或全局焦点拦截。嵌套Access保留自己的恢复路径。

## 有界结果与保留失败

证据根：`update-review-hierarchy-candidate-20261023/evidence/`。

- `focus-dom-2`：36/36，typecheck=0，源码前后哈希不变；含count省略、无效preview、即时失效及新焦点不被抢走。
- `browser-focus-green-4`：构建/typecheck通过，**7/7**混合传输浏览器测试通过：4个真实后端任务（2个新层级用例+2个output-recovery）及3个mocked rotation-owner用例；output-recovery另包含受控access揭示失败注入，20:46:57停止；独立检查8180/4273已关闭，源码前后哈希相等。
- 16张更新review截图：普通未变化/富变化长名 × 1280×900、390×640、320×568、1280×480 × 顶部/决定区。实际Tab/Enter访问详情、wheel、touch-capable tap取消/重开/确认、焦点归还、确认前无publish、真实新旧feed及revoke→profile-delete清理。五个既有恢复用例包含嵌套Cancel/Escape/Close、reduced motion及迟到账户任务失效。
- `final-dom-1`有界回归144/145；唯一失败是新增replacement决定组断言误写成preserve动作名，独立审查指出后只修正该断言。精确Laptop修复1/1及workspace选择2/2通过，源码不变；`bridge-dom-2`重验该修正及新增响应seam，2/2通过，typecheck=0、哈希不变；未因添加seam重跑广域套件。
- 原`regressions-1` **335/343（8失败）**及workspace **1/2**保留，不覆盖为绿色。原固定footer/旧披露名期望已按命名决定组迁移。canonical Laptop轨迹证实初次preview(laptop)→显式profile save→preview(laptop)，进入/编辑/恢复本身不额外请求，无publish；修正精确序列，不把第三POST误叫第三preview。canonical Android修复仍在原10秒预算超时；三个未改profile-intent用例在广域候选lane超时，未借本轮局部通过消除。
- 保留所有早期失败：计算名称空白、焦点/滚动测试序列、0.25px底部余量、Ant中文按钮空格、canonical焦点缺陷、测试类型检查和错误DELETE清理。设置失败不算产品RED，清理不能掩盖原动作失败，见verification-notes.md。

没有重跑完整Go/Web/native/full gate；未验证物理手机滑动、全辅助技术矩阵、部署/性能或客户端应用。程序化scrollIntoView不等于触摸滚动；浏览器tap/wheel只支持所测输入结论。私有后端日志、临时demo数据库和凭据不得打包。

## 冻结与集成

`ui-manifest.json`列出28个精确UI/测试路径、哈希/模式、canonical前像和理由：5生产文件+22任务标签/比较/生命周期/浏览器测试+1实际脱敏响应fixture。已集成后端4文件仅组合验证，禁止再复制；不复制node_modules、dist/cache、生成配置或临时状态。独立审查和根协调者批准后才能集成；本文与playbook也单独待审。

## 集成回执补充

28个UI/测试/fixture文件已于 **2026-10-23T20:54:23.303390+00:00** 精确集成canonical；前像/新增不存在、后像/模式、其他文件不变均核验，平台后端4文件保持原哈希未重拷。回执：`update-review-hierarchy-candidate-20261023/evidence/canonical-integration-receipt.json`。文档独立集成时间以相邻`canonical-docs-integration-receipt.json`为准；此记录不代表full gate绿色。
