# 模板更新：实际分流变化与个人修改审阅

2026-10-24。**已在独立候选源码中完成有界验证；本文不自行宣告规范源码合入、全量验收或部署。** 合入状态由协调者的最终清单/收据决定。

## 体验与模型

更新审阅从 `rules/defaultAction` 等原始类别升级为**当前草稿 → 实际合并后草稿**：同样数量的规则也能看见域名的东京→伦敦去向变化、默认去向变化和规则顺序。模板版本本身不是 after 权威；三方合并保留个人修改后的真实候选才是。

- before 从持久化草稿独立解码，以同一 `templateInputs` 清单物化；after 使用现有成功渲染的合并候选。双方名称来自各自渲染器分配，不从前端目录补造。
- 独立解码避免浅复制共享 `Resources` 切片底层数组。原始持久化字节、合并、digest、CAS 和显式应用协议不变。
- 分流投影复用 `FrozenRoutingIntent`：单摘要64KiB、单匹配条件8KiB，按实际JSON字节计算；省略的规则/条件明确表达，不能冒充空或相同。**不是整个模板响应的大小保证。** 没有新增猜测上限或冗余digest。
- 当前草稿不能渲染时，仅 before 不可比较；成功候选仍可用于显式修复。before 错误不污染 candidate 兼容性或诊断。
- 已知个人修改只翻译现有合并报告。规则稳定ID能匹配当前摘要行时显示“当前第N条规则的修改”；删除/未收录行保留通用对象与按需身份，不拿候选位置代替当前位置。未知报告不原样回显，不宣称覆盖全部个人修改或顺序保留。
- 沿用既有比较组件，默认已发布/待发布上下文不变；模板传当前草稿/更新后标签。完整性判断由同一既有判定复用，不新建diff引擎。
- 完整分流比较不重复粗分类；不完整时仍保留服务端已经确认的类别变化。策略组/运行设置仅说明类别，不假装比较内部值、规则文件内容、客户端选择或生效状态。
- 更新仅修改选中草稿；不会自动发布订阅。原有校验、权限、原生应用、存储及合并策略未扩展。

## 可复用源码与测试清单

生产4项：
`internal/httpapi/templates.go`、`web/src/types.ts`、`web/src/RoutingSummary.tsx`、`web/src/Templates.tsx`。

测试3项：
- `internal/httpapi/templates_test.go`：追加初始公共HTTP tracer，原有测试内容保留。
- `internal/httpapi/template_routing_review_test.go`：新增4个公共HTTP合同。
- `web/src/template-update-review.dom.test.tsx`：10个 TemplatesPage 用户任务用例。

实际浏览器 `.browser.config.cjs` / `.browser.spec.cjs` 与所有运行器、原始日志、截图、hash清单是**源码树外的私有验收材料**，不作为依赖特殊环境的规范回归测试合入。本文列出的仓库测试可按通常工作区工具运行，不需要这些私有运行器。

## 从仓库根目录复验

遵循 AGENTS.md 的串行QA与本机资源约束，不在已有完整门槛运行时另启全量测试；以下是有界选择，不是 quick/full 的替代品。

```sh
scripts/go.sh test -json -p=1 -count=1 -timeout=20m ./internal/httpapi \
  -run '^(TestTemplateRoutingReview.*|TestTemplateUpdateReviewDescribesActualDraftAndMergedCandidate|TestPrivateFrozenRoutingIntent.*|TestSecondaryPresetDigestRejectsChangedSource|TestTemplatePresetReviewFencesNewDependentProfile|TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback)$'

npm --prefix web run test -- \
  src/template-update-review.dom.test.tsx \
  src/frozen-routing-intent.dom.test.tsx \
  src/frozen-routing-intent-detail.dom.test.tsx \
  src/routing-review-decisions.dom.test.tsx \
  src/template-selection-recovery.dom.test.tsx \
  --maxWorkers=1 --retry=0

npm --prefix web run typecheck
```

原有DOM10秒/其他显式预算未放宽。没有安装依赖、原生测试开关、外部源获取或客户端流量测试；正常运行仍需要工作区已有的官方Go编译器和前端依赖。

## 证据分层与结果

所有下列运行均在独立复制、精确overlay的候选上；规范源码在运行边界保持不变。使用既有QA锁、单worker、零harness retry、私有临时目录和所有权限定清理。源文件、声明的依赖/工具以及staged/tested哈希在边界核对；不宣称持续观察了整个OS或全部共享库。

| 阶段 | 实际结果 | 能说明什么 |
|---|---|---|
| 初始HTTP RED | native1；有效候选和草稿不变之后，因缺少 review 失败 | 不是未定义类型、无效fixture或兼容失败 |
| 初始DOM RED | native1；既有v2检查成功/Apply可用后，缺少“分流规则变更”列表 | 不是新标签导致的入口失败 |
| 最小GREEN | HTTP1/1、DOM1/1、typecheck，native均0 | 实际同数量规则/默认变化、精确digest显式应用 |
| 显示合同RED | native1；2个选中用例失败，8个未选中 | 缺少当前侧编号；不完整摘要误隐藏已知“分流规则已更改” |
| 有界安全GREEN | **17个Go顶层测试、72/72 DOM、typecheck**，native均0 | 下列公共合同与既有回归；不是全部工程门槛 |
| 实际构建与浏览器 | Go构建0、生产Web构建0、真实1440/390任务**2/2**，native0 | 真实后端检查/应用、实际响应驱动页面、构建产物与运行源一致 |

