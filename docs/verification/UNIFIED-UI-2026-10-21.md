# 统一界面验证记录 — 2026-10-21

> **状态更新（2026-10-22）：本页为历史记录。** 用户已授权 Chromium + Playwright；旧 Site 已删除，旧预览链接不再是可用入口。当前本地浏览器已成功启动并取得桌面/窄屏初始页截图，完整 QA 仍进行中，不是等待用户登录。最新完整集成为 339/339、34/34 文件通过；焦点失败已定位并修正测试几何模拟，浏览器验收仍未完成。见 [2026-10-22 最新记录](UNIFIED-UI-2026-10-22.md)。

**最新快照：13:26 UTC。最终私有预览已发布；第二次全量九个失败项均有后续定向通过，但没有干净的集成全量通过记录，时间稳定性未确立。当前没有待完成的测试；浏览器验收仍未完成。历史过程按时间保留，以下文末最终快照为准。**

范围：本轮前端源码/DOM 回归。真实浏览器视觉、完整键盘/辅助技术验收仍 **UNVERIFIED**（私有预览登录阻塞）。DOM 通过不等于布局、焦点覆盖、完整 WCAG 或真实部署通过。设计与问题见 [UX 证据登记](../design/UX-EVIDENCE-REGISTER-2026-10-21.md)。

## 早期结论（后续结果按时间追加，最新状态见文末）

- UX-I10 / I11 / I12 已实现修正，新增两组定向 DOM 回归各 **6/6 通过**；不能据此将问题标为浏览器验收通过。
- 首次全量结果 **320 通过 / 7 失败，共 327**（32 文件：27 通过、5 失败）。七个失败项后续按范围隔离重跑全部通过，但**不是一次全量干净通过**，也不证明先前失败根因已全部消除。
- 第二次完整套件已结束：**330 通过 / 9 失败，共 339**，仍未达到全量通过；规范类型检查和生产构建已完成，退出码 0（见下文）。没有后端或真实 VPS 验收结论。
- 修复测试夹具中的 Ant Design 测试模式重复 ID、中文双字符按钮间距匹配问题；没有削弱断言或增加 `findBy` / `waitFor` 等交互等待时限。运行器每测试总预算由默认 5 秒调整为 15 秒以适应慢环境；不能声称所有超时配置都保持不变。

## 定向回归及持久摘要

以下摘要直接来自列出的日志；将结果和用例范围保留在仓库内，不依赖 `/tmp` 的长期存在。日志的本地 `Start at` 没有时区信息，不将其换算为 UTC。

### 来源编辑 / 草稿恢复 — UX-I10、I12

测试文件：[ux-recovery.dom.test.tsx](../../web/src/ux-recovery.dom.test.tsx)。日志：`/tmp/rw-ux-recovery-rerun.log`；Vitest 5.0.5；1 文件、**6 passed (6)**，45.71 秒。

通过的范围：

1. 未改动来源关闭时不提示放弃。
2. 取消放弃保留来源值和身份；保存期间阻止关闭。
3. 新来源只有明确同意放弃才清空。
4. 草稿查询失败可见，重试后恢复继续编辑入口。
5. 输出加载/失败时，不把配置误判成未发布。
6. 浏览器导航保护只针对真实改动，包含文件加载的内容。

实现采用精确 dirty 快照（包含文件加载）；未改动导航不误弹确认；待处理 mutation/review 受到保护。上述自动测试覆盖已列路径，不推断所有真实浏览器的关闭入口和焦点行为均已验收。

### 未应用 JSON 缓冲 — UX-I11

测试文件：[json-draft-recovery.dom.test.tsx](../../web/src/json-draft-recovery.dom.test.tsx)。日志：`/tmp/rw-json-recovery-final.log`；Vitest 5.0.5；1 文件、**6 passed (6)**，33.84 秒。

配置与服务器编辑器分别验证：

1. 无效 JSON 应用失败和取消关闭后保留原文；明确放弃仅丢弃文本缓冲。
2. 应用 JSON 不冒充已保存；保存时保留同一对象身份和已有私有内容。
3. 关闭外层编辑器时保护尚未应用的文本。

运行时导航、原生焦点、弹层遮挡和视觉仍待浏览器复测。

## 首次全量与隔离重跑

| 运行 | 保留摘要 | 解释 |
|---|---|---|
| `/tmp/rw-unified-final.log` | 32 文件；27 passed / 5 failed；320 passed / 7 failed；1006.19 秒 | **失败的全量运行**，含超时；不能标记完成。 |
| `/tmp/rw-isolated-failures.log` | 4 文件；5 passed / 20 skipped；103.43 秒 | 定向过滤了五个原失败项；跳过不是通过。 |
| `/tmp/rw-source-retry.log` | 1 文件；2 passed / 30 skipped；18.92 秒 | 仅重跑两项来源行为；跳过不是通过。 |

