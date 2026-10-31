# 产品质量迭代验证 — 2026-10-22

状态（08:57 UTC）：**本轮界面迭代与授权范围内的本地验证完成：450项Web回归、根Go/build、15项真实任务及离线预览检查通过。** 完整static受Git索引缺失限制，见下文。持久归档回执另存，不在本文预称已提交。不是用户签收、Google质量认证、全部35故事完成或生产部署声明。此前06:32的[409项基线](UNIFIED-UI-2026-10-22.md)属于旧构建，不能替代本记录。

## 改动范围

- 单一配置→独立客户端订阅关系清单，搜索与有界分页；无任意首项概览，无列表逐行编译。
- 同一编辑器先呈现连接与默认流量意图，详细规则/组/原生与诊断保留；导入不自动改出口。
- 已知摘要变化并列呈现，等数量/同名不假称完整内容相同；精简发布审阅的重复层级。
- 修正未知关联误当零、直达检查使用旧生命周期状态、打开动画覆盖输入；保留冻结身份、明确发布目标与回执恢复。

来源、问题和方法分别记录于 [GS目录](../design/UX-GUIDELINE-SOURCES.md)、[UX-I24–29](../design/UX-EVIDENCE-REGISTER-2026-10-21.md)、[迭代合同](../design/PRODUCT-QUALITY-ITERATION-2026-10-22.md)。不将代码通过写成真实人类的一眼理解。

## 工程门槛

运行：08:33:28–08:38:48 UTC，串行、既有依赖、无新安装。完整原始日志与清单保存在工作区外部临时证据目录 `/tmp/routeweaver-quality-regressions-20261022T083328Z/`，本文件保留可复用结论，不归档原始敏感 trace。

| 命令/范围 | 结果 |
|---|---|
| web：`npm test -- --maxWorkers=1` | **450/450、46/46文件通过**；Vitest240.82秒，wall241.35秒。覆盖最终强化的全局原生绑定警告、输入保留与旧行为迁移。 |
| 根模块：`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local ./scripts/go.sh test -p 1 ./...` | **21个有测试package通过**（19缓存），3个无测试package；22.075秒。 |
| web：`npm run build` | **tsc+Vite通过**；3352模块、1.804秒。保留大chunk提示：model843.86kB / gzip271.12kB；不是整包性能提升测量。 |
| 完整 `verify.sh static` | **未通过/环境阻塞**：首个tracked-private-files步骤需要Git索引，恢复树无Git metadata，`git ls-files -z`退出128；未伪造仓库。 |
| 单独执行静态子检查 | Ticket DAG/35故事映射（24本地tickets）、9项Python负例、architecture负例package、production import方向均通过；不冒充完整static门槛。 |

467个原有受检源码文件逐字节未变，9个配置/lock文件未变。原始after清单有471文件，差异仅4个新生成的 `scripts/__pycache__/*.pyc`；排除明确生成缓存后的源码清单一致，SHA-256 `df20f9aa5c486713fdaf809c5dfa05f5b6d485848fb14c0049e0aca8baff32cf`。保留原始差异，不称原始清单相同。测试期间浏览器spec由独立流程准备，不属于此生产源码清单。

未运行/不由以上命令证明：nested `runtimes/xray`、race、vet、native parser/process/真实流量、完整release/package smoke、外部部署。无Git门槛限制与UX浏览器证据分别报告，不再当作云端登录问题。

## 真实界面阶段证据

均为本地实际UI+Go `--demo`、合成数据、loopback、沙箱浏览器；不使用真实VPS/外部账号。当前阶段路径在工作区 `qa-runtime/real-product-journeys/`。

1. **stage1**：双Output更新通过；首次非零导入任务因390首屏去向不可见失败，未到发布。运行中有一处未知关联按钮文字修正，不称完全不可变构建。
2. **stage2**：移动去向完整可见且至少44px，双Output通过；首用发现打开动画覆盖新名称，未发布。前后源码一致。另有创建摘要region定位迁移，与真实输入丢失分开记录。
3. **stage3：3/3通过**，前后源码一致。endpoint/direct首用都保留自定义名，仅新增一个配置/一个Output并即时取得交付内容；实际冻结sing-box包含两个合成节点，`route.final`分别指向所选North Gate / direct。双Output仅更新所选对象，另一个冻结身份/内容保持不变。

stage3的1440编辑器、1280关系清单、390意图与审阅截图经实际像素检查；默认去向完整可见、重复预览标题移除、明确目标和前后值/确认可辨认，移动确认按钮至少44px。44是项目舒适目标，不是WCAG AA统一阈值。可见与正确不等于真实人类首次理解。

服务正常退出并清理各阶段观测到的临时demo数据目录。截图/trace仅留本地，不放入代码或方法归档；无生产流量结论。

## 完整真实矩阵与视口检查

最终统一运行 **15/15通过、约1.8分钟、1 worker**，目录 `qa-runtime/real-product-journeys/quality-iteration-complete15/`。运行前后源码清单SHA-256均为 `94c03234e82d7806e9c26b61662bc545ea55b16d3debcc7b37b1fd2c638c3838`。

- 保留原11项任务，包括自然Back/Forward取消、一次全局接受放弃、来源失败恢复、原生/JSON保留、指定Output更新与新建、操作员不执行的上下文计划；另有endpoint/direct首用、同数量不同规则的诚实审阅、25配置/100独立订阅。
- 大清单实际走过配置/链接分页、客户端名查找、明确详情、重名不同ID、无匹配恢复、长名、撤销/孤立引用；列表/搜索/分页不发起preview编译，status仅由明确打开的对象触发。不是容量或性能上限声明。
- 清单、意图编辑、发布审阅分别检查320 CSS px重排与200%文字尺寸模拟，实际字体计算值增大2倍，关键动作可滚动到达，未见所测状态的整页横溢出或文本裁切。文字模拟先快照computed尺寸再按元素调整并恢复，不是浏览器原生zoom；未声称15条任务与所有视口的全笛卡尔积、完整WCAG符合性或真人无障碍研究。
- 实际像素复核覆盖桌面与移动，包括明确对象关系、流量去向、对照与确认。服务/端口退出，观测到的最后demo目录自动清理。

中间完整尝试保留：首次13/15，失败是把radio的非文本value当文字测量、seed缺少公共schema要求的endpoint origin；第二次14/15，失败是错误假设两个重名ID同在分页第一页。修正测量分类、合法fixture和真实搜索操作，不放宽产品断言、不扩大页大小、不改后端约束。最终统一15项重新通过。对应目录 `quality-iteration-full15/` 及后续阶段记录保持历史，不改写成通过。

## 离线预览与保存边界

08:54–08:55的离线预览同步108个canonical src文件，差异仅两行bootstrap导入及preview专用adapter/CSS；前后canonical hashes一致。类型/构建通过、containment **10/10**、沙箱真实浏览器只读smoke **5/5**，390px无整页溢出，拒绝保存后保留名称，无API/外部请求或pageerror。`SOURCE-SYNC.json` SHA-256：`d3d250c6bc3923774deefa86873f86a1c5d469aa50523e9683c2449a9eecabec`。具体记录在预览 `VALIDATION.md`；只读模拟不代替真实后端证据。

Site保持删除，仅用户要求检查发布时才部署。用户08:48请求当前截图后，仅按请求发送两张真实页面PNG（合成数据），未部署站点、未发送代码文档。源码/方法/预览归档使用原有Library身份，完成情况以独立最终回执为准；本记录不预报上传成功。没有人类无提示可用性样本、可靠任务效率基线或外部客户端联网证据。
