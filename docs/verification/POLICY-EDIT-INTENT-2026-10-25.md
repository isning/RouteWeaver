# 服务方案打开基线与资源审阅：有界证据

2026-10-25。合同见[API说明](CONTROL-PLANE-API-NOTES.md#service-policy-opening-record-review)；来源与方法见[GS-41/42](../design/UX-GUIDELINE-SOURCES.md)及[项目方法](../design/UX-METHODOLOGY.md#打开记录的基线与确认后的票据分别保护)。本页区分缺陷复现、候选逻辑、实际流程与最后CSS补测，不预报整合/全量门槛完成。

## 缺陷与当前范围

A打开额度50/默认日1；B保存默认日15；A只改额度100。旧公开preview/apply接受A的整条旧记录，最终回到100/日1。旧票据只保护preview→apply，不能保护opening→preview。新增服务编辑上下文、原子打开基线和独立资源before/after关闭这个具体路径。该服务切片完成时，group/entitlement编辑及有意raw API全量替换仍为显式legacy；不是所有策略编辑都已具备打开基线。后续[用户组切片及其独立证据](GROUP-POLICY-EDIT-2026-10-25.md)扩展了覆盖范围，不回写本页历史执行结果。

最终候选由20路径服务层`bb42c77b…`、5路径文案/首版inset层`8e772b51…`和仅CSS的最终paired-paint层`eec0f37a…`组成，共21个不同代码/测试路径。最终CSS SHA256为`b7fe08e793cc54c9237289c214b6f87737b33943dd52ce901b87da6465f8f02f`。规范化整合回执单独绑定实际清单，不以本页代替。

## 执行谱系（不累计为一次全量通过）

下列均为本地私有受控夹具；原始回执/图片留在工作区，不向文档复制会话、令牌或响应秘密。

| 阶段 / 回执SHA256 | 实际结果与边界 |
|---|---|
| 旧API缺陷示踪 `8ea4c94d183a26a6968563c69d06cbd5cd6a8e42752ac85db3bcb0904ce1e171` | 原digest516b，仅旧公开API的一项native测试实际产生100/日1。测试通过表示不良旧行为被复现，**不是安全通过**；缺新接口/编译失败不算RED。 |
| 服务候选后端 `3ef8216c91dadbae152c20459afcd995923004b4c9dd87642e94d52a04630636` | digest516b+服务层：只读gofmt及4个NONRACE过滤调用通过，25顶层/34展开，无skip/fail。含两编辑者、缺失/创建、隐藏字段、既有CAS/权限/预算/周期/用量。不是全仓/竞态穷举。 |
| 服务候选Web `494eff85776c00f71a0a2c0d2eadc54346a6eff87b2eee7dc897024b059c624a` | publication整合后bfc3+服务层：typecheck和7个完整DOM文件131/131（含25新场景），无skip/unhandled。mocked DOM不证明数据库原子性。 |
| 文案/首版inset前置 `22a3d91d05889237bc61cf08847c1a59801da80897cb8efbd120b4c68c4c11c8` | bfc3+服务层+5路径层：同25顶层后端选择、typecheck、同7文件131全部通过；**不含最后CSS paint修订**。 |
| 真实完整流程 `6cf3a28ec4945776631451509b9a6b0b8c1d2dabab89f620c05b2249ad4ce9f2` | built UI+真实本地后端，desktop/narrow两任务、6张图；两个未分配合成方案，共6次受控提交、4次实际stale409。读取最新后再次旧预览仍409；明确接受重置50GiB/日15，重新输入100后保存100GiB/日15。资源额度对照与现有用户不变分开；保留副本/最终丢弃同意保留。 |
| 最终CSS小型补测 `a10d0adbea1024e45eeb410ac4e3d3536b3142d8827536d180788ba342cb45dc` | 上述代码+最终CSS：仅首次冲突desktop/narrow两任务/两图，4次create/B提交、2次实际409、**无UIapply**。外层具名group仍聚焦，子alert无tabindex/不聚焦；parent outline:none、直接Alert绘制3px/-3px。不是新的完整reconciliation/131执行。 |

完整流程独立审查`e54501d12c67f0ab49ae4fab7cd3a97e8deead3babed2ce6629e6912cce20fe2`接受已测模型/任务，但发现首版inset被Alert遮住，只剩角部。最后两张原尺寸图独立审查`b63864f45abc3e9a97dca941f9cc1c0d6f1ea1e92e057b927b5a7fe4c0fd54d2`确认四边连续可见、消息/恢复动作可读且焦点语义不变，关闭该具体残余；不回写旧图为通过。

## 保留的过程与限制

- 前三轮非绿浏览器记录保留；可访问名称、真实滚动建立和Drawer外层trap根与内层role=dialog的断言边界经过审查后修正，不靠强制focus、宽泛任意DIV或延长预算通过。最终实际Tab/Shift+Tab进入当前具名对话框。第三轮实际像素还发现重复冲突文案和顶部ring裁切，分别修正；早期标题裁切猜测已撤回。
- 同一已有admin的两个会话完成操作；未给用户分配方案、未创建新凭据。未分配账号状态保持是负向对照，不是已分配账号迁移测试。建立账号周期/用量的保护另有后端公开缝隙测试，不能由零用户浏览器任务推出。
- 最终paint没有重跑完整流程或131项；以逐字节代码身份连接先前已接受行为与本次CSS范围。源码/工具/构建/私有输入守卫和进程/端口/demo数据清理在各自回执中记录。
- 不声称AT实际播报、全WCAG/Google认证、人类无提示理解、所有视口、生产部署或外部流量。temporal简化、group/entitlement迁移及规范化整合后的适用总门槛仍是独立范围；没有清用量或改计费规则。


后续[个人授权切片](ENTITLEMENT-POLICY-EDIT-2026-10-25.md)在独立上下文/控件结算与实际任务证据下扩展覆盖；原始服务切片未执行这些场景，本页旧回执及限制不据此重写。
