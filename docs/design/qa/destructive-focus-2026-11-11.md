# 危险操作按钮的键盘焦点

## 范围和设计依据

React SPA、Tailwind v4、官方 shadcn/ui radix-nova 组件，使用 `shadcn.css` 中已有的语义色与明暗主题。不改主题色、不改按钮层级或布局。

参考用户指定的 [Refactoring UI](https://github.com/edisonmbli/refactoring-ui-skill/tree/main/skills/refactoring-ui)：保留 `16-component-libraries.md` 的组件/令牌边界；焦点对比采用 `15-beyond-the-book.md` 的补充交互指引，并非书中原有规则。默认危险操作仍保持浅色填充，仅键盘焦点加强。

## 实际修改前证据

已查看运行 [42865667554](https://github.com/isning/RouteWeaver/actions/runs/42865667554) 的实际 Chromium 合成组件截图，来源为提交 `2458fbe`。下载产物 `13787287079` SHA256 为 `7408d1dfbcf2021db868ca86ae68017436c7ec3f8420cb1e5171c516f8a96ea6`。

- 修改前截图：`50c69aae0523f285fcba0f0add33c4565f0f15e4.png`。
- 焦点截图：`fc5192df45f430aee19944efff76682552347d0d.png`。
- 浅色按钮矩形：x=316.28125、y=210.75、宽=149.453125、高=32 CSS px；视口 1440×1000。
- 顶部直边中点 (391, 209)：未聚焦 RGB(255,255,255)，聚焦 RGB(244,207,209)，对比约 1.429:1。
- 顶部边框 (391, 211)：未聚焦 RGB(255,255,255)，聚焦 RGB(233,159,163)，对比约 2.110:1。周围白色背景取 (391,206)。按钮填充未改变，outline 为 none。
- 这包含边框变化，不把低对比外环单独当作整套焦点指标。这里只记录这一合成按钮的弱焦点显示，不作全应用 WCAG 不合格或合格结论。左侧相邻 Primary 按钮在修改前截图中持有焦点，因此不能用其阴影覆盖区计算前后差异。

## 修复与回归

`Button` 的 destructive variant 改用不透明的 `focus-visible:border-destructive` 与 `focus-visible:ring-destructive`，保留原有 3px 环宽及所有填充、悬停、尺寸、禁用行为。

暗色主题明确采用同样的不透明焦点环，由暗色 `--destructive` 负责颜色，移除原 `dark:focus-visible:ring-destructive/40`。这是该 variant 的局部修复，不是其他暗色焦点的总体改造。

复用实际组件取样测试，通过原生 Tab 获得焦点，保存前后截图与 computed paint。新增两种主题的 viewport、CSS-scale PNG 和 RGB 测量附件：在顶部直边采样，避免圆角及邻近控件阴影；要求焦点环与相邻背景对比至少 3:1，并检查焦点前后宽高不变、shadow 发生变化。边框 RGB 也保留在附件内供审查。原侧栏像素测试保留。

## 验证边界

本地通过：`typecheck`、生产构建、3 个聚焦 DOM 文件共 29 项测试（资源弹窗焦点、task overlays、endpoint configuration）、`scripts/verify.sh static`，以及该取样文件的 2 项 Playwright 测试发现。DOM 测试验证交互兼容性，不验证浏览器颜色或几何。

新版本的实际浏览器像素仍待 CI 产物验证。本地 Chromium 进程启动时受 socket 限制（browser singleton socket() 失败，Operation not permitted），没有绕过限制或把未运行的浏览器测试写为通过。本轮不宣称完成窄视口、全应用焦点审查或真实节点部署验收。

独立源码复核已完成，无阻塞发现：确认 `cn` 的 Tailwind 合并使新焦点颜色替换原类、明暗语义色使用、顶部取样避开相邻控件，以及尺寸/焦点断言。该源码复核不替代修正后的浏览器像素验收。

## Corrected rendered evidence

[Supplemental run 42896088159](https://github.com/isning/RouteWeaver/actions/runs/42896088159)
at `196862363dd170019e182d7a72c6f3f020da9fba` succeeded. Artifact `13799374981`
was downloaded and SHA256-verified against
`46f9d03d29ca6560612235c47275bea26eb7eb2180f0d30878c3500236b574d1`.
Both exact measured PNGs were viewed. The light ring and border are `(201,16,24)`
against `(255,255,255)`, **5.881:1**. The dark ring and border are `(255,100,103)`
against `(23,23,23)`, **6.207:1**. The sampler's focus-change and size assertions
passed. These are desktop synthetic destructive-button results, not whole-app
accessibility certification or narrow-layout acceptance.