五项隔离通过分别为：同名连接/处理阶段识别、管理区不误标私人工作区、REALITY key-first 初始化、图形测量/拖动跨路径保留而不写入路由意图、公共路径选择限制在部署范围并阻止未完成服务器变更。另两项为：失败来源表单保留并以同一身份重试、仅从授权 reveal endpoint 获取凭据。

## 原始命令与运行范围

以下为本轮保存的实际调用。工作目录为 canonical `web` 源码目录；Vitest 日志解析出的项目根路径是 `/workspace/scratch/d385eb428cee/preview-recovered/routeweaver/web`。单 worker / forks；每测试总预算 15 秒。该预算相比默认 5 秒有调整（此前慢环境运行失败），与保持原有交互断言/等待时限是两回事，不把环境影响视为已经证实的唯一失败原因。

```sh
./node_modules/.bin/vitest run --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose > /tmp/rw-unified-final.log 2>&1
./node_modules/.bin/vitest run src/task-experience.dom.test.tsx src/server-endpoint.dom.test.tsx src/server-tls-editor.dom.test.tsx src/route-graph.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose -t 'distinguishes same-name connections|does not label platform administration|limits public-path selection|field order: key-first|retains measured geometry' > /tmp/rw-isolated-failures.log 2>&1
./node_modules/.bin/vitest run src/workspace.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose -t 'retains a failed source form|explicit editing fetches credentials' > /tmp/rw-source-retry.log 2>&1
./node_modules/.bin/vitest run src/ux-recovery.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose > /tmp/rw-ux-recovery-rerun.log 2>&1
./node_modules/.bin/vitest run src/json-draft-recovery.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose > /tmp/rw-json-recovery-final.log 2>&1
./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build
```

类型检查/构建日志：`/tmp/rw-canonical-build.log`；串联命令 **退出码 0**；Vite 构建 2.21 秒，仍有压缩后 chunk 大于 500 kB 的警告，未当成失败或隐去。这是类型检查与构建通过，不是 DOM、浏览器或部署验收。后续追加当前完整套件的最终退出状态与范围，不覆盖上述失败历史。

## 私有预览发布与当前验证状态（12:52 UTC 更新）

