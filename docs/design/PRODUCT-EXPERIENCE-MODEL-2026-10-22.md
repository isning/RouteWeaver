# 产品体验模型与本轮实施规格 — 2026-10-22

状态：**实施规格，非完成声明。** 本文依据当前 canonical 源码、已渲染截图，以及本轮浏览器实际操作审查制定；不是用户可用性实验结果，不以自动测试数量证明易用性。审查基线约为 2026-10-22 05:03–05:11 UTC；行号及旧界面描述属于审查时点，后续实现可能改变。

用户明确要求：重点是产品体验、UX 设计与建模；一套完整 UI，不做简单/高级两套产品；批量变更融入日常对象与任务。本文将这些要求落实为入口、对象、状态和转换，而非只调整颜色与标签。

## 1. 一个心智模型

> 用户维护分流配置，为不同客户端发布独立订阅。管理员管理可授权的线路；线路引用服务器上的转发路径。变更从所属对象发起，在统一执行记录中跟踪。

这是一套工作界面的任务模型，不是数据库实体合并：

| 用户面对的对象 | 现有后端实体与关系 | 需要显式保留的边界 |
| --- | --- | --- |
| 我的订阅工作台中的一份分流配置 | 一个 `Profile`，零到多个 `Output` | 工作配置可独立保存；没有发布链接也必须可达。 |
| 客户端订阅 | 一个 `Output`，引用一个 Profile；有独立 target、mode、身份、凭据及冻结产物 | 同配置的不同链接可分别发布、撤销、轮换；不能静默复制或统一覆盖。 |
| 连接来源 | 用户自己的 `Source` 及已接受快照 | 来源更新、私有权限、解析失败和候选接受独立存在；不自动进入服务器线路。 |
| 可复用节点整理 | `Collection`：按来源处理、有序合并、合并后处理 | 是整理配方和引用关系，不是每份配置必须额外建立的容器。 |
| 线路 | `PublishedRoute` 引用 `ServerDeployment` 与其中的端点顺序 | 对外地址、可用状态、用户访问与服务器路径各有状态；“公开”不等于任何人可用。 |
| 转发路径 | `ServerDeployment` 草稿及其所需运行实例 | 可被多条公开线路引用；修改共享路径必须说明影响，不能随线路视图合并身份。 |
| 服务器及其监听端点 | Host → CoreInstance → ManagedEndpoint | 核心实例是运行、升级、重启与失败的边界，不是可以随意隐藏或合并的技术细节。 |
| 用户访问 | EffectivePolicy / Entitlement + 独立入口凭据 + 实际部署确认 | 获权不等于凭据已准备，凭据准备不等于节点已生效，停止订阅交付不等于已下载凭据已被节点撤销。 |
| 变更任务 | Fleet batch / 直接应用及现有执行观察 | 创建计划、排队、应用、已观察到生效、失败、未知是不同状态。 |

## 2. 本轮优先问题及证据

### P1-A：同一配置的发布语义取决于入口，而非用户明确决定

三处顶级导航“我的订阅 / 客户端配置 / 发布管理”分别暴露同一关系。`ProfilesPage` 打开 `ProfileEditor` 时不传 Output（审查基线 `Profiles.tsx:107–113`）；订阅入口传入 Output；编辑器据 `boundOutput` 决定“更新原订阅”还是“发布新订阅”（`:400–407`）。截图 `subscriptions-1440.png`、`inventory-profiles-1440.png`、`inventory-outputs-1440.png`、`subscription-editor.png` 证实入口与操作并列。

风险不是按钮过多本身，而是用户必须记住入口来判断是否会创建新链接。

### P1-B：开通线路要求用户手工执行后端依赖顺序

`PublishedRoutes.tsx:332–339` 保存后以成功消息说明“确认授权 → 创建用户入口 → 检查并应用路径”；`:663–724` 再引导跨用户、方案、路径页面；详情 `:825–826` 只说明去其他模块查看。截图 `published-routes-1440.png`、`public-route-edit.png`、`route-detail.png` 与实际操作记录支持此问题。

