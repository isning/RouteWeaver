# Fleet 已知错误的类型化反馈

2026-10-23。有界候选记录，不表示全套测试通过或所有服务端错误已本地化。

## 决策

- 创建批次的既有指纹拒绝分支仍返回409与原有 `detail`，仅新增 `code: FLEET_REVIEW_CHANGED`。缺少指纹和指纹不一致均进入此分支，因此文案为“计划需要重新核对”，不一律声称内容发生变化。该分支早于批次写入；只有此明确拒绝可写“尚未创建批次”。
- Fleet 创建反馈仅按 `APIError` 的精确状态409与精确代码映射。未知代码、其他状态和通用错误保留既有回退，不按英文片段猜原因；全局 `fail()`、API transport、`ErrorNotice` 不变。
- 实例尝试记录的六个已知代码优先于英文 `detail` 显示本地化原因与下一步。尝试次数、时间、状态不变，未知代码仍用原 `detail || code`。
- `desired_superseded_review_required` 可能属于已提交的尝试。只提示核对当前实例和批次状态，不声称未提交、不自动重试，也不暗示重试安全。
- 原409清除旧审查、输入保留、创建与执行区分、焦点恢复、账号边界和重试策略不改。独立源码复核通过；新增用例本身不另行证明全部焦点/账号行为。

## 有界验证

1. HTTP RED：缺失及不一致指纹均在“缺少新代码”处按预期失败；既有JSON409、原文与无批次写入检查执行通过。无关400和所有权409不被误分类。
2. DOM RED：已知创建代码与已知尝试代码仍显示英文，两项按预期失败；未知409、已知代码但422两项通过。
3. 同一测试字节的 GREEN：四个HTTP父用例通过（包含既有过时预览、并发执行与授权用例）；TypeScript通过；四个公开组件任务通过。DOM维持原10秒任务预算、单worker、retry0。未运行全套测试。
4. 首次Go包装脚本因既有缓存软链悬空而未启动测试；记录为运行前置失败，不算产品RED。后续使用既有本地编译器/缓存并关闭模块网络访问，无安装。

HTTP选择：`TestFleet(CreateReviewChangedHasAdditiveSafeFeedbackCode|CreateOtherFailureDoesNotClaimReviewChanged|OwnershipConflictDoesNotClaimFingerprintChanged|StalePreviewConcurrentExecutionAndAuthorization)`。
DOM文件：`web/src/fleet-feedback.dom.test.tsx`。
完整冻结清单、日志与阶段收据保留于隔离证据目录 `fleet-typed-feedback-candidate-20261023`。真实构建浏览器检查见下节；不沿用此前受控 `Plan rejected` 截图作为本轮文案证据。

## 兼容性与范围

仓库内未发现严格拒绝该Fleet错误信封新增字段的消费者；前端保留完整解析数据和既有错误原文。Agent严格解码属于不同成功协议，非此端点。未知外部严格客户端未被证明兼容。本轮已在P2集成后的新基线上按精确差异合成，保留已有任务协调、actor guard与恢复行为，未用较早整文件覆盖。


## 最终合成与实际呈现

- 首次合成浏览器：1440桌面通过，390创建反馈通过，但展开尝试记录继承610px数据表宽度，正文右缘598px超出390视口，记录为真实布局失败，不降低边界要求。
- 使用已安装Table支持的 `expandable.fixed: "left"`，由组件既有展开行容器按实际表格宽度布局；仅加一层局部 `overflowWrap: "anywhere"`，保留全部未知错误文本。数据列仍水平滚动，无新observer、全局样式或截断。既有CodePreview仍使用自身pre-wrap与overflow:auto。
- 最终源码的四个HTTP父用例、TypeScript与四个公开DOM任务全部通过（2026-10-23 16:52:29 UTC终态）。最终实际构建浏览器于16:53:46 UTC通过：1440桌面、390×844、1440视口中420px抽屉。每个任务覆盖已知409单次创建拒绝与重新预览、输入保留、完整已知/被后续变更替代/长未知记录、数据水平滚动、展开折叠与键盘再展开、配置差异完整内容。
- 使用文字Range而非空容器边界：390表格范围[20,370]，文字最大右缘353.578125；420px抽屉表格范围[1044,1416]，文字最大右缘1399.59375。390创建错误底边783，小于844。无文本剪裁、无重试或执行请求、无pageerror。
- 浏览器使用实际构建前端与受控HTTP；真实Go拒绝分支另由HTTP测试覆盖，不声称浏览器执行了真实批次或native操作。刻意冗长的未知错误fixture用于证明内容保留，不表示所有后端错误文案均已设计完善。
- 最终浏览器前后源码hash/mode不变。较早合成检查曾因预先存在的生成文件 `web/tsconfig.tsbuildinfo` 被tsc更新而报原始invariant失败；原始失败与hash保留，仅在源码不变检查中排除此生成缓存，非P2拥有/集成的生产改动。
- 本轮未运行全套web gate；所有既有全套/聚焦deadline、未捕获异常与诊断记录保持原样，不由这些聚焦通过覆盖。新增测试本身不扩张为完整账号/焦点隔离证明。

### 精确最终源码与证据

以下为实际最终聚焦与浏览器均使用的代码/测试SHA256；本文在终态后补录，不改变已测试生产字节：

- `internal/httpapi/fleet.go`: `164500a1b6cbb6234119ffce41bd159ee811b3a0b6464bc56fd20696c60df5e6`
- `internal/httpapi/fleet_feedback_test.go`: `3c4452b927fbac2e5a035965cc2b1879462911151e77a27b9ab6bbf4aaba58af`
- `web/src/Fleet.tsx`: `bf632b84c4824388fb31866583f4bdc307975d326567436dc15af15cdcdbc770`
- `web/src/fleet-feedback.dom.test.tsx`: `271a398b014bfe1098bab9a2e86a524ce3e8a20dfa5c744b5f7f7eeaee357f62`

隔离证据根目录：`fleet-typed-feedback-candidate-20261023/`。最终聚焦：`verification/expanded-result.json`、`verification/expanded-after.json`；最终浏览器：`browser-expanded/` 中的source-before/after、facts、requests、pageerrors、build-manifest、退出码与截图。首次布局失败保留于 `browser-composed/`。最终交付补丁、manifest与验证hash收据为 `delivery-final/`；集成收据为 `integration-20261023-continuation/fleet-typed-feedback/receipt.json`。
