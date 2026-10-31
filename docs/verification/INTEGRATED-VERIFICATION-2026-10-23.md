# 集成验证记录 — 2026-10-23

证据终态：2026-10-23 23:37:18 UTC。**整体非绿色。** 本轮覆盖节点差异审阅集成后的冻结源码；没有浏览器、native/full、线上应用或部署。通过数量不构成整体产品质量、Google 水准或无障碍符合性认证。

## 官方入口与执行恢复

1. 22:12:50 UTC 执行未修改的 `scripts/verify.sh quick`。首个“Tracked operator-state exclusion”阶段调用 `git ls-files -z`，因恢复源码没有可用 Git 元数据而退出128，官方 quick 因此退出1。该检查是已跟踪路径中的运行状态/私密产物排除规则，不是内容级秘密扫描。**Git 跟踪状态检查未验证；没有跳过后宣称通过，也没有借用旧索引或创建空索引。** 后续官方阶段在该次调用中全部未运行。归档清单/隐私检查是不同证据，不能替代此检查。
2. 协调者批准逐项独立执行其余官方命令，保留官方 quick 失败。首次独立执行的分离后台进程未跨执行沙箱生命周期存活：前四阶段持久记录退出0；格式检查进入后没有完成记录，记为中断/完成情况未知，而不是通过。该次没有运行 Web 测试。
3. 使用受支持的持久执行会话从格式检查继续。恢复前源码清单与第一次独立执行完全一致，共1076项；没有重复前四项已完成检查。整个执行持有共享 QA 锁，逐项记录命令、开始/结束和退出值；某阶段失败后仅继续独立安全阶段，不把这些结果冒称为一次官方 quick 通过。23:37:18 UTC 完成、释放锁，恢复执行退出1。

## 14个独立剩余阶段

| 阶段 | 结果 |
|---|---|
| Ticket DAG / 35项故事追踪 | 通过 |
| Ticket guard negative fixtures（9例） | 通过 |
| Architecture guard negative fixtures | 通过 |
| Production dependency direction | 通过 |
| Go formatting | 恢复执行通过；首次中断不计通过 |
| Go vet | 通过 |
| Go behavior and race tests | 失败，见下 |
| Go build | 通过 |
| Managed runtime vet | 离线依赖前提失败 |
| Managed runtime behavior and race tests | 离线依赖前提失败；未执行运行时断言 |
| Managed runtime build | 离线依赖前提失败 |
| Web typecheck | 通过 |
| Web behavior tests（完整、无筛选） | 失败，见下 |
| Web production build | 通过；保留大于500kB的现有 chunk 警告 |

合计：9通过、5失败。上述三个 managed 阶段的失败是依赖前提失败，不是已执行的产品断言失败。尚未验证的 Git 跟踪路径检查不包含在14项中。

执行保持 Go1.27.2、Node24.19.0、npm11.9.0，现有离线缓存、`GOPROXY=off`、`GOSUMDB=off`、`GOTOOLCHAIN=local`、`GOMAXPROCS=2`、`GOMEMLIMIT=768MiB`、`GOFLAGS='-buildvcs=false -p=1'`。Vitest 使用官方 `npm --prefix web run test -- --maxWorkers=1`，未配置重试即默认0；测试/钩子预算、断言和隔离设置未改。未采用 runner 输出建议的 `isolate:false`。

## Go与离线前提

Go behavior/race 原命令为 `scripts/go.sh test -race -p=1 -count=1 -timeout=20m ./...`，22:16:46–23:07:21 UTC，退出1：

- `internal/backup` 在原20分钟包预算结束时失败；活动用例 `TestStreamingBackupLedgerGrowthAndCompleteRecovery` 已运行17分45秒，进入 `Prepared.Restore`。原生栈显示 SQLite prepare/Exec 与 `Store.ImportBackup` 路径。此时最终身份、令牌索引与计数恢复断言尚未到达。没有把活动恢复工作推断为死锁，也未确立主机开销或实现算法根因；未减少原40000行数据或延长预算。
- `internal/httpapi` 的 `TestSubscriptionOriginUsesOnlyExplicitDefaultAndAdminMayMaintainIt` 收到409通用不可用结果，未满足预期成功。
- 同包 `TestBackupMultipartLargeArchiveAndEndpointDeadlines` 在首次备份 POST 收到 EOF；该例报告41.55秒，不能据此直接等同请求耗时或证明超时原因。包报告1153.300秒并退出失败，不是该包的20分钟超时。
- 其余已完成包的结果保留在阶段日志；例如 `internal/store` 通过，报告328.658秒。