用户中断后缺少“已完成什么 / 尚缺什么 / 下一步”的同对象恢复入口。填写完整后保存按钮仍禁用、必须先检查的依赖，也应显式呈现而非让用户猜测。

### P1-C：节点集合选择展示了错误层级的候选范围

`Profiles.tsx:263–283` 从集合引用的 Source snapshot 汇总原始节点，没有执行集合处理；`:630` 将其称为“选中连接”，同一列表用于策略组的节点选项。后端真正发布时会执行处理。因此过滤、去重、重命名后的实际节点可能与编辑器候选不一致。

这是源码确认的推导问题；带处理集合的浏览器复现和修复验收仍需补齐。优先使用下文现有只读计算合同修正，不在前端重写处理引擎。

### P1-D：已发布的高级配置缺少可信只读视图

`RoutingSummary.tsx` 对 advanced/native-override 提示进入完整配置。当前 Profile 可已修改，不能代表冻结发布。旧的“高级配置请去编辑查看”同时增加任务成本并混淆当前生效内容。

### P2-E：批量入口已本地化，但通用规划器仍重新要求上下文

`route-bulk.png` 与 `Fleet.tsx:147–163,279–294` 显示：路径上下文确实限制了实例列表，不包含其他路径实例；但仍有可切换路径和操作的通用表单，初始实例未选。应承认已有正确范围隔离，继续减少重选，而不是危险地默认全选。

截图位于相邻私有演示的 `qa-artifacts/2026-10-22/`。这些是本地只读 mock 的真实浏览器渲染，不证明真实保存、授权执行或 VPS 生效。

## 3. 订阅工作台：本轮明确实施决定

### 3.1 单一入口，关系不丢失

- 主导航只保留一个“我的订阅”工作台入口；工作台视图为 **概览 / 分流配置 / 客户端订阅**。
- Profile 是组织分组，不另造后端 aggregate ID。保留原配置名称及所有 Output 名称，不自动重命名。
- 一份配置可包含零、一个或多个客户端订阅；输出行展示客户端、完整配置/纯节点、发布状态、最后发布时间和独立操作。
- `#profiles`、`#outputs` 保留为对应工作台视图的深链别名；不删除旧入口的能力。直接访问、返回/前进及脏编辑保护仍有效。
- 草稿、已撤销 Output、关联读取错误不能被筛掉伪装成不存在。Profile 读取失败不应阻断仍可读取的 Output 获取入口。
- 获取、更新、轮换链接、撤销归属 Output；编辑、独立复制归属 Profile。用途、复制、目标、范围都显式命名。

### 3.2 编辑范围与发布目标是两个显式概念

编辑器始终说明正在编辑哪份 Profile、该配置被几个 Output 引用。保存不会更新任何 Output；本次发布只更新明确选择的目标。

实施上可使用 discriminated union 表达发布意图：

```ts
type PublishIntent =
  | { kind: "update"; outputId: string }
  | { kind: "create" };
```

- 未传 Output **不再意味着新建**。从配置入口检查发布时，显示该配置绑定的 Output，以及明确的“新增客户端订阅”。
- 从 Output 行进入编辑，可预选这个明确目标；最终审阅仍写明完整名称、客户端和输出方式。
- 对现有 Output，target/mode 由该 Output 决定，不被 Profile 的默认客户端选择覆盖。
- 新增需要显式选择新建，再填写新链接名称、目标和输出内容；不默默 clone Profile。
- “该配置被 2 个客户端订阅使用”不是“保存将立即更新 2 个客户端订阅”。界面必须区分候选依赖与实际发布。

### 3.3 一个主操作，一条可恢复的检查发布流程

编辑主动作 **检查并发布…**；次动作 **仅保存草稿**。技术预览归入检查区域，不与另一个预览发布按钮竞争。

