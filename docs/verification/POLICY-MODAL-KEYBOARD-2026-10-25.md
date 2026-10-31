# 授权确认 Modal：局部键盘与可见性验证

2026-10-25。最终候选已获独立源码及四张实际像素接受；此记录不表示已整合或部署。只覆盖下述当前授权确认层，Group/entitlement候选的组合须另行绑定。

## 已接受的局部合同

- 使用受支持的Modal `wrapProps`：当前物理wrapper、唯一当前dialog及真正已聚焦的原生控件共同确定所有者。揭示只滚动`.ant-modal-wrap`；不滚页面、其他对话框或Drawer，不重定向已聚焦控件。
- 真实、未被子组件处理的Tab/Shift+Tab在当前首尾循环；保留修饰/合成输入、组合控件及嵌套portal边界。提交时按实际禁用/隐藏状态重新确定顺序，支持当前只读确认中的按钮、复选框、首个原生summary、披露头及分页控件。没有全局监听、失活文档恢复或无请求的焦点抢占。
- Ant透明复选框input保持焦点身份，其直接可见span提供绘制/outline几何；只接受已核对的非交互Wave装饰，不豁免隐藏祖先或额外交互子节点。已可见目标不滚动；仅Modal把确需移动的最近位移向外整像素取整，避免分数舍入裁切，不加任意边距。Drawer默认算术和既有29项回归保留。
- 原有预览、基线/token、精确载荷、确认勾选、待处理请求、错误交接、Escape/遮罩及关闭合同不变。正常状态可取消，pending仍按既有合同不可关闭；不是完整APG/AT认证。

## 同一最终候选的证据

canonical969a上三路径：`AccessPolicy.tsx`仅import与当前Modal属性两处接线；`drawer-control-visibility.ts`局部适配；新增`policy-modal-focus.dom.test.tsx`。最终源码清单SHA `7d1effcb6e6cf4a0c8c74b5f63aa8d5b6d770b12a80c79d69f67747e955f2a14`；独立源码审查 `d08ea9d1dcd6b7230f6199683e9897e57aae9449a00c62f6faefed13ca4dfb78`。

| 独立范围 | 实际结果与限制 | 回执SHA-256 |
|---|---|---|
| 类型检查＋有限DOM |263/263，精确12整文件；原199及新增64，无跳过/未处理异常。不是全应用套件。|`b19219dee93a26cad6e2db8a10c529ec0f8cea15c0e1c068be997f2337bee704`|
| 原样正常键盘探针 |390×640，1条/2图；自然反向到返回编辑、正向到关闭，当前焦点与document焦点保持；wrapper滚动1016/113，页面0。|`31747045eeb25c96265df94c5ee8c8ef9c6d7f7c214db71e076d9f249637d26b`|
| 原样pending探针 |同视口，1条/2图；当前Wave实际存在时Tab从未勾选consent到summary，Shift+Tab返回原生input；对应paint完整入视口。|`e97dd848c8f4532d615e351d9ae6b792c76c1e41e528d88cf68857271d230d98`|

两次浏览器各有2次私有setup提交、3次真实预览：创建本地方案并只改复制的现有admin entitlement.serviceId。正常UI应用尝试0；pending **UI尝试1、后端转发0**，精确拥有请求在清理中abort，未伪造成功或提交配置。最终状态等于各自setup之后；`/api/state`只证明公共用户/当前周期用量投影，另查复制的entitlement日历，不冒称原始存储User字节不变。

独立四图审查 `53561eb46545d6ab68d4529d92c88fa4b178fcf3e3801ae24c816bcd6066e776`接受正常返回按钮及pending summary/复选框指示。正常正向关闭的可见性来自原生记录，不冒称有对应截图。pending summary绘制top0.5625、复选框绘制bottom639.1875；所有权、源码/产物及清理守卫分别保留。

## 原失败不重写

原始回执留在阶段证据包，以下是完整SHA的短标识：`b5f82519`记录返回编辑5秒仍离屏及正向document焦点离开（浏览器/OS具体目的地未知）；`f191e8b3`是缺依赖matcher导致的类型检查失败，测试未执行；`c42580b5`251/255、`388a0d67`256/260保留透明checkbox/Wave及初始动画opacity0就绪问题；`be4c37fa`保留严格paint检查的−0.4375外缘裁切失败，独立像素认为可用、非阻断，不倒改为通过。最终修正未延长预算、强制fixture焦点/滚动、禁用Wave或放宽paint断言。中间通过不代替上述最终候选。

本轮不覆盖后端pending事务/应用成功、所有动态对话框、辅助技术播报、账号日期控件Stage2、Group/entitlement组合后的界面或整体产品验收。方法及来源见[既有方法页](../design/UX-METHODOLOGY.md#当前确认层的键盘边界与可见绘制分开修复)与[GS-44](../design/UX-GUIDELINE-SOURCES.md#2026-10-25-模态确认的局部键盘边界)。


后续Group/个人授权组合及当前任务状态见[个人授权记录](ENTITLEMENT-POLICY-EDIT-2026-10-25.md)。本页三路径Modal的原执行范围和未覆盖项保持历史归属，不冒称那些执行已包含后来的日期popup或个人编辑迁移。
