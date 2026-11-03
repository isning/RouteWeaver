# 平台基本设置：固定策略用当前值表达

基于 `a08ec44`，由 CI11 实际桌面/390px 像素触发的有界修订。参考用户提供的 Cloudflare 设置页“标签／当前值／就近操作”关系，不复制品牌、账号数据或深色主题。

## 实际观察与修改

| CI11 已观察问题 | 修改 | 未改合同 |
|---|---|---|
| “基本设置”页签下再次出现同名区块标题 | 移除重复可见标题；表单有“平台基本设置”可访问名称，卡片仍组织独立设置 | 页签、表单与平台设置页标题保留 |
| “账号注册”“默认时区”下拉框各只有一个选项，暗示不存在的选择 | 改为两行语义 `dt/dd` 标签与当前值，细分隔线；平台名称继续可编辑 | 固定策略仍以 hidden AppField 注册；保存提交 name、registration、timezone 全部值，不在提交时硬编码或丢弃 |
| 窄屏固定政策占用两套大表单控件空间 | 标签/值直接并排，值可换行；使用既有 shadcn 语义色/间距 | 不新增编辑动作、后端政策或假选项 |

固定策略提交未改动 `SubscriptionOriginSettings`；随后布局补充仅将原有DNS/TLS说明迁移到保存决定前（见下文），内容和域名表单逻辑不改。Mutation、后台读取取消、接受版本、pending、较新输入保留和未保存导航守卫代码不改。

CI11观察文件：
- `route-visual-gaps.ui-refin-d5f22-ls-and-task-spacing-at-1280-chromium/refined-settings-1280.png`
- `route-visual-gaps.ui-refin-56cc2-ols-and-task-spacing-at-390-chromium/refined-settings-390.png`

## 新验证范围

既定 seam 为实际 AdminPage 用户任务及 fetch 边界。新增测试先在旧代码因仍存在“账号注册”combobox失败，修改后通过；同时检查没有伪选择、没有重复标题、有具名表单及语义当前值，编辑名称后完整保存载荷恰为三个正确字段。

单 worker 运行 `admin-task-lifecycle`、`settings-tab-continuity`、`subscription-origin` 三文件36项全部通过，覆盖原有未保存导航、tab连续性、在途保存后较新输入及后台旧读栅栏。应用 typecheck、build、diff check 通过。

现有浏览器场景新增具名表单、零combobox、两行当前值与零重复标题断言，保留原有移动目标、溢出、交互和零写请求检查；截图路径仍为 `refined-settings-{1280,390}.png`。Playwright `--list` 发现本文件4条场景，**未启动浏览器、未执行这些场景**。修改后像素仍须下一轮CI对比，不能以DOM通过宣称已完成视觉验收。


## 页面排版补充：决策顺序、轻量身份区与稳定截图

用户进一步明确“适当参考 Cloudflare dashboard 的页面排版方式”后，继续检查 CI11 的 `profile-conflict-{1280,390}.png` 和 `refined-source-dialog-{1280,390}.png`。

| 观察 | 此次处理 | 边界 |
|---|---|---|
| 域名DNS、证书、反向代理前提以及保存不修改基础设施的说明排在Save之后 | 同一段原文移到“保存域名草稿”前，格式提示之后；只出现一次 | 不是删免责；没有改变保存/验证/启用任务或给出虚假部署承诺 |
| 配置名称和关联订阅另套卡片，与主要连接/流量编辑区层级接近 | 仅移除身份条的边框/背景/内边距，组内间距24→16；名称输入与订阅详情原位 | DOM顺序、名称/订阅、草稿状态、冲突恢复、关键流量决策和所有guards保持 |
| 移动端局部tabs在完整连接/流量块之后，发现较晚 | **更广泛导航调整暂缓**：不能只把tabs提到上方而把长公共编辑块夹在tabs和panel之间 | tabs与panel继续相邻；不为像素位置制造“点击看似无响应”的问题，也不隐藏重要选择 |
| 来源浮层截图为进入动画中间状态，已有另一稳定图证明不是产品透明度缺陷 | 在截图前复用 `settledTask`：检查真实动画结束和opacity1，并附稳定状态记录 | 不改产品透明度、不关闭动画、不任意sleep；保持原有来源交互/取消/零写入断言 |

原域名前提位置测试先失败（Save在前），迁移后通过，完整原文与无重复同时断言。受影响的域名、Profile预览布局、内容层级、配置意图4文件67项DOM测试通过（单worker）；不与前批36项相加。应用typecheck/build、两个浏览器spec的独立typecheck、diff check通过；浏览器`--list`发现6场景，仍未启动浏览器执行。

下一轮CI继续产生同名 `refined-settings-*`、`refined-source-dialog-*`、`profile-conflict-*` 图以便对比。新增几何断言检查说明在Save前、局部tabs与panel邻近、名称和关联订阅不重叠；保留HTTP陈旧版本409、草稿和已发布内容不变及取消返回焦点的原断言。以上是新源码/DOM证据，修改后视觉效果须实际新像素核对。