| 状态 | 主决策与下一步 | 不允许的推断 |
| --- | --- | --- |
| 编辑中 / 尚未保存 | 检查并发布会先保存当前草稿；也可仅保存草稿 | 不表示任何客户端链接已变化。 |
| 草稿保存失败 | 原输入、编辑对象、发布目标全部保留；重试保存 | 不进入以旧草稿为基础的发布审阅。 |
| 选择发布目标 | 选择某个已有 Output 或明确新增 | 未绑定不能自动走新增。 |
| 检查中 | 使用所选目标的既有 preview 合同 | 草稿预览不是 Output 更新的审阅凭据。 |
| 检查失败 / 不兼容 | 同页说明后果与可修正项，保留草稿及目标 | 不使用旧 digest；不退回弱兼容输出。 |
| 待确认发布 | 显示目标名称、客户端、完整/纯节点、变化、其他订阅不变 | 不把检查通过等同于已发布。 |
| 已发布 | 返回同一 Output；可获取原链接或既定新链接 | 不额外创建 Output。 |
| 发布结果不确定 | 沿用已有 identity/digest 核对与恢复 | 不以重复新建作为重试。 |

`PublishOutput` 与 `UpdateOutput` 的服务端 fence、creation receipt、错误恢复继续使用；不要为减少步骤移除检查与明确发布确认。保存请求未成功时不能让后续预览读到旧版本并继续发布。

### 3.4 有据可依的状态与发布内容

现有证据：

- `GET /api/me/outputs` 返回 Output 的冻结 metadata；列表不重新编译所有配置。
- `GET /api/me/outputs/{id}/status` 返回 `draftComparison.state`：`unchanged`、`changed`、`unavailable`。其含义是当前输入生成的候选与该 Output 冻结产物是否一致，不仅指手工编辑。
- `POST /api/me/profiles/{profileId}/preview` 带 `{outputId}`，服务端核对同一 Profile 和固定 target/mode，返回 `previewScope: "output-update"`、outputId、digest、候选和已发布 summary。
- `POST /api/me/outputs/{id}/publish` 只更新该 Output，保留原 token（除非原本无 token）；其他 Outputs 不会随之发布。
- Output `revision` 是发布身份，不是 Profile 修订编号；不得推导“配置 v3 / 发布 v2”。

首轮仅显示真实可知标签：**已发布 / 有待发布修改 / 尚未发布 / 已撤销 / 暂无法比较**，并显示最后发布时刻。不要在列表为每个 Output 自动触发昂贵 candidate 编译；按当前展开或选中的对象加载比较。

高级摘要暂缺时，已发布详情显示可靠 metadata，并提供既有**下载已发布配置 / 配置与规则包**操作。这些来自冻结 Output，不跳转当前 Profile 假装查看已发布内容。`/feed/{token}` 和 `/me/outputs/{id}/bundle` 的交付会再次执行授权检查；失败不能改用草稿产物兜底。

当前没有专用的“经服务端脱敏的冻结产物 JSON GET”。如果本轮需要内联只读代码视图，须另做最小只读接口，读取该租户的冻结 Output，保留授权检查并复用服务端 artifact redaction；不自动将凭据 feed 拉入普通列表，不发明并不存在的接口。未做该接口时使用既有下载即可，不为此阻断工作台。

高级语义摘要若扩展，只能在**发布时**生成并冻结 allowlisted 安全 metadata；不返回连接凭据、私有来源地址或整个 IR。旧 Output 没有摘要则如实显示，不从当前草稿回填。该增量不是首轮工作台的必需 schema 改动。

## 4. 来源与有效节点：现有 API 的精确合同

### 4.1 直接添加并使用来源

配置里的“添加订阅来源”直接打开提取后的来源表单；复用已有来源保留独立选择入口，不先打开完整管理列表再点一次添加。

