# 个人授权打开基线与控件结算：有界证据

2026-10-25。合同见[API说明](CONTROL-PLANE-API-NOTES.md#personal-entitlement-opening-record-and-control-settlement)，方法见[表单与控件所有权](../design/UX-METHODOLOGY.md#表单设置未提交选择和不完整输入分别拥有)。本记录绑定独立阶段候选；整合、最终主要任务/整体门槛与部署不是同一结论。

## 模型与交互边界

- 实际entitlement存在性与同事务effective/form seed分开。读取/预览不创建记录；缺失时保存采用显示的账号周期，使后续用户组分配不再自动初始化它。该既有后果只在实际`before:null`决定中说明，不等于从现在起算或清用量。
- 打开基线、UI意图计数与preview→apply票据各有边界。内容等价ReviewToken不承诺检测每次写入/重建；原授权、预算、日历、准确候选CAS保留。旧raw全量替换显式兼容，UI不降级。
- 保留副本来自完整Form设置，包括隐藏覆盖/未启用周期值；不冒称复制私有数字文本或未确认日期选择。查看最新不采纳，明确采纳才同时换值/基线并保留匹配旧副本。未完成数字先修复/丢弃；日期先确认/取消，同一关闭动作不能顺便预览。
- 未编辑时间字符串保留offset/九位小数；刻意picker提交遵循原组件精度。无新计费默认、清用量、schema或通用编辑框架。Service/Group未自动获得个人控件结算或私有缓冲区保真保证。

## 执行谱系

均为本地私有受控输入，不记录会话/CSRF。每份回执单独绑定源码、工具和清理；不能累加为一次全仓通过。

| 阶段 / 回执SHA-256 | 实际结果和边界 |
|---|---|
| 旧API缺陷 `178f4609be1b7033e76306a8cd14c9a907802e1b2c578c40e8d0e824f4c24eea` | 一项公开旧API示踪实际将A额度100/旧日1覆盖B日15。native0是复现不良旧行为，不是安全验收。 |
| 后端 `4b9351bd022775b6f54236c700d6d205b3d8b8a0b87c19e40e5e7e97b1702538` | canonical969a+已审Group+个人后端；只读gofmt及8个NONRACE选择，55顶层/91终端，无skip。包含缺失→保存→首次用户组及原始User/usage/reset存储不变性，不用`/api/state`投影usedBytes替代原始证据。 |
| 原控件 `95d6f0fd75d6dd7708c41ec7feff2c072a5a6960c5fafcdb4162f864e8bc61c6` | 原控件8/8、typecheck0：OK/选择后Tab提交，Escape/外点取消，未触碰原值保留；数字blur/Tab/Enter因控件而异。不是新回调、原生IME或编辑器采纳证明。 |
| 个人编辑 `f6ebf83947eae6b4de5008e0d619cf3952761f38a8d7aed979ce516fd5fb36c6` | canonical969a+Group+个人，不含Modal接线；12整文件226/226、typecheck0，无skip/unhandled。包括10个编辑任务、3个控制结算及213个既有场景。 |
| 创建/响应式 `aa81b19ef5a0cd01dee14dfabfed3e4882fc4678d6aac92eb3659e1cb29e74a5` | finite29、同12文件227/227、typecheck0；新增创建投影，保留原断言。包括blocked外观、创建摘要、局部popup布局及sentinel夹具类型修正。DOM不是实际几何证明。 |
| 零offset `ba512a492d2e1aa793f4511e9c146e94e4f26d1de285bc5b22e817fd46c5f939` | 仅公开popup offset改为0后，同12文件227/227、typecheck0；测试/CSS不变。桌面锚点间距4→0是明确接受的取舍。 |
| 重置区焦点 `d7f9fc0169d23bef8b854a66078b813be5e3b0e8d3f2eaac78c7d61f89910dcf` | finite30、12文件228/228、typecheck0，无skip/unhandled。新增物理拥有/滚动/无reset场景；明确纳入已审Modal helper前缀及reset适配器，但不含Modal的AccessPolicy接线，不宣称重跑Modal任务。 |
| 最终真实组合 `f189da17cf352360a39d8b6c3a9b1184c89d06db2bbbd269688cfdbdc93f95d1` | combined31，native3/3、8截图、双视口settled反向Tab可见。9guarded previews（含2次真实409）、6applies、7本地会话；无新用户/方案/用户组，320探针无政策写入，全部终态守卫通过。 |

最终真实流程包括首次实际缺失预览/取消、desktop/narrow两编辑者冲突、明确采纳、额度100/日15保存、数字/日期待结算恢复及精确资源/副作用核对。320×640只探测同一控件的严格边界、七日历列/时间列、真实选择与OK、明确丢弃和精确后端不变，不扩成第三套完整授权任务。独立审查`d6153bc6deb879d8b95ffe3f9d228c6235dc750a4f41594b1f5fb5d77d7893a6`逐张核对八图及精确交互/账本，接受该有界切片。重置原因证明同一原生焦点的完整边界框和绘制存在、仅body滚动且无reset请求；没有专门的聚焦重置截图、外扩outline或通用键盘/AT认证。pending日期截图不等于全部popup控件同屏可见，320的确认可达性另由正常内部滚动和真实操作建立。

## 原失败与修正不回写

- `17a365acf8f25154f8dbfcfd02c94f12f402056bc20a9e69abcd2e3d888ceec9`为216/226、8个unhandled：admission mock不完整和测试ID条件是夹具问题；另有真实Dayjs受控身份重置临时选择，按未变原字符串memo修复，不改保存格式。
- `5444aa79bd6c7fd96345571cc5a3173e2b9c543ae82ad42697f8b83c3415235e`为225/226、无unhandled：原picker默认100ms网格把刻意提交的`.123`变`.100`，仅修正该期望，九位原值断言不变。`06b1e832412162f4e6ccf0af11b2f783b5c3e66ce9443bdbc693fed36c8f8b7f`仅是可选anchor交给query的typecheck失败，没有执行测试。
- 首次真实`3f41d20f0b637e68cce9fb6ea567b719e8b7c35bc2ea9126fdf7c6b8fa0c04c7`desktop通过、narrow超时；原样诊断`8579fe952c48aaf8b83b0aa16d8ebd4a0578b3106662b3e8f4df7340ab987fcc`证实535.75px popup使390px视口的Feb4完全离屏。只为该控件做stack/有界滚动，不强制点击或换控件。
- `3166b405c60aa5627ff7267cad93f7450e74ea6ae19390f063b08a6fbcee4ff5`两主要任务通过，320在选择前因y=-4失败；`11c629e47e5ed0272c04008d0f6fb77cb44cb6f13451a98ece3951edd7df0ecb`确认真实顶边裁切。只把公开offset设0，不添加手动坐标、补偿padding或响应式JS。
- `d98c080d64e13d14da82ab10d733ef582c5bff518ef95b281395d6a36561e40c`虽native3/3及320通过，独立观察仍发现双视口重置原因聚焦5秒后离屏，不能称整体键盘通过。UsageReset在Form之外；新增物理区域只复用已有揭示计算，不改焦点、按键、reset确认或请求。
- `5fb9619f6abadf86d8a4669ef41c8149e71a64ea5153bf61d8f93fd2a3091848`已使双视口重置原因可见、desktop通过，但narrow显示检查失败、320未运行。原picker的hover显示与选中状态不同；后续夹具分别核对选中Feb4、真实指针移出和严格输入值，不改保存语义或放宽日期断言。各轮原截图、失败及终态守卫保留，没有增加预算。

## 组合与停止条件

最终source描述`7729e73a66548602f129fa12de7e225414133699749a36eb68896f34f209ac54`及独立审查`6eca6deec57847ca13bf37a8878132f7412ccc1f83a53f0bba40aaa82ad9a174`绑定canonical969a上的31个代码/测试路径：Group、个人、已接受Modal两处AccessPolicy接线及后续局部修正。Modal原helper字节作为前缀保留；reset新拥有者才显式使用整像素选项。八个Go文件仍与已通过55/91完全一致，不重标旧Group16c53后端证据。各层旧描述保留，不把独立226/263或228改称一次组合整体测试通过。用户组与Modal历史分别见[Group](GROUP-POLICY-EDIT-2026-10-25.md)、[Modal](POLICY-MODAL-KEYBOARD-2026-10-25.md)。

停止条件：关闭这两个实际任务阻断项，明确整合已审源码，将历史15项主要任务映射为当前17个场景，核对最终源服务/用户组/发布恢复smoke，并执行可用的整体门槛；不可用/缺失项明确记录，不能记作通过。不是每任务×每视口矩阵；非阻断文案/chip细节、线上执行、性能极限、真实AT/原生IME认证不自动扩大为本轮门槛。