72项DOM明细：模板更新10、首次模板依赖恢复13、冻结分流比较18、决定审阅30、所有者详情1。全部执行，零跳过。Go选择包含既有24MiB记录边界测试；这是既有Output记录覆盖，不是新模板响应预算。原始RED已保留；wrapper退出0只表示对应收据/流程完成，不能把RED的native1写成测试通过。

4个新增HTTP合同实际验证：
1. 个人规则条件/去向修改、删除及顺序优先；未改项跟随上游，新项按现有合并追加，审阅与应用一致。
2. 当前草稿有无效组引用，但上游合并可修复；before明确不可用，candidate及显式应用成功。
3. 跟随规则资源物化使用同一当前材料；重复review/artifact/digest稳定；预览不改持久化草稿；资源head变更使旧digest应用409，新审阅后成功。
4. 模板公共接口复用敏感条件、8KiB匹配、64KiB摘要的省略与脱敏合同；实际候选产物不因摘要截断而丢失末尾规则。

## 实际浏览器与像素范围

使用独立构建的Go control-plane直接服务独立生产Web产物；仅loopback的现有临时demo模式、私有TMPDIR。通过公共登录/模板/草稿API造数，无存储注入、永久凭据、原生核心或外部网络源。两个viewport分别由正常页面Check更新，读取真实相同数量3条规则的东京→伦敦、默认→直连、当前第1条个人修改，再由指针/键盘Enter显式应用。

真实接口确认：点击Apply前选中草稿未改；提交体绑定review digest/version/bindings；仅选中草稿更新；另一草稿以及Output记录列表不变；页面没有客户端Output创建/发布请求。**Output初始为空，不构成浏览器对既有已发布订阅字节不变的证明。** 已发布内容保护另由本轮已运行的既有HTTP `TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback` 覆盖，仍不是外部客户端重载/流量证明。

每个viewport有分流、默认、保留项、决定、完成5张截图；字体/有限动画结束、下拉关闭、相关内容滚动到位后采集。1440/390的对比文字与当前序号可读；窄屏按顺序堆叠，动作可通过正常滚动到达，未发现页面/Drawer横向溢出或遮挡。身份披露打开/关闭、Apply位于视口、桌面指针与窄屏Enter已实际执行。决定截图使用程序focus检查焦点/位置，**不替代完整的自然Tab导航或全部焦点可见性审核**。

窄屏完成截图仍有既有引用表格横向滚动：动作边缘可见时目标名称在左侧屏外。这记录为既有表格局限，不以本轮分流比较通过宣称该表格已全面优化。没有继续扩张UI范围。

运行结束：两个浏览器任务均通过，构建产物/后端二进制未变，4396端口连接被拒绝，临时demo数据库目录已由服务退出清理，QA锁释放。全部10张截图存在；协调者已接受其有限决定界面范围，独立像素复核仍应按实际记录而不是用测试数替代。

## 尚未建立的结论

未运行本轮完整 quick/full、全量Go/race、所有浏览器任务、原生解析器/核心启动、真实代理流量、生产部署或客户端应用。没有外部真人理解研究或Google/WCAG整体认证。本轮本身不授权合入、发布、迁移或新增永久访问。

## 方法与来源

本轮采用项目既有[内容设计规则](../design/CONTENT-DESIGN-RULES.md)与[指导来源目录](../design/UX-GUIDELINE-SOURCES.md)；并读取工程合同AGENTS.md。内容规则是项目对来源的综合，不是外部组织的逐字标准。

工作区的恢复技能副本不存在时，2026-10-24读取固定commit的官方工程技能：
- [mattpocock/skills — tdd](https://raw.githubusercontent.com/mattpocock/skills/49dd158d1076134a641b33efb035946536778336/skills/engineering/tdd/SKILL.md)
- [mattpocock/skills — codebase-design](https://raw.githubusercontent.com/mattpocock/skills/49dd158d1076134a641b33efb035946536778336/skills/engineering/codebase-design/SKILL.md)

应用的是公共seam、先证实真实缺失再最小实现、单个vertical slice后再扩安全回归的工程方法；不把阅读来源记作已经执行全部技能流程。

从本轮实际问题归纳的可复用规则：
- **比较真实决定对象。** before与after共享一次捕获的材料；不要比较上游版本来冒充用户将得到的合并结果。
- **细节不足不抹去已知事实。** 无法逐条比较时仍显示已确认的粗粒度变化；未知不等于相同。
- **排序编号必须说明侧别。** 稳定ID决定对应关系；“当前第N条”不从候选或目录缓存反推。
- **修复不受旧坏状态挟持。** 旧侧审阅失败与新候选有效性分离，但不放松candidate校验/应用权限。
- **证据按合同分开。** 原始载荷安全、摘要覆盖、合并、权限、真实浏览器、像素与部署不是一个测试分数。

这些规则来自本项目源码/公共任务失败及修复后的证据，不宣称为Google官方标准。源外验收包名为 `template-review-proposal-20261024`，保留RED/GREEN/实际浏览器原始收据和哈希；它不是规范运行路径或产品依赖。