Managed Xray 的 vet、race test、build 均因离线模块缺失立即失败，日志列出 `github.com/xtls/xray-core v1.260327.0`、`golang.org/x/time v0.12.0`、`google.golang.org/protobuf v1.36.11`。没有开启网络、替换版本或据此声称 native 运行成功。

## 完整 Web 终态

完整 Vitest 于23:07:33 UTC开始，报告1772.26秒：

- 101个文件：87通过、14失败。
- 1077例：1060通过、17失败。
- 17项失败中，10项明确报告原生10000ms测试期限；0项钩子超时。剩余7项为断言/元素查找失败。
- 完整终态日志没有 unhandled/uncaught 标记或 Errors 汇总行。**这不证明历史8项未捕获错误的根因已修复。** 先前924/946加8项未捕获的历史结果保持非绿色，不被本轮覆盖、相加或改写。
- 保留官方命令，没有另加 JSON reporter；终态控制台计数、完整日志与实际退出1是本轮证据。

七项非期限失败：Android审阅请求数组实得3项/预期2项；内容层级用例未找到连接数文本；公开入口用例未找到编辑按钮；发布审阅用例预期节点为空；两种来源导入手势用例未找到原始失败文本；缓存链接拒绝用例未找到原始暂停文本。失败位置不自动证明产品回归，也不授权削弱断言。精确用例及独立审阅分类保留在下述内部证据，不在此发布原始 DOM、请求体或栈。

Web生产构建随后成功，现有组件 chunk 约845.21kB，超过500kB警告阈值；未通过调高阈值消除警告。构建成功与交互、性能或完整浏览器验收是不同证据。

## 源码与构建绑定

冻结源码清单（常规源码/文档/脚本文件hash与mode，以及依赖符号链接目标）共1076项。清单不遍历依赖目标，不包含 Git、构建输出、测试报告、Python缓存或 TypeScript增量产物；不是这些排除产物的完整文件系统不变性证明。

- 原始、恢复前及终态源码清单一致；终态差异列表为空。
- `source-before.json` SHA256：`533970ca093daa0de7a3c8860322ed672905d615823990f7e4dfc1b090bcf87b`。
- 30个构建文件的 `built-assets.json` SHA256：`4f8db0271d9504a88b8addc59c008b236d4626371e71b1dbbd13daadbcc4561a`。
- 本报告在终态后于源码树外准备；不包含在上述已测源码清单中。后续修复/文档集成不能冒称已被本轮测试覆盖。

## 内部证据索引

以下是工作区相对证据包名，不是公开下载链接；原始私有日志/栈/夹具不随此报告分发：

- `integrated-quick-gate-20261023T2212/`：官方 quick 的终态receipt、Git前提诊断和未运行阶段。
- `integrated-independent-stages-20261023T2214/`：首次独立执行前四项结果、中断receipt及初始源码清单。
- `integrated-independent-resume-20261023T2215/COMBINED-SUMMARY.json`：14项合并台账和总体限制。
- 同包 `terminal-receipt.json`、`resume-source-identity.json`、`source-before.json`、`source-after.json`：恢复过程、实际终态及源码不变性。
- 同包 `web-summary.json`、`web-failure-ledger.json`：Web计数与17项原始失败分类；原始详情仅内部保存。
- 同包 `built-assets.json`：构建绑定清单。
- `ui-regression-triage-20261023/TERMINAL-CLASSIFICATION.md`：后续只读失败分类；不等同新增运行或修复通过。

下一步是逐项闭合失败与前提，而不是以新增功能或窄范围通过替代完整验收。任何后续修复应另行记录实际受测源码、原预算结果和剩余未验证项。