- 私有 Site 发布成功：2026-10-21 **12:52 UTC**；[打开预览](https://routeweaver-ui-preview.garden-lake-3493.chatgpt.site)。仍需正常授权登录；部署成功不代表已经浏览器验收。
- 项目：`appgprj_6ad84d6dbce4819192e1c29c261a8c78`；提交：`4664c60378d88783549548616a1d867dd37e394c`；部署：`appgdep_6ad8b571d3608191b1c81280fc6fa3bd`。
- 预览 containment：`/tmp/rw-preview-containment.log`，1 文件 **4/4 通过**（5.69 秒）。范围：提供假库存/草稿路径、拒绝全部写入且不改变演示数据、拒绝外部请求/不支持的详情路径、仅提供演示登录状态和范围说明。
- 预览类型检查/构建：`/tmp/rw-preview-build.log`，**退出码 0**；Vite 8.13 秒，仍有大于 500 kB chunk 警告。
- 当前 canonical 完整套件：`/tmp/rw-unified-current-full.log`，**已结束：330 通过 / 9 失败，共 339**；不得用前一轮隔离通过替代当前完整结果。

## 真实浏览器验收矩阵（计划，全部 UNVERIFIED）

前提：经授权登录上述私有预览，记录实际构建、路由、假数据、视口/缩放、步骤及截图/trace。桌面以 1280 CSS px、窄屏以 375 CSS px 为代表目标，并记录实际 clientWidth/scrollWidth；桌面另测 200% 缩放，WCAG 重排另按 320 CSS px 等效宽度检查。缩放比例与实际 CSS 宽度分别记录，不互相冒充。

| 真实操作 | 视口 / 输入范围 | 期望与需要的证据 | 当前状态 |
|---|---|---|---|
| 单一导航→订阅/路由→返回；切换可用资源范围；窄屏菜单开关 | 桌面、窄屏；鼠标与 Tab/Enter/Escape | 无简单/专业模式分叉，页面身份和动作目标一致；返回保留上下文，菜单焦点可见且无陷阱。 | UNVERIFIED；登录待完成 |
| 订阅草稿→同一编辑器→来源抽屉；修改→取消关闭/明确放弃；JSON 无效应用→继续编辑/放弃 | 桌面、窄屏；键盘覆盖 X/Escape/可用遮罩路径 | 原文/对象身份保留；明确放弃才清除；外层关闭也保护未应用文本；关闭后焦点回到合理入口。 | UNVERIFIED；登录待完成 |
| 单编辑器中的保存/首次发布→再次更新；读取草稿与输出状态 | 桌面；键盘提交及恢复 | 演示写入被拒绝时必须显示失败并保留输入，不冒充成功；首次发布后绑定同一输出的真实写入流程只能在另行授权的可写测试环境验证。 | UNVERIFIED；只读预览不能证明写入/发布身份链 |
| 路由选择→上下文批量动作/策略；访问策略继承/显式/拒绝；页签切换 | 桌面、窄屏；键盘 | 对象数量与上下文明确，阶段上限不静默截断；访问语义可理解；tab 与实际面板匹配，焦点/内容可达。实际后端授权与部署不在只读演示证明范围。 | UNVERIFIED；登录待完成 |
| 表格、帮助、表单错误、焦点环与主要操作可读性 | 桌面、窄屏、200% 缩放及 320 CSS px 等效重排；键盘 | 宽表内部滚动，整页不撑破；文字/关键动作不裁切；帮助关联正确，焦点不被遮挡；测实际相邻背景对比度，而非仅用源码 token。 | UNVERIFIED；登录待完成 |
| 草稿加载/无资源/无匹配/读取失败→重试及输出未知状态 | 经授权的可控演示状态；桌面/键盘 | 不把失败/未知当零、无草稿或已发布；恢复入口持久可达。预览无法提供的状态明确记为“待可控测试环境”，不修改真实账号或绕过容器保护。 | UNVERIFIED；登录及所需状态待具备 |

只读环境可验证导航、布局、局部草稿与拒绝写入反馈；不能证明成功保存、真实部署、生产权限或多 VPS 生效。矩阵完成后逐行追加实际观察和证据，不能仅因预览可打开就将整表改为 PASS。


## 第二次完整套件：失败与后续诊断（13:13 UTC 更新）

日志：`/tmp/rw-unified-current-full.log`。使用与首次全量相同的完整命令（`--pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose`，输出改为本日志）；Vitest 5.0.5。终态：**34 文件中 27 通过 / 7 失败；339 测试中 330 通过 / 9 失败；1275.37 秒**。这是失败的完整运行，不是全量通过。原先定向 6/6 的结果仅保留为当次局部记录，不能覆盖本次出现的失败。

| 失败范围 | 本次观察 |
|---|---|
| `task-experience.dom.test.tsx` 首次使用可操作设置入口 | 初始 lazy-load 阶段未就绪；失败用例耗时 2283 ms。 |
| `server-tls-editor.dom.test.tsx` 普通 TLS 证书路径/PEM 编辑 | 达到单测试总预算 15 秒。 |
| `route-graph.dom.test.tsx` 几何/拖动保留 | 达到单测试总预算 15 秒。 |
| `server-endpoint.dom.test.tsx` 未完成变更阻止保存与显式端点身份 | 达到单测试总预算 15 秒。 |
| `json-draft-recovery.dom.test.tsx` 两项 server JSON：无效应用/取消放弃、应用与保存身份 | 两项在初始加载阶段失败；分别 3136 / 1330 ms。 |
| `ux-recovery.dom.test.tsx` 来源修改保留/保存中关闭保护 | 初始加载阶段失败，1903 ms。 |
| `source-refresh.dom.test.tsx` 首次导入失败修正、同名连接新增/移除识别 | 两项达到单测试总预算 15 秒；报告耗时 16619 / 21364 ms，不把报告耗时当新的允许预算。 |

**判断边界**：多次运行表现存在时间敏感性，但资源瓶颈只是待证假设，根因未证实；独立诊断未能查看运行器遥测，不能将所有失败归咎于环境。断言和交互等待保持不变，既有 15 秒运行器总预算也未继续放宽。

**后续仍在进行**：进行安全的 QueryClient teardown 清理后，重跑完整 `task-experience` / `source-refresh` 两个套件，再重跑其他六个失败用例。结果待追加，不预先计为通过。该测试清理不修改生产代码；生产源码自上述已部署提交以来未变更。浏览器仍待授权登录，真实视觉/交互验收继续 UNVERIFIED。


## 最新定向回归与最终构建（13:24 UTC 更新）

**结论：最终来源实现的两套完整定向回归 12/12 通过；集成全量仍没有干净通过记录。TLS PEM 单项重跑中，最终预览发布尚待确认。** 不安排第三次完整套件，不把各次局部通过相加为一次集成全量通过。浏览器仍待授权登录。

| 运行 / 持久摘要 | 结果与边界 |
|---|---|
| `/tmp/rw-query-cleanup-regression.log` | QueryClient 清理后的 `task-experience` / `source-refresh`：17 项中 **16 通过、1 来源导入超时**；2 文件 1 通过 / 1 失败；119.78 秒。失败记录保留。 |
| `/tmp/rw-current-isolated-failures.log` | 选择 6 项：**4 通过、2 失败**，另 20 skipped；5 文件中 3 通过 / 2 失败；132.23 秒。失败为 TLS 总预算超时、来源初始加载。来源项随后在最终来源回归中通过；不能覆盖此次失败历史。 |
| `/tmp/rw-source-final-regression.log` | 最终 `Sources` 实现：`ux-recovery` 六项 + `source-refresh` 六项，**2 文件、12/12 通过**；92.04 秒。包含来源修改/关闭、文件载入 dirty、草稿查询恢复、输出未知、导入失败修正与同名来源差异流程。 |
| `/tmp/rw-canonical-final-build.log` | 最终 canonical 类型检查/构建 **退出码 0**；Vite 11.24 秒；仍有 >500 kB chunk 警告。 |
| `/tmp/rw-preview-final-build.log` | 最终预览类型检查/构建 **退出码 0**；Vite 4.52 秒；同样保留 chunk 警告。 |
| `/tmp/rw-preview-final-containment.log` | 只读 containment **1 文件 4/4 通过**；6.34 秒，范围同前述假数据/拒绝写入/外部请求保护。 |

最终来源回归的实际命令：

```sh
./node_modules/.bin/vitest run src/ux-recovery.dom.test.tsx src/source-refresh.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose
```

最终来源 dirty 跟踪使用 `onValuesChange` 的布尔状态，加异步文件载入后的显式重算；不采用整个表单 watch，避免每次按键显式触发整页订阅。**未测量性能收益，不给出性能改善比例或速度结论。** 此生产实现较 12:52 已部署版本有后续更新，因此旧部署不自动代表最新源码；最终部署标识待追加。

来源首次导入用例改为模拟粘贴文本，继续验证相同来源身份及原断言；不是删除输入/恢复步骤。TLS PEM 用例正在改为模拟 PEM 粘贴后重跑，证书路径仍逐字输入，断言和交互等待不变。运行器总预算仍为此前披露的 15 秒；时间敏感性可观察，资源根因仍未证实。


## 最终冻结快照（13:26 UTC）

- **最终私有部署成功**：2026-10-21 13:26 UTC；[预览地址](https://routeweaver-ui-preview.garden-lake-3493.chatgpt.site)。提交 `9f4f332808a2f58453ee52f0de53707b0db491cd`；部署 `appgdep_6ad8bd6fc65c8191b4458e77fde3e756`；版本 `appgprj_6ad84d6dbce4819192e1c29c261a8c78~appgver_2ecbc3d20f188191a3ddd5b67048edf3`。这取代 12:52 部署作为最新预览，旧记录保留。
- 最终生产源码使用 `onValuesChange` dirty 布尔值与异步文件加载显式重算。最终构建、类型检查和 containment 结果见上节；TLS 重跑后 canonical `tsc -b` 再次退出码 0，最终 preview 类型检查也退出码 0。
- TLS 最终定向日志：`/tmp/rw-tls-final-regression.log`，**1 通过，5 未选中**；目标用例耗时 **14975 ms**，接近 15000 ms 单测试总预算。只说明此次通过，**不证明时间敏感性根因已解决或运行稳定**。
- 第二次全量的 **9 个失败项各自都有后续定向通过**；仍没有一次干净的集成全量通过。两次失败的全量记录不撤销、不改成通过；未选中/跳过项不是此次通过项。不再计划第三次全量，本快照没有运行中测试。
- **浏览器验收仍 UNVERIFIED，授权登录尚未完成**；上方真实浏览器矩阵全部待执行。部署、构建与 DOM 结果不证明实际视觉、完整键盘/辅助技术体验、成功写入或多 VPS 生效。私有预览继续使用假数据并拒绝写入。

TLS 最终实际调用（证书路径仍键入，PEM 模拟粘贴；原断言及交互等待不变）：

```sh
./node_modules/.bin/vitest run src/server-tls-editor.dom.test.tsx --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=verbose -t 'keeps certificate paths and PEM'
./node_modules/.bin/tsc -b
```

可交付结论限于：本次源码修正、列明的定向 DOM 通过、类型/构建通过、只读 containment 通过及私有发布成功。集成全量与真实浏览器仍是公开保留的验收缺口，不能写成“全部通过”或完整 WCAG 符合性。


### 最终源码对应性

canonical `web/src` 与预览对应文件逐字节比较（排除 `main.tsx`，包含测试文件）无不匹配。生产源码指纹（排除 `main.tsx` 与 `*.test.*`）：`bf3b1ad4ac846e656a8c19ff0b645919c80ad5204ba3c8985d20dcd8f097b8a0`。计算方式：相对路径排序，依次拼接 UTF-8 路径、NUL、文件字节、NUL，再取 SHA-256。预览有意保留 `main.tsx` 的演示导入及 `preview-api.ts`、`preview-only.css`；此对应性不表示预览写入能力等同正式应用。
