# UI-first 完整订阅任务有界复核（2026-10-23）

结论：本轮“粘贴导入→显式接受→默认/例外分流→两份独立订阅→获取链接→替换来源→修复保存→仅更新一份→失败恢复/重访”达到有界终点。最终为 action-name 修复者执行的两次真实本地后端通过记录；独立复核者审查源码/脚本差异、请求、事实及截图，**未独立重跑**。依据最终源清单与canonical完全一致接受证据。不是全套测试或产品认证。历史完整Web门禁924/946通过、8个未处理错误的结果未由本次有界任务重跑或清除。

## 已核验

- UI粘贴3个合成SOCKS连接的完整配置，检查提取限制并显式接受；父配置未保存名称/返回焦点保留，来源接受不自动创建配置/订阅。
- UI设置香港默认去向、东京`chatgpt.com且不匹配private.chatgpt.com`例外，读回精确意图。分别检查并确认创建MacBook/Mihomo1.19.32与Android/sing-box1.14.3；稳定ID不同、访问链接不同，获取界面链接哈希匹配指定对象。
- 来源替换及接受、共享草稿修复保存均未修改两份冻结交付物。MacBook具名确认、链接不变/其他订阅不变后仅发布一次；其revision变化而链接不变，Android的ID/revision/发布时间/分流摘要/交付物与访问哈希不变。
- 桌面1440和窄屏390能区分MacBook与保存草稿一致、Android有未发布修改；不声称客户端已经应用。取消返回原操作焦点。
- 仅Android比较503为受控Playwright故障；MacBook比较仍走真实API。解除拦截后显式重查真实API恢复Android状态，详情/搜索/重访不新增发布。附加忙碌态检查仅延迟真实本地读取，不伪造业务结果。

持久化写入计数：来源创建1、候选接受2、来源修改1、配置创建1/修复修改1、订阅创建2、MacBook发布1。额外非持久化POST：集合预览2、新订阅预览2、配置预览4（主流程取消/重开2，附加行/详情检查2）。无删除/撤销/轮换/应用；API不作业务夹具写入。

## 身份与保留限制

证据根目录`subscription-action-names-candidate-20261023/`，最终`target-diagnostic-pass/`于21:14:06–21:14:47持QA锁执行。Android已选显示、预览请求、创建请求、返回对象均记录sing-box1.14.3；不再仅以点击成功推断选择生效。

- 源清单SHA256：`348633fa19ee9ca1474d7978b8ddb2655e29ec0ce2c8593939e36a69a4789982`
- 构建清单：`3d6116ab24a07bd4ec59d36b8d319c7b62ee0e41ffdba16fd0e4d071db2bea5c`
- 最终脚本：`1bfe1044c9e44c85e67a55aa7018e76ac0bea566b303ba9e1736f2c66d851672`
- 精确合入回执：`integration-20261023-continuation/subscription-action-names/receipt.json`（21:15:51，2文件）。

原整合attempt7发现真实可访问名称残留`loading 检查更新`，已保留并以独立修复消除；原精确名称断言未弱化。另一首次执行曾在尝试选择sing-box后创建Mihomo Android，**仍为未解释的独立差异**；后续通过及名称修复不能声称已修好此选择问题。

完整范围/历史：`composed-subscription-journey-20261023/REVIEW.md`；原attempt7与6次脚本适配失败均保留。最佳安全桌面图：`target-diagnostic-pass/evidence/06-one-updated-one-pending-1440.png`。没有真实机场URL/外部凭据/外网抓取/原生应用/部署；平台入口刷新与轮换恢复不在此夹具范围。