确认动作为 **添加并使用**：来源成功保存后，把 source ID 加入当前未保存的 Profile 草稿；不自动保存 Profile，不发布任何 Output。导入隐私说明、部分解析接受、来源更新复核、失败保留、关闭保护和独立来源管理能力继续保留。

来源编辑提取归属 `Sources.tsx` 及其新组件；Profile 所有者只接入完成回调，避免两个实施者同时改编辑器。

### 4.2 使用现有集合预览，不复制后端计算

完整 HTTP 路径如下；前端 `post()` 会自动添加 `/api` 前缀：

| 用途 | 请求 | 服务器输入来源 |
| --- | --- | --- |
| 已保存集合的当前结果 | `POST /api/me/collections/{id}/preview`，body `{}` | `collectionInput` 从当前租户加载该集合；不是 body 中的临时修改。 |
| 未保存集合草稿的结果 | `POST /api/me/collections/preview`，body 为完整 Collection | `id`、非空 `name`、有序 `sources` 与两层 `steps`；ownerId 可省略，由会话填入。 |
| Profile 直接选择多个来源 | 同上，构造只读临时 Collection，sources 为 Profile.sourceIds 顺序，每项 steps=[]，集合 steps=[] | 与现有 Profile materialization 的 `profile-sources` 路径语义一致；不保存临时集合。 |

示例（仅计算，不能复用作为 publish proof）：

```ts
post<CollectionPreviewResult>("/me/collections/preview", {
  id: "profile-input-preview",
  name: "配置输入预览",
  sources: sourceIds.map(sourceId => ({ sourceId, steps: [] })),
  steps: [],
});
```

返回的实际合同由 `internal/conversion/pipeline.go` 定义：

```ts
type CollectionPreviewResult = {
  endpoints: ClientNode[]; // 完成所有处理后的最终结果
  stages: Array<{
    scope: "raw" | "source" | "source-result" | "merged" | "aggregate";
    sourceId?: string;
    stepId?: string;
    endpoints: ClientNode[];
    removedIds: string[];
    changedIds: string[];
  }>;
};
```

`ClientNode` 含 id、name、ownerId、origin、connection、provenance、region、tags 等域。最终和逐阶段的连接用户名、密码、UUID、Reality short ID 已在对应服务端路径清除。显示层仍须避免将任意源名称视为可信 markup；不要把展示用脱敏 connection 回写进草稿。

**该响应没有 `valid`、`previewDigest`、`outputId` 或 publication scope。** 不因这些字段缺省判断预览失败；HTTP 成功且结构正确表示得到本次计算结果，不表示客户端兼容、节点可达或可发布。

### 4.3 权限、只读性及局限

源码证据：`tenant.go:180–250`（审查时点）中的 `collectionInput`、`resolveCollectionWithReader`、`previewCollection`；`conversion.ProcessCollection`。

- 使用当前会话账户的 TenantGet，ownerId 不匹配被拒；外租户集合或来源不能解析。
- 每个 Source 必须 enabled 且拥有 accepted Snapshot；候选刷新结果不会被自动替代进去。
- 只读取快照并在内存运行过滤、重命名、排序、去重和覆盖。该调用不抓取外部 URL、不刷新 Source、不保存 Collection/Profile、不创建 Output、不改服务器。
- POST 继续通过现有认证/CSRF 请求封装；“只读计算”不是匿名接口或免权限入口。
- 该结果不是固定输入的发布 fence。来源随后变化时重新读取；最终发布仍由 Output preview/digest 完成权威复核。
- `/me/profiles/preview` 返回渲染 artifact 等结果，当前 `writeProfilePreview` **不返回 materialized endpoints**；不要将它误当有效节点列表接口。
- 平台入口不是 Collection 输入。继续从 `/me/platform-entries` 使用已授权、可解析入口 metadata；不要将管理员内部端点或伪造 connection 混入集合请求。

### 4.4 helper 接入要求

