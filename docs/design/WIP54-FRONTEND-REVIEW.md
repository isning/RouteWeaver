# WIP54：前端任务连续性与表单首个提交状态

日期：2026-10-31。基线：恢复的 WIP51 source v60；没有假定丢失的 WIP52/53 修改已存在。本文只记录这轮前端修复，不代表完整项目验收、浏览器视觉验收或任何机构认证。

## 已解决的用户问题

| 用户任务 | 实测失败 | 修改与当前证据 |
|---|---|---|
| 打开已有 VLESS/TLS 连接 | 首个 DOM 提交缺少 UUID、SNI 与 TLS 选中状态；之后的订阅更新才补齐 | `ConnectionFields` 的条件分支在 watcher 尚未同步时读取当前 form store；首个提交回归先失败、后通过。原有协议切换、托管限制、修复输入等局部测试通过 |
| 编辑每月重置规则 | 已保存的 31 日控件在首个提交不存在；说明显示通用时区，而非月度重置后果 | `CycleFields` 使用当前表单 mode 后备值；首个提交回归先失败、后通过，不猜测起点、不替换原有周期 |
| 调整线路扣量倍率 | 修改倍率后 Escape/取消直接丢弃，导航也没有未保存状态 | 使用现有丢弃确认与导航保护；只在实际不同于打开时的值时确认。未修改/改回原值不增加步骤。失败保留线路、倍率、开始时间，取消丢弃返回原触发按钮 |
| 编辑通知渠道并查看发送记录 | 切换页签卸载表单，SMTP 主机草稿和未保存保护一起消失 | 仅在用户访问过设置后，在同一页内保留设置表单与展开状态；隐藏面板不可见，切换不保存、不发送、不加确认 |
| 编辑平台名称/订阅域名并查看备份页 | 同样丢失未保存输入 | 基本设置保留在同一页内；账号安全和备份仍按原来的挂载生命周期处理，不扩展 MFA/备份敏感状态的保留范围。重复的页签描述结构合并为一处 |
| 设置后台读取失败后恢复 | 即使有缓存数据，`QueryState` 的错误分支仍卸载有修改的表单；恢复后原草稿被已保存值替换 | 平台设置和通知设置保留现有编辑器、显示真实读取错误及“重新读取设置”；首次读取失败仍呈现初始错误态。两个实际组件各自红→绿 |
| 创建邀请，等待时取消/重开 | 独立复现：Alice 请求未结束就取消、重开输入 Bob，Alice 返回的链接替换 Bob 表单 | 请求期间不能关闭或改字段，使用同步提交锁；每次打开有独立实例身份，旧/卸载任务结果不进入新任务。失败保留受邀人、角色；成功显示受邀人及角色；新一次邀请清空旧结果与草稿 |
| 独立运行真实 API 任务 | API 项目仍依赖 Vite 启动；单一测试另外写死 4173 | 新增 API-only 配置，直连控制平面 8080，不启动 Vite/浏览器；普通用户隔离请求上下文复用 Playwright `baseURL` fixture。配置合同测试也抓出了 `defineConfig(shared, override)` 会保留旧项目的合并行为，改为显式替换 |

邀请成功/拒绝均不自动发送邀请。生成结果只显示真实响应，未修改账号权限或真实外部服务。来源仍为自动/手动直接应用，未加入审核步骤；计量自动恢复逻辑未改动。

## 设计与实现约束

