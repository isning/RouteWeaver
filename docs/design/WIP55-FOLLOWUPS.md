# WIP55：检查结果归属与邀请退出一致性

2026-10-31。本轮从 `d1da7d5005b0d142b0e9098d153daef4b39bb4e3` 建立独立 worktree `routeweaver-wip55-followups`，分支 `wip55-followups`。原工作区冻结交付期间不修改、不合并；本轮没有远程推送、浏览器操作、外部认证或实际规则 URL 访问。

## 已验证的修复

### 规则文件检查：旧失败不属于新输入

生产组件复现：读取 URL A 未结束时改为 B，A 的 422 错误显示在 B 的草稿中。已完成的错误在改 URL 后仍残留；改文件格式也有同样的晚到错误归属问题。

修改仅在 URL/格式发生变化时调用 `inspect.reset()`，清理并脱离旧 mutation 的可见状态。**保留原有 revision 成功结果检查**：reset 不等于取消 HTTP，也不会取消原回调。普通资源名称变化不清除仍属于当前文件的真实错误。

新回归覆盖 10 个实际 UI/合成 HTTP 流程：

- 改 URL 后旧请求失败；旧请求成功不能写入新草稿。
- 已有失败后修正 URL；改格式后旧格式失败。
- 丢弃并重开后的旧成功、旧失败。
- 同一 URL 真实失败及成功重试。
- A 未完成时启动 B，B 成功后 A 分别成功/失败，B 的校验值和读取摘要保持正确。
- 仅修改名称时保留当前检查错误。

### 邀请：全部恢复默认值不需要丢弃确认

生产组件复现：改受邀人、角色、有效期再全部恢复，导航仍被标记为未保存。现在显示默认值和 dirty 判断共用 `inviteDefaults`，比较全部三个字段，而不是“曾经编辑过”。只恢复其中两个字段仍被保护；全部恢复后 Escape 正常退出，不生成邀请、不弹额外确认。原有 pending 锁、旧任务结果隔离、失败保留输入仍保留。

## 证据

- URL 旧失败：`/tmp/wip55-resource-first-red.log`，预期回归先失败；最小修改后原 7 个路径全部通过。
- 邀请恢复默认值：`/tmp/wip55-invite-reverted-red.log`，dirty 状态原为 true；修改后通过。
- 最终局部测试：`/tmp/wip55-focused-final.log`，**6 文件 / 58 测试通过**，21.94 秒，`--maxWorkers=1`。
- 类型检查：`/tmp/wip55-typecheck.log`，`npm run typecheck` 通过。
- `git diff --check` 通过；父任务独立源码审查未发现阻塞问题。

局部命令：

```sh
npm --prefix web test -- --maxWorkers=1 \
  src/resource-inspection-lifecycle.dom.test.tsx \
  src/resource-modal-lifecycle.dom.test.tsx \
  src/resource-modal-focus.dom.test.tsx \
  src/resource-form-labels.dom.test.tsx \
  src/invite-task-lifecycle.dom.test.tsx \
  src/admin-task-lifecycle.dom.test.tsx
npm --prefix web run typecheck
```

测试基于实际生产 React 组件的公开控件和 `fetch` 边界，没有 mock 表单/mutation 内部实现。安装依赖通过 ignored `web/node_modules` 内的包 symlink 复用同一锁定版本，测试缓存保留在本工作区；没有修改锁文件。

原 source 的 1,891 项完整通过是 `d1da7d5` 的历史证据，**不作为新补丁完整通过的证明**。提交后可在本隔离工作区运行完整 Web 门禁并单独报告源码 SHA、命令和日志。本文不声称新补丁已通过浏览器、像素/窄屏、完整后端或所有异步调度验证。