建议独立 `profile-input-preview` helper/hook，归属新文件，Profile 所有者接入。输入只包含所需 sourceIds/collectionId、当前会话范围及相关资料变化标识，不随每次规则文字输入重算。

1. 有 collectionId：预览该保存集合；若正在编辑集合草稿，则明确走无 ID path 的 body 合同。
2. 无 collectionId 而有 sourceIds：按顺序构造临时 Collection 预览。
3. 两者都没有：仅使用已有 inline imported endpoints 的真实编辑数据，不把“空选择”误解析成所有来源；平台入口独立处理。
4. 最终 `endpoints` 同时供节点列表及静态策略组选项使用；两处不能各自计算不同范围。
5. 来源、集合选择或其已接受数据变化时使结果过期；进行中显示正在计算，失败显示失败与重试，不退回原始来源节点冒充最终结果。
6. 对竞态使用 input-key/revision 或 abort；迟到结果不能覆盖新选择。查询按会话隔离，登出后不能复用其他账号的数据。
7. 已有组/规则引用的节点被过滤掉或不可读时，保留其 ID 并明确标记不可用；不自动替换、删除引用或选择另一出口。
8. 不将只读预览结果当作 Profile 保存 payload 的新连接凭据；Profile 继续保留 source/collection 引用，让后端物化。

## 5. 线路就绪与上下文下一步

本轮不必先重写全部导航。先让现有线路详情成为可恢复的任务落点，并复用已有路径、授权、凭据编辑器。

详情展示独立证据行，而非一个夸大的绿色总状态：

- **路径与对外地址**：已保存/待检查/需修正；可查看引用路径和共享影响。
- **用户授权**：读取该用户 authoritative effective-policy，显示继承/个人指定/禁止，不改变 null / [] / IDs 语义。
- **用户入口**：未准备/已准备/已停止交付，凭据只在其既有权限上下文处理。
- **运行配置**：待提交/排队/应用中/已确认/失败/未知，以现有 resolve 和 agent 观察为据。
- **可交付**：只使用服务端确认，不因以上几个前端布尔值看似齐全就推算可用。

首次保存后留在线路详情；给出具名下一步，不只 toast。用户授权或入口准备后返回同一线路与用户，不要求记住名称重新选择。

编辑公开线路时，主流程显式为 **检查线路 → 检查结果 → 保存线路**。检查前不以无说明灰按钮让用户猜依赖；修改地址/路径使先前检查失效，解释“内容已变更，请重新检查”。保存成功仍不是应用或获权。

现有证据入口：`PublishedRoutes.tsx` 的 `/published-routes/{id}/resolve`；`UserPolicyEditor.tsx` 的 `/users/{id}/effective-policy`；`UserEntries.tsx` 的用户入口列表；现有路径详情中的 AgentState。未具备统一后端就绪聚合，不凭空增加未知状态的确定性。

## 6. 上下文批量与执行任务

- 列表明确选中对象后出现操作栏；详情操作使用同一变更审阅组件。传递 action、deploymentId、明确选择的 targetIds、返回位置。
- 已有上下文显示为不可混淆的范围摘要；更改范围需要明确动作，不通过通用路径下拉悄悄更换。
- 从单一路径的“批量操作”进入但尚未选择实例时，仍明确选择目标；不自动执行、不危险默认全选。
- 保留一起/逐个/先试一个/自定义阶段，以及既有 20 阶段约束、影响/差异、重试、失败恢复。
- “保存待执行计划”与“开始执行”是同一任务的两个状态，不是两个无关联产品入口。执行记录页负责继续、追踪与历史，资源页负责发起。
- 现有 FleetInput 只支持一个 deploymentId；跨路径编排不做。不能静默拆成多个批次并宣称整体原子执行。

## 7. 前端实施边界与协作