- 技术栈已核对：React SPA、Tailwind 4、官方 shadcn/radix-nova、neutral tokens、现有 `.dark` 主题。此次没有修改主题、依赖版本或新增 CSS。
- 先修任务中断与数据丢失，再考虑外观。沿用现有 `TaskDialog`/`TaskSheet`、表单字段、按钮、确认、可见焦点与 reduced-motion 合同；没有另建模态框系统。
- 规则：`AGENTS.md`、`CONTENT-DESIGN-RULES.md`，恢复方法包 `ux-research/methodology-rubric.md` 的 UX-07/09/10/11。保留输入、真实失败状态、局部恢复、无额外保存步骤是本轮的验收标准。
- 已阅读官方固定版本 TDD、tests/mocking、code-review 文本；本地 `/workspace/shared/routeweaver-skills` 起初不存在，未声称执行不存在的本地技能。也核对用户指定的 Refactoring UI reference 及其组件适配/审查规则；项目显式选择的官方 shadcn 风格优先，不把参考资料的审美建议当迁移许可。
- 独立审查工作者在实际生产组件上复现了通知页签、后台读取、邀请串任务问题；永久回归保留在 `web/src`。DOM 观察、HTTP stub、真实 API、浏览器像素证据分别记录，不互相替代。

## 精确验证

安装：在 `web` 执行 `npm ci --ignore-scripts --no-audit --no-fund --cache /workspace/scratch/d385eb428cee/npm-cache`，449 个包成功；使用锁文件，没有借用旧工作区不兼容依赖。

最终局部命令（串行、一个 worker）：

```sh
npm test -- --maxWorkers=1 \
  src/initial-form-commit.dom.test.tsx \
  src/connection-fields.dom.test.tsx \
  src/service-cycle-defaults.dom.test.tsx \
  src/rate-edit-continuity.dom.test.tsx \
  src/settings-tab-continuity.dom.test.tsx \
  src/invite-task-lifecycle.dom.test.tsx \
  src/admin-task-lifecycle.dom.test.tsx \
  src/announcement-modal-focus.dom.test.tsx \
  src/ui-patterns/task-overlays.dom.test.tsx \
  tests/api-config.test.ts
npm run typecheck
git diff --check -- web
```

结果：**10 文件、89 测试通过**（26.51 秒）；typecheck 通过；空白检查通过。worker 总计显示 10 个是逐文件隔离进程累计值，`maxWorkers=1` 限制并发为一个。新增 14 个针对任务的回归，不以数量证明整体产品水平。

日志（协调者可归档；不是已上传附件）：

- `/tmp/wip54-frontend-final-focused.log`
- `/tmp/wip54-typecheck-final.log`
- 首个提交红记录：`/tmp/wip54-initial-red.log`、`/tmp/wip54-cycle-red.log`
- 丢失草稿红记录：`/tmp/wip54-rate-red.log`、`/tmp/wip54-tabs-red.log`、`/tmp/wip54-admin-tabs-red.log`、`/tmp/wip54-settings-refetch-red.log`
- 邀请 pending 红记录：`/tmp/wip54-invite-red.log`

中间执行也真实保留：新增后台错误 Notice 初次漏 import，局部测试和 typecheck 报错；补齐 import 后，以上最终重跑通过，未把中间失败改写为通过。

## 尚未验证 / 留给下一轮

- 本工作者没有运行完整前端套件、生产构建、真实 API 全套或 Chromium；最终 aggregate 由协调者串行负责。API-only 先完成 17 条发现；真实执行最初 16/17，唯一失败的写死 origin 已修复，重跑结果由 CI 工作者报告。
- 本轮没有新桌面/窄屏/短屏截图或浏览器几何测量。DOM 中的隐藏、焦点恢复、首个提交控件存在性不等同于像素、首帧绘制、触屏或辅助技术实测；没有绕过 Chromium/netlink 限制。
- shared whole-page/dialog/Sheet 结构与已有焦点局部测试检查过，未发现本轮需要新增 CSS 的已验证问题；这不是全页面视觉优秀的声明。
- 邀请表单目前按“曾编辑”保护退出；全部改回默认值仍可能显示丢弃确认。与倍率表单的精确相等比较不同，这是下一轮可复现后修正的非阻塞一致性项；本轮完整门禁期间不继续改源码。
- `Resources` 文件检查的晚到错误在 URL 改动后的归属仍是待验证假设，本轮未补丁。另有 UI e2e 合同维护由独立工作者负责，不包括在本表的 89 项中。
- 未提交、推送、部署、上传、发布，也未读取或注入外部登录凭据。