| 切片 | 主要文件归属 | 首轮完成条件 |
| --- | --- | --- |
| 订阅工作台和发布目标 | `App.tsx`、`Subscriptions.tsx`、`Profiles.tsx`，按协调者指定所有者 | 单工作台、旧深链、零/一/多 Output、显式目标、保存检查发布连续与恢复。 |
| 来源表单提取 | `Sources.tsx` 与独立来源编辑组件 | 直接打开“添加并使用”；来源保存后仅修改当前未保存 Profile。 |
| 有效输入预览 | 新 helper/hook 及独立测试；不与主编辑器同时改同一 hunk | 复用现有 Collection preview，最终结果、竞态、加载/错误及丢失引用都正确。 |
| 线路下一步 | `PublishedRoutes.tsx` 及必要独立组件 | 显式检查依赖、保存后同对象下一步、路径/用户上下文不丢失。 |
| 批量范围连续性 | `Fleet.tsx`、`ServerRoutes.tsx`，单独分派 | 上下文传递、不重新组装意图、不扩大实际后端支持范围。 |

这些 UI 决定可在现有授权内执行，没有需要用户重新选择的业务策略。若要改变“自动更新所有链接”、跨路径编排、授权合并或多监听运行时等实质语义，必须另行提出决策，而非藏在本轮简化中。

## 8. 本轮明确不做

- 不把一 Profile 多 Output 改成一对一；不自动 clone，不自动发布全部引用。
- 不实现或假设 Profile/Output 的精确版本映射。
- 不用当前草稿推断已发布高级语义；不将新的可读摘要反向套到旧产物。
- 不改权限继承、用户授权或运行时 enforcement 语义。
- 不实现跨路径任务编排、多监听运行时合成、核心自动归并或身份迁移。
- 不发布 Site，不修改生产 VPS，不将本地演示和 DOM 通过当真实运行证明。

旧 `SERVER-CORE-ENDPOINT-MODEL-2026-10-20.md` 的所有权 guard 待实现描述已有时间差：当前 `server_deployments.go`、`fleet_prepare.go`、`fleet_execute.go` 已调用 `prepareInstanceOwnership` 并使用比较/事务写入。不能据旧文档断言当前仍会无保护覆盖其他部署。当前每实例单入口限制仍见 `infrastructure-model.ts`；本轮 UI 不宣称已支持共享多监听合成。

## 9. 产品验收，而非测试数验收

1. 从原三个入口进入同一配置，都能说清正在改哪个工作对象、将更新哪个客户端订阅；未明确新建时不产生额外 Output。
2. 一 Profile 两个不同 target/mode 的 Output：只更新所选一个，另一个冻结产物、凭据及发布时间保持不变。
3. 仅保存草稿、来源更新、集合更新不等于发布。读取失败/未知不伪装为最新、为空或可用。
4. 高级 Output 详情不把当前草稿当历史发布；旧摘要不足时可明确访问真实冻结文件，且授权失败无草稿兜底。
5. 添加来源失败保留输入；成功只加入当前草稿；取消 Profile 不误撤销独立已保存来源，也不误称 Profile 已保存。
6. 带过滤/重命名/去重集合的节点列表与组候选使用同一最终结果；切换集合的迟到响应不污染新范围；失效节点引用可见而不自动替换。
7. 开通线路在任一步中断后能回到同一线路，识别未完成步骤并继续；获权、准备凭据、应用、可交付不混为一谈。
8. 批量操作携带原选择、策略与范围；确认前能指出目标与影响；未支持跨路径时明确阻止而非静默扩展。
9. 老深链、直接访问、返回/前进、取消、失败重试和重复点击保持对象身份与授权隔离。

方法关联：UX-01/02（任务与导航）、UX-06（批量作用范围）、UX-07–10（状态、恢复与风险），来源以 [UX-GUIDELINE-SOURCES.md](UX-GUIDELINE-SOURCES.md) 为准。这里的产品决定是本项目的判断，不冒称 Cloudflare、Google 或 IBM 对本系统的认证。
