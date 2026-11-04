# pi-ext-ui 连续活动组 Spec

状态：已实现（tickets 01–06、10、04、05、12 与 thinking run 粒度）。本文仍是行为与验收依据；实现偏差与已知缺口见文末“实现记录”。历史讨论见 [PLAN](../plans/pi-ext-ui-collapse-views.md)。渲染修正批次 [rendering tickets](../plans/pi-ext-ui-rendering-tickets/README.md) 中 00 已定稿；01–06、10、04、05、12 已落地；07、08 未实现，09 的未知工具解析事实仍阻塞。

已实现的公共契约：`@hheei/pi-ext-core` 的 `ToolPresentation.children`（`ToolPresentationChild`：id、title、summary、status、durationMs）承载容器子调用事实；`@hheei/pi-ext-ui` 的 `ToolView.children`/`childCount` 与 `MessageView.kind`/`previewRows`/`bodyRows` 供活动组读取，不新增 host hook。

## Problem Statement

现有活动组将每个顶层工具、thinking 和通知各占一行，信息层级分散；容器的父调用与子调用容易混淆，当前/最后一次 codemode、python_eval 的展开内容也会占据过多高度。用户需要快速判断发生了哪些工作，同时保持每份结果可检查。

原生 TUI 内容可以打断连续展示段；断组结束当前 block 时钟，后续 block 独立计时。重绘不得重置已有 block 时钟。结束后的 block 还需要简洁的请求消耗统计，其公式与数字格式应与原生 Pi footer 一致。

## Solution

### 已批准的执行契约

用户批准 [00 定稿](../plans/pi-ext-ui-rendering-tickets/00-contract.md)：仅 transcript 最后可见单元留组外，保留原组件；agent_end 不吞尾项。footer 始终统计，footer/header calls 含同 block 尾项，分类仅组内；请求事实不能因正文过滤而丢失。thinking 按非空连续 run。恢复请求从公开 sessionManager 只读 host nestedCalls，不新存请求，缺失/截断明确提示。提供者在真实解析边界增加/保存解析事实，未知历史不能推断。收起/局部分类展开使用 error > pending > success 组背景；整组展开透明，独立块保留背景，notice/thinking 为 customMessageBg。以下旧外壳与待定文字由该定稿取代，实施同步清理冲突示例。

### 原生背景外壳（已实现）

收起的整个 collapse views 是一个 Pi 原生语义背景块：`ToolGroupView` 用 `Box`（`paddingX=0` 不重复工具自己的 `outputPad`，`paddingY=1` 让背景在 header 上方与 footer 下方各多一行）包住 header、分类行与 footer，并在 header 下、footer 上各画一条 `borderMuted` 组级横向 rail；组前空行留在 Box 外，所以不着色。底色取 block 自己的事实，不取最后一次调用的状态：block 里存在 running/streaming 成员且尚未结算时用 `toolPendingBg`；一旦成员都带状态且都不在运行，block 结算，按 block 内是否有 error 取 `toolErrorBg` / `toolSuccessBg`。结算之后的调用不会把底色翻回 pending——按最后一次调用着色会让一次请求里连续调用工具时底色反复变化（用户看到的就是闪烁）。block 结算后该底色再保持 5 秒，然后回到中性底色 `toolPendingBg`（Pi 主题里唯一的中性背景槽，chroma 3–5%），因此历史 block 不会堆成彩色面板，也不会变成没有 panel 的裸行。局部分类展开仍在同一个 Box 内，因此保留组底色。`paddingY=1` 只在有底色时启用：`Tool backgrounds` 关闭时组外壳没有上下留白行，所以「移除背景」真的移除这些行，而不是留下空白。`Tool backgrounds` 设置打开后，工具改用 Pi 原生着色（成功 `toolSuccessBg`、失败 `toolErrorBg`、进行中 `toolPendingBg`，上下各一行 padding，去掉 `▎` 前导导轨），组外壳仍保留自己的 block 底色，工具底色只覆盖工具自己的行，reset 后回到最内层底色。整组展开（标题或 Ctrl+O）时只有标题仍是一个背景块（`paddingY` 同上，上下各一行同色 padding），成员区域不套 Box、也不画组级 rail：外层透明，所以展开不会给整段对话着色。展开时 footer 的统计并入标题行（`collapse views · 用时 · N calls · requests ×N · ↑…`），末尾不再追加 footer 行；标题块与第一个成员之间固定留一行无色空行，保证标题与内容有至少一格间距。默认模式下工具与 thinking run 不填自身背景，notice 的 `customMessageBg` 始终由 `MessageView` 拥有并在上下各留一行同色 padding。`Tool backgrounds` 打开后，工具与 notice 各自成块并带自己的 padding，thinking run 仍是原生正文：不填背景、不加 padding，只保留块间那一行空行。工具自身的 `▎` 导轨、正文、copy 与折叠层级不变。设计记录见 [12：原生背景块](../plans/pi-ext-ui-rendering-tickets/12-native-background-blocks.md)。

### 1. 用户可见目标

收起态是一个背景块：固定 header、三行可展开分类和固定统计 footer；transcript 最后一个可见顶层单元留在组外，按原组件 Level 0 显示。示例（`▉` 表示背景块覆盖的行）：

```text
▉▸ collapse views · 1m 12s · 20 calls
▉────────────────────────────────
▉▸ notice · memory ×2 · optimizer ×1 · info ×3
▉▸ thinking x2 · 800 tokens
▉▸ read ×7 · grep ×12
▉────────────────────────────────
▉requests ×3 · ↑24k · ↓1.5k · R20k · CH75.0%

◐ codemode
```

示例中组内 19 个已完成 calls 与组外尾项合计为 header 的 20 calls。尾项仍在运行时不计 calls，完成后按最终有效子调用数一次入账（无子调用则计父 1）；组外尾项的 calls 与 usage 始终计入本 block 的 header 与 footer，分类只列组内项。三个分类标签统一小写，顺序固定为 `notice`、`thinking`、`tools`，每个非空分类占一行；空分类整行省略，不画零统计行。notice 行只列类型计数（如 `memory ×2 · info ×3`；`ui.notify` 的级别直接写作 `info`／`warning`／`error`），不再重复 `N notices`，条数由各项计数体现。

展开分类后的内容：

```text
▾ read ×7 · grep ×12
▸ ✓ read a.ts
▎ 120 lines

▸ ✓ grep needle
▎ 3 matches
```

工具分类逐项交回工具自己的组件绘制 Level 0（真实 header 行与内容预览行，通常两行），相邻工具之间恰好一个空行；点该项由该组件处理展开、copy 与局部折叠，UI 不复制工具状态、不重画其颜色与 copy 热区。容器（`codemode`、`python_eval`）与普通工具走同一条路径，保留容器自己的子调用看板；`children`/`childCount` 只用于统计，分组不把容器拆成顶层工具、也不合成子调用行。工具箭头与左导轨前的单个空格由工具布局拥有（`outputPad`），分组不重复加缩进。thinking 分类按非空连续 run 计项：一个 run 一个项，run 内多个 thinking block 以空行保留段落，中间出现工具/正文等不同内容则分成不同 run；每项为一行标签加约 20 个 grapheme 的预览（超出用省略号），项间一个空行，点开显示换行的完整文本；thinking 可见时直接平铺全文、无子项箭头。分类计数、预览、全文、成组权重使用同一 run 粒度。notice 的 preview 直接可见，只有真实 body 才带箭头并展开；普通原生 notify 正文只出现一次、左侧缩进、无子箭头；既没有 preview 也没有 body 的 notice 不画 pin、点击无效。

footer 是组内最后一行的**固定统计行**，运行态、完成态与被打断的 block 都只有这一种形态，不再显示工具状态行：

```text
▉▸ collapse views · 1m 12s · 20 calls
▉▸ notice · memory ×2 · …
▉▸ thinking x2 · 800 tokens
▉▸ read ×7 · grep ×12
▉requests ×3 · ↑24k · ↓1.5k · R20k · CH75.0%
```

footer 的 requests 与 ↑/↓/R/W/CH 和 header calls 覆盖同一个事实集合：本 block 的全部顶层单元，含组外尾项，也含正文/异常这类不参与聚合的 assistant 请求。token 部分沿用 Pi 原生 footer 的符号与字段：`↑input`、`↓output`、`RcacheRead`、`WcacheWrite`、`CH命中率`，各自只在该字段大于 0 时出现（没有任何测到的 token 时显示 `↑— · ↓—`）；同一请求的 partial/final 按组件身份只算一次。footer 不删除或隐藏原始内容，检查路径仍是分类详情、原始视图与 Ctrl+O。原生打断内容保持原位；每个新 block 从首次可观测成员开始独立计时。

### 2. 三个不同的边界

| 名称 | 定义 | 结束时的影响 |
| --- | --- | --- |
| Run | 一次公开 agent_start 到 agent_end 的 agent loop | agent_end 冻结所有仍活跃的 block 时钟 |
| Turn | Pi host 内一次模型响应及工具执行循环 | 不重置 run 时间，不自动断组 |
| Block | transcript 中连续、可聚合的活动展示段 | 收束局部统计和成员归属，不结束执行或 run |

原生 transcript 边界冻结当前 block，并为后续 block 建立独立时钟；resize、主题重绘和 renderer 重建不重置已创建的时钟。requests 是逻辑模型请求数，calls 是有效工具调用数，两者独立。

## User Stories

1. 作为 TUI 用户，我希望活动 block 使用稳定的标题与三类摘要，以便快速扫读工作进展。
2. 作为 TUI 用户，我希望当前或最后工具只显示状态和名称，以便容器代码与看板不持续挤占界面。
3. 作为 TUI 用户，我希望历史工具列表排除尾行工具及其子调用，以便不重复展示同一调用。
4. 作为 TUI 用户，我希望 header 仍包含整个 block 已完成的有效 calls，以便知道实际工具调用总量。
5. 作为容器工具用户，我希望有子调用时只计子调用、没有时才计父调用，以便数字反映实际工作。
6. 作为并行工具用户，我希望状态更新不改变调用身份或随 partial 抵达顺序跳动尾行，以便保持阅读位置稳定。
7. 作为 Python 用户，我希望容器自身的 Level 0 仍列出子调用，以便不用先打开父容器。
8. 作为容器工具用户，我希望独立打印输出、源码与脚本异常仍可检查，以便不因聚合而丢失证据。
9. 作为 TUI 用户，我希望 Thinking 显示独立估算 token，以便区分思考体量和 provider 的真实输出 usage。
10. 作为 TUI 用户，我希望隐藏思考时默认只看到简短预览，但能主动展开全文，以便隐藏偏好不变成删除正文。
11. 作为 TUI 用户，我希望 Notice 按提供者明确声明的类型统计，以便不依赖猜测正文的分类。
12. 作为 extension 用户，我希望未知 Notice 类型原样保留，以便新 extension 无需修改 UI 名单就能展示。
13. 作为 TUI 用户，我希望每次只打开一个分类和一个详情，以便界面保持紧凑。
14. 作为 TUI 用户，我希望从分类中的单项直接查看完整工具详情，以便不经过无用的中间预览层。
15. 作为 TUI 用户，我希望能切换到原始成员布局，以便检查聚合未展示的完整执行记录。
16. 作为 TUI 用户，我希望切模式时先折叠旧详情，以便没有隐藏展开状态在切回时突然出现。
17. 作为 regular 模式用户，我希望 Ctrl+O 仍能强制检查原始内容，以便不依赖 fullscreen 鼠标。
18. 作为 TUI 用户，我希望整个回合使用 h/m/s 时间，以便长回合仍易读且并行工具不会重复计时。
19. 作为 TUI 用户，我希望原生 TUI 内容打断 block 后时间连续，以便展示变化不冒充新回合。
20. 作为 TUI 用户，我希望已结束 block 缩成请求统计，以便释放高度但仍可展开查证。
21. 作为 TUI 用户，我希望 IN、OUT 的统计公式和 k/M 格式与原生 footer 一致，以便不混淆两处指标。
22. 作为 TUI 用户，我希望 CH 使用原生最后一笔 assistant 的缓存命中口径，以便不把它误当累计平均值。
23. 作为 TUI 用户，我希望同一请求横跨 block 也只归账一次，以便不重复统计 token。
24. 作为 TUI 用户，我希望迟到 usage 能补回原 block，以便断组和取消不丢失已知消耗。
25. 作为历史 session 用户，我希望已有 usage 可恢复而缺失时间明确显示未知，以便不看到伪造的历史耗时。
26. 作为窄屏或 Unicode 终端用户，我希望每行安全裁剪且保留完整检查入口，以便界面不溢出或损坏。
27. 作为多 session 用户，我希望 reload、fork、切换与卸载清理隔离，以便旧回合数据不会污染新 session。
28. 作为 extension 用户，我希望未启用或无法安全挂接时保留原生行为，以便展示功能不影响工具执行与错误传播。

## Implementation Decisions

### D1. Ownership 与控制流

- Pi host 拥有 session、原始 transcript、工具执行、全局展开、原生节点与滚动。
- ext-core 只承载无副作用的 ToolPresentation 结构化展示契约，不管理活动组、请求或运行时状态，不依赖具体 extension。
- 具体工具提供者拥有 args/result/details 的边界验证、子调用事实和错误语义；python_eval 由其提供者读取自己的持久化 trace。
- pi-ext-ui 拥有聚合投影、有效调用集合、block 时钟、block/request 关联、usage 快照、交互状态与布局。状态限定在所属 runtime/session，不建立通用任务账本。
- 数据流是原始 transcript 与工具结构化事实进入 UI 投影，再产生聚合或原始视图；不改写模型可见 content，不替换执行路径。

### D2. 已有挂接边界与回退

- 保留现有 toolGroups.enabled 设置，默认开启；停用后当前 session 恢复原展示。
- 只沿用两个已批准的 prototype seam：InteractiveMode.getRegisteredToolDefinition 用于发现所属 host 并挂展示投影，InteractiveMode.showExtensionNotify 用于保存每次原生通知。原方法的错误继续传播。
- 不增加 host hook、host 私有字段读取、thinking patch、全局输入拦截或磁盘补丁。既有 AssistantMessageComponent.lastMessage 读取边界不扩大。
- 仅 TUI 安装，HTML export、RPC、print 不安装投影。沿用 fullscreen 鼠标与 regular Ctrl+O；不扩展滚动能力。
- 同一连续段内 `notice / 2 + thinking / 2 + 顶层 tools >= 2` 即成组，不取整。thinking 与分类计数一致，按非空 thinking 项计，空 assistant/toolCall 占位不计；容器子调用不增加顶层 tool 数。4 notice、4 thinking、2 notice + 1 tool、1 notice + 1 thinking + 1 tool、2 tool 均成组。权重来自实际可聚合成员，与完成后才统计的 calls 独立；既有断组/回退边界不变。
- 正文、user、未知组件、图片与未知工具 renderer 维持原生断组/回退。异常终态不被吞掉。可识别 MessageView/notify 留组，不因每条通知都断组。

### D3. 有效调用、身份与历史/尾行分区

- 可验证地有子调用时递归展开其有效后代；没有子调用时计父调用。只展开实际工具容器，不进入 subagent 私有 session。
- 同一次执行的 live capture、persisted capture、result details 择一，不能相加；优先可信的完整结构化事实。
- 稳定 toolCallId 优先；缺少 ID 的历史使用父身份与原始序号区分。同名同参数的两次真实调用必须分别计数，不按参数去重。
- streaming、partial、完成、错误、取消均更新原身份，但只有观察到最后结果的调用进入计数：失败/取消的真实调用仍计一次，仍在输出 args/schema、刚开始执行或只有 partial 的调用不计。父转子时在其最终结果处原子替换父集合，父不重复计；无子调用完成后计父 1。
- host 的完成事实是 `isPartial === false` 且已存最终 result。`argsComplete` 只表示参数流结束（恢复历史从不设置），不能当作完成；也不以 `status === "ok"` 反推完成。
- 分类名称与 header calls 使用同一完成条件；未完成的工具仍留在工具列表并可展开检查，只是不贡献数字。历史列表为空计数时该分类行仍存在，标签退化为 `tools`。
- header calls 来自整个 block 的有效集合；工具分类只使用历史分区。尾行及其所有子调用不进入历史工具列表。
- 并行时尾行选择最近开始且仍活动的顶层调用，无活动调用则选择最后开始的调用；不由 partial 到达顺序决定。
- 尾行只画真实状态 glyph 和顶层工具名，无 pin、参数、源码、看板、copy 或点击展开；presentation 的 none 不能掩盖真实执行状态。
- 工具名按首次出现顺序聚合，保留命名空间。容器独立输出、源码、异常保留为不计 calls 的执行记录入口，原始视图始终保留原组件。
- 聚合消费结构化事实，不执行 renderer 猜计数、不解析 ANSI summary、不从输出文本猜工具调用。

### D4. Thinking 与 Notice

- thinking 分类行显示 `thinking xN · T tokens`；N 为实际非空 thinking 项数，沿用当前 assistant-message 项粒度，同项流式更新不增加次数；展开后每项只有一行预览（隐藏时）或平铺全文（可见时）。原始 thinking block 的独立身份仍待 00 定稿。
- Thinking 的总估算为所有 thinking 项文本长度之和除以 4 后向上取整。先求和再取整，不计 signature、JSON、标签、工具或正文。
- 流式完整快照替换旧值，不能当 delta 重复累加。provider usage 与思考估算独立，OUT 不再叠加该估算。
- `hide-thinking-block` 是初始展示偏好，不是删除正文的开关：隐藏时默认一行内容预览，点开显示全文；可见时直接平铺全文。投影始终保留原文，不写回 message、不修改 host 偏好，也不以 token 标签代替内容。
- Notice 每条真实通知计一次，更新原项不增加次数。MessageView 按 header.kind 精确值分类，未知值原样保留；原生 notify 只按 info/warning/error 区分，来源未知。
- 两类来源键分域，避免 MessageView 的同名 kind 与原生 notify 碰撞。按首次出现顺序显示统计，窄屏截断后缀。展开的详情（thinking 全文与 notice body）按缩进后的剩余宽度换行，长行不截断——用户展开就是为了读它。
- 不读正文或颜色猜类型，不把 tone 当 severity，不读取 stateHolder 私有数据或维护具体 extension 名单。第一版不新增 MessageViewSpec 分类字段，不增加类型过滤或分类子树。

### D5. 两层详情、原始视图与 copy

- 聚合中同时最多一个分类打开。工具分类逐项渲染工具自身 Level 0 行并转发点击给该组件；容器子调用不再合成行，容器组件保留自己的看板。
- thinking 分类逐项只有一行：约 20 个 grapheme 的预览（`▎` 导轨，隐藏时），点该行显示完整文本、再点首行收起，项与项之间不加空行；可见时直接平铺全文。Notice 的 preview 直接可见，只有 body 可展开（可展开时带 pin）；普通 notify 正文直接显示一次。两者都不新增第三层折叠。
- header 切原始成员视图，按 transcript 顺序保留原组件引用与两条 rails；切入/切出前均折叠全部内部项目，包括工具、MessageView 和巢状工具。
- 分类/单项互斥仅限聚合，原始视图沿用原生多项展开。Ctrl+O 优先强制展示原成员，关闭后回到全部收起的聚合视图，不恢复旧详情。
- 已结束 block 默认只显示 requests 行；点该行展开完整 frame，再点 header 收回单行。展开后仍可检查保存活动与原始输出，不新建独立的结果副本。
- 详情中的 copy 热区继续由原工具拥有，父级点击不能截获 copy 或误切模式。regular 通过既有 Ctrl+O 检查全文。
- copy 反馈只在写入 settle 之后出现：成功在 copy 槽显示 ✓，失败显示 error 色的 ✗，同样时间窗后回到 copy 图标；折叠父工具同时清掉本地与共享的标记，重新展开不会恢复 ✓。
- 状态变化后请求重绘；不得每次 render 都重置详情。选择对象进入尾行、被替换或消失时清除旧选择，不能按同序号继承给新项。

### D6. Block 时钟与收束

- 每个 block 在首个 live member 首次可观测时记录单调时钟起点；不同 block 不共享整个 run 的起点。
- transcript 边界冻结当前 block；后续 block 在首个 live member 出现时开始独立计时。agent_end 冻结所有仍活跃的 block 时钟。
- 稳定成员与时钟身份跨 transcript 重建保持；成员变化、resize、主题变化、Ctrl+O、renderer 重建和 host 重连均不重置已有时钟，已结束的 block 不重启计时。
- 恢复历史没有可观测的实时起点时显示 —。若实时内容加入该 block，时钟从 block 中首个实时成员的可观测时刻开始，不推算更早的历史时长。
- 时间向下取整到秒，省略前导零单位并保留低位单位，示例为 0s、9s、1m 05s、1h 02m 03s。不修改 ext-core 的工具 duration 格式化。
- 使用既有状态更新触发渲染，不默认新增跳秒定时器。
- 真实 transcript 边界或 agent_end 收束 block 成员和请求归属，不等于取消执行。之后的 partial 可更新已保存结果，但不重新打开旧 block。
- 每个新 block 的局部工具、thinking、notice、请求统计与时钟均独立开始；旧 block 仍可检查。
- 正常、取消和错误均在实际 transcript 边界或 run 结束时冻结时钟；session 离开时清理，不伪造成功结束。

### D7. 原生 footer 统计与紧凑格式

- 统计范围为该 block 归属的记录，不是整个 session/run；公式、usage entry 类型与格式均参考原生 Pi footer。范围是有意缩小，不能把 session 累计值复制到每个 block。
- 累计 `↑` 只加 usage.input，`↓` 只加 usage.output，`R`/`W` 分别加 cacheRead/cacheWrite，不重复加 Thinking 估算；CH 的分母仍是 input + cacheRead + cacheWrite。
- 沿用原生可计量来源：独立 usage、assistant usage、带 usage 的 toolResult、带 usage 的 branch_summary/compaction。单个记录只计一次，压缩不能让已归属的历史 usage 消失。未归属该 block 的记录不强塞进来。
- CH 取按原始记录顺序最后一条**测到 prompt** 的 assistant 的 cacheRead 占其 input + cacheRead + cacheWrite 的比例，既非累计加权平均，也非命中请求数比例；其他 usage 不改变该 assistant 的身份。
- 流式快照可能带全零 usage，那是占位而不是测量：它和缺失 usage 都不清空已知 CH，也不会让 CH 退回 —。真正测到的 prompt 缓存读为零时显示 0%，缺数据才显示 —；两者不共用占位。
- CH 最多一位小数，去掉 .0；已知缓存为零且原生显示条件成立时可为 0%。不在格式化前舍入 token 或比例。
- IN/OUT 使用原生十进制 formatTokens 规则：小于 1000 原数；1000 至小于 10000 为一位小数 k；10000 至小于 1000000 为整数 k；1000000 至小于 10000000 为一位小数 M；更大为整数 M。示例 999、1.0k、24k、1.0M、24M，含原生边界舍入行为，不擅自改成 K 或另一套阈值。
- 存在的错误/取消 usage 保留，不额外按 stopReason 排除。缺少真实 usage 时显示未知，不能把未完成或缺失测量当零。可确认没有请求/消耗与 usage 不可用是不同状态。
- 原生 response-status 仅保留最后响应并会清除，不作为 block 累计来源。不为复用格式化而导入 host 私有 footer；优先可用公共能力，否则局部同语义实现并做原生阈值对照。

### D8. requests 归属与迟到 usage

- 原生 footer 没有 requests 字段；本功能定义为该 block 归属的 assistant 逻辑请求数量，不是 HTTP attempts。工具数量、独立 usage entry、内部不可见重试不推断为新请求。
- 每个 assistant 请求只归属其首次关联的活动 block；跨原生边界时后续工具可进入新 block，但请求与 usage 不重复归账。纯正文没有活动 block 时不为此创建工具卡。
- 用稳定请求/entry 身份更新记录，message_update 不累加快照；正常、错误、取消的已观测请求按身份各计一次。
- block 收束后若最终 usage 迟到，只补回原 owner。未结算时显示待结算或未知字段，不移账给当前 block。
- CH 按原始请求/entry 顺序决定最后 assistant，不能因旧响应晚到就覆盖较新的响应。独立 usage 与摘要必须有可检查归属；无法可靠关联时不凭抵达时间猜测或重复分摊。

### D9. 公共展示契约方向

- ToolPresentation 增加可选结构化子调用事实，包含实际可用的稳定 ID、工具名、args、result、状态、duration 与后代；缺字段表示事实未提供，不能伪造空结果或成功。
- python_eval 提供者复用自身 details 解析；codemode 复用现有 capture/details 事实。UI 不复制 Python 私有解析，不新增重复持久化格式或具体 extension 依赖。
- ToolView 提供 UI 内活动快照与显式折叠控制，MessageView 提供 UI 内详情投影/收起能力；不扩大 MessageViewSpec 的公共折叠层数。
- 旧提供者未提供子调用事实时仍能原生显示；仅有历史摘要时保留摘要，原父结果可检查。tracker 的有界缓存不能成为历史唯一来源。
- 确切 TypeScript 类型与边界验证在实现时靠近契约记录；本 spec 不预建 registry、事件总线、通用 adapter 或额外配置。

### D10. 生命周期、恢复与渲染安全

- runtime 按既有 UI 身份隔离；清理幂等，reload/shutdown 恢复仍由本功能拥有的方法，别的 extension 覆盖时不反向覆盖并报告冲突。
- session 切换、树替换、fork、compaction、reload 按原始身份重建投影，不从首次 render 发明时间。新 session 不接收旧 run 回调。
- 不新增 timing、block、request 或展开状态的磁盘持久化，不增加迁移。已有 entry usage 能恢复就恢复；缺少可靠回合起止或 block 归属时明确未知，不猜时间或重复计量。
- 原生 notify 不新增持久化，已有 MessageView 继续从自己的 entry 恢复。缺少完整历史子调用不重跑脚本或读取 workspace 补造结果。
- 使用主题语义 token，颜色不作为唯一状态信号；行必须 ANSI/Unicode/单元格宽度安全，一元素一终端行，窄屏裁剪而不丢失全文入口。
- 使用既有组件缓存与 repaint 合并/节流能力，不引入私有刷新窗口、后台任务、全局锁、通用 store 或滚动 patch。

## Testing Decisions

### T1. 首选最高测试 seam

主 seam 复用现有 Pi host transcript 投影测试：从公开 extension 生命周期、工具提供者和原生节点驱动，断言用户实际看到的行、统计、鼠标/copy 与 Ctrl+O 行为。工具私有 details 解析测试留在所属提供者；公共展示契约通过真实消费者接线验证，不为测试新增 host hook。此测试方向沿用已批准的现有 seam 与跨包范围。

辅助纯函数测试仅固定易错语义：有效叶调用选择、h/m/s 边界、原生 k/M 阈值、最后 assistant CH、去重和迟到归账。避免断言私有 Set、字段布局或组件实例数量；同一行为可重构实现而不改测试。

### T2. 聚焦验收场景

| 场景 | 必须观察到的行为 |
| --- | --- |
| 无子调用到出现两个子调用 | 父 1 call 原子替换为子 2 calls，无重复父项 |
| 相同名称与参数执行两次 | 两次独立调用，partial 不增加第三次 |
| Python trace 与 codemode capture | 容器自身 Level 0 可查全文；来源择一；父输出/异常仍可查 |
| 并行工具与尾行 | 最近开始仍活动的顶层工具为尾行；其他状态保留 |
| 分类/详情/模式切换 | 一个分类、一个详情；切模式全收起，copy 不切组 |
| Thinking 流式与隐藏策略 | 快照替换、不含 signature；隐藏时预览可展开全文，可见时平铺 |
| Notice 类型 | exact kind，未知原样保留，notify 级别独立，无正文猜测 |
| 原生边界与后续 block | 旧 block 请求行、新 block 局部计数、独立 block 时钟 |
| 重绘/resize/Ctrl+O | 不断组、不重计时、不重复归账；退出强制展开不恢复旧详情 |
| 多 turn/并行/取消/错误 | 时钟连续，真实 run 结束冻结，已知 usage 保留 |
| 多 usage entry 类型 | 对应原生 entry 扫描结果，单条只计一次，压缩前消耗不丢 |
| 多请求 CH 差异 | 跟最后 assistant 一致，不跟累计加权值混淆 |
| 最后 assistant 零输入 | CH —，不复用上一条百分比 |
| 边界舍入 | 原生 999/1000/9999/10000/999999/1000000/9999999/10000000 一致 |
| 横跨 block 与迟到 usage | 只更新原 owner；旧响应不覆盖较新 assistant CH |
| 历史缺少时间/全文/归属 | 明确未知或详情不可用，保留原始检查入口 |
| 窄宽布局、ANSI、Unicode、主题 | 每行宽度安全，交互坐标正确，无换行泄漏 |
| 多 runtime/reload/fork/卸载/冲突 | 无串 session、悬挂回调、半安装或吞原方法异常 |

### T3. 验证层级

- 每个实现 ticket 使用改动文件 Biome、受影响测试与受影响 package build；不要以最终集成项替代逐项验证。
- 公共 ToolPresentation 与跨 package 提供者改动升级根 typecheck；范围与触发原因写入 ticket 完成记录。
- host 投影与 Ctrl+O 路径执行受影响真实 CLI/PTY 集成测试，覆盖 regular/fullscreen，核对最低支持版本及已声明支持的产物；不能把单个安装版本的源码检查当作兼容性通过。
- 代码修改后更新 Graphify AST，不因文档收尾自动跑全仓 test/check。
- 本次仅产出文档，不运行 TypeScript、build、测试或图谱 AST 更新；实际检查命令与结果写最终报告。

## Out of Scope

不新增 extension/package、依赖、Notice taxonomy/subtype 公共协议、类型过滤、第三层折叠、单容器自动成组、HTTP attempts 计数、隐藏网络请求推断、run timing 持久化或旧数据迁移。不改 Pi host 文件、全局 thinking 偏好、滚动实现、工具权限或执行语义。不创建通用任务/请求服务，不引入新 host seam、兼容适配层或推测配置。

不授权 commit、push、tag、发布、外部 issue 创建或部署。文档中的目标与草案 ticket 不表示功能已上线。

## Further Notes

- Q1–Q6、完成态单行、block 局部范围与逻辑 requests 口径已通过对话确认；IN/OUT/CH 以前案为准的旧建议已被原生 footer 口径取代。
- 现有实现仍以逐成员 summary 为主，本 spec 是下一版目标；实施时保留工作区已有的无关改动。
- 原生统计依据为本次检查的已安装 Pi host footer 与 usage-totals；实现阶段仍须核对项目声明支持的版本，发现公共事件/usage 差异时先报告，不静默提高最低版本。
- 仓库暂无正式 tracker 配置，已有本地逐项 Markdown tickets 先例。本工作线使用 .scratch 下独立 feature 目录，拆分确认前仅保存草案，不标记 ready-for-agent、不发布外部 issue。若要配置正式 tracker，运行 /setup-matt-pocock-skills。

## 实现记录

已落地：

- 活动 block 的 `collapse views · 用时 · N calls` header、非空分类行与固定统计 footer；组外壳是原生 `Box` 背景块，header 下与 footer 上各一条组级横向 rail（ticket 12）。
- 尾项高度下限（无状态）：`TailUnit` 只做分隔归一化与鼠标转发，不再保留历史最大高度，也不再跨 `rebuild()` 缓存——每次重建新建一个。本帧把内容行补到总高度下限：`Tool backgrounds` 打开时 4 行，关闭时 2 行；工具自身背景的上下 padding 计入内容行，补出来的空行落在完整色块之后，不截断、不记忆历史高度。行首语义分隔与独立的 OSC 标记行（`visibleWidth === 0`）不算内容行，正文内部空行照算；补出来的行不属于任何 surface 或命中区域，带 `{ kind: "none" }`，不响应点击。尾项身份取未断开段里最后一个可见成员（空 thinking run 与空 assistant/toolCall 占位都不算，`[...members].reverse().find(...)`），未达到成组门槛的段平铺成员后仍把尾项交给 `TailUnit`，所以成组前后规则一致；正文断组时尾项不再单独展示，下限也不转移给组。
- 组外尾项（ticket 04）：只有 transcript 最后一个可见顶层单元留在组外，按原组件 Level 0 显示，组与它之间恰好一个空行；新可见单元到来时旧尾项一次性归组，`agent_end`、resize、主题与纯 usage/状态刷新都不改变归属，并行完成顺序也不重排。尾项是工具、thinking run 或 notice，空 assistant/toolCall 占位不成为尾项。
- 展开工具分类按工具自身 Level 0 逐项渲染（相邻一项一个空行），容器也由自己的组件绘制，`children`/`childCount` 只参与统计；工具箭头与导轨前的单空格由 `outputPad` 拥有。
- 展开 thinking 分类为每项一行约 20 个 grapheme 预览（隐藏时）或平铺全文（可见时），点行展开/收起，项间不加空行；notice 的 preview 直接可见，只有 body 可展开，普通 notify 正文只出现一次且无子箭头。
- 每个 block 从首次可观测实时成员开始单调计时；原生断组冻结当前 block，后续 block 独立起算，agent_end 冻结所有活跃 block；没有可观测起点的恢复历史显示 `—`。ticket 10 补充：重绘、成员变化重建与重新连接宿主均保留已建立的 block 时钟。
- 容器子调用来自提供者的结构化事实（codemode 的 captured calls、python_eval 的 trace rows），只用于有效调用计数与分类名称统计，不再合成子调用行。ticket 10 起只有观察到最后结果（`isPartial === false` 且有 result）的工具进入计数：schema/args 流、执行开始、partial 结果都不计，容器在其最终结果处用有效子数原子替换父计数。
- Thinking 的字符估算与逐项预览/全文；`hide-thinking-block` 只决定初始展示形态。Notice 按 `header.kind` 与 notify 级别分类，正文与 preview 由 notice 自己布局。
- footer 始终是 `requests ×N · ↑… · ↓… · R… · W… · CH…`（字段按 Pi 原生规则省略），只有一行、不切回工具状态行。ticket 04 起请求事实按 block 收集而不是按可展示成员收集：正文/异常/仅 toolCall 的 assistant 请求也归入它结束的那个 block，partial→final 按组件身份只算一次，`↑` 只累加 input、`↓` 只累加 output，`R`/`W` 各自累加对应缓存字段。ticket 10 起 CH 只跟随最后一条测到 prompt 的 assistant：流式零占位与缺失 usage 不清空已知值；block 完全没有缓存活动时不显示 CH（与 Pi 原生一致）。
- 原始成员视图、Ctrl+O 强制展开、单分类／单详情互斥、切换模式时收起内部项目。ticket 05：展开视图不再画组级 rail、不再丢 footer，header 保留；相邻成员之间显式补一个空行（组件自带的 leading 空行先剥掉），正文内部空行原样保留。
- ticket 12：收起态是一个 `Box(0,1)` 背景块（header、分类、footer 同一底色），token 取 block 自己的结算事实（任一 error → `toolErrorBg`，否则 `toolSuccessBg`；未结算 → `toolPendingBg`），结算后保持 5 秒再回到 `toolPendingBg`，之后的调用不重置这个 hold；header 下与 footer 上各一条 `borderMuted` 组级 rail；局部分类展开仍在同一个 Box 内。整组展开时只有标题保留背景块（footer 统计并入标题行、标题后固定一行空行），成员区外层透明、无组级 rail，工具与 thinking run 不填背景，notice 的 `customMessageBg` 由 `MessageView` 拥有；组层不 strip 子组件 ANSI。`paddingX=0` 避免与工具 `outputPad` 双重缩进；`paddingY=1` 只在组底色内加一行上下留白；组前空行在 Box 之外所以不着色。 底色填充在每个子组件 reset 之后重新开始并补到整行宽度，否则一行里第一个 `\x1b[0m` 之后的文字会失去底色。 工具自身底色是可选项：`Tool backgrounds` 打开后工具用 Pi 原生底色与上下 padding、去掉前导导轨，组外壳保留自己的底色，两者按最内层优先嵌套。
- thinking run 粒度：连续 thinking block 合成一个成员（`parts` 保留原始组件，`component` 是第一个，身份稳定），段落以空行保留；中间出现工具/正文则分成不同 run。分类计数、预览、全文与成组权重都用 run 粒度。
- 模块边界：`tool-group-view.ts` 只负责 block 内布局、统计与命中测试，`host-transcript-patch.ts` 只负责 host seam、成员提取与安装/卸载。
- 语义着色（ticket 06）：词汇与 token 表见 [DESIGN.md](../../DESIGN.md) 的 Semantic color table。工具行由 `formatToolHeaderText` 统一给出 `状态字形 + toolTitle(bold(名称)) + 摘要 + dim(meta)`，摘要语义由拥有该工具的层提供（read 的 accent 路径与 warning 行范围、bash 的 toolTitle+bold 命令），分组不按工具名补色、不合成着色子行；容器看板通过 `NestedCallsView.headerSummary` 复用同一语义。分组 header 与分类标签用 `text`（展开时 `accent`）、rails 用 `borderMuted`、统计仍 `dim`，notice 的 `info` 正文用 `text`。`renderer.ts` 不再 `render(120)` 后去 ANSI 取首行反推原生 call 行。
- 实时工具的 spinner 占该行的前导槽：live 时显示 200ms 轮换的 `· ✢ ✳ ✶ ✻ ✽`（streaming 用 `muted`、running 用 `accent`），结算后才回到 `▸`/`▾` 折叠 pin，一行不会同时出现两个状态字形。容器（`codemode`、`python_eval`）在生成中和「运行但还没有子调用」时保持 spinner，一旦列出子调用就换回 `▸`。帧由 `performance.now()` 按共享时钟换算，所以状态切换不重置相位。重绘不再由 extension 的 ticker 驱动（`tool_execution_start`/`tool_execution_end` 计数与定时器已删除）：画出 live 字形的那一帧自己拥有下一帧——`ToolView` 与 `NestedCallsView` 在画到 live 行时各设一个 200ms 自终止定时器（`#requestNextFrame`，`unref()`，已有定时器不重复设），结算后不再排下一帧。因此缓存键必须包含当前帧：`ToolView` 的键含 `glyph`，`NestedCallsView` 的键含看板整帧的 `frame`（没有 live 子调用时是空串）；`collapsedRows` 是组件而不是字面行时 `ToolView` 直接跳过缓存（`bodyOwnsItsClock`），因为子组件有自己的时钟，父级折叠 pin 不变不代表子行没变。
- padding 只有一层所有权：`outputPad` 由画外壳的那一层加一次。ToolView 用 `context.outputPad` 排自己的行，但它交给被包裹的原生 renderer 的 context 是 `outputPad: 0`（`NestedCallsView` 交给子调用 body 时同理，父级已经缩进过），否则同一个设置会被计两次。声明 `renderShell: "self"` 且不再被外层包裹的 renderer（如 hindsight MCP 行）必须自己读 `context.outputPad`。notice 与 `MessageView` 没有 render context，pad 直接取 host 的 `outputPad` 设置（未设置时是 1，与 `SettingsManager.getOutputPad()` 同口径），每次渲染都重新读，所以中途改设置不会让旧行停在旧缩进。
- 容器在等待期间就能列出子调用：嵌套的 `tool_execution_start`/`tool_execution_end` 事件按 `parentToolCallId` 重新触发父行的 invalidator，宿主据此重建父行，于是只在结束时才报告 facts 的容器（`python_eval`）也能在运行中显示正在执行的子行（星形 spinner），父行此时只画 `▸`。父行 invalidator 由 renderer 每次渲染时登记，顶层 `tool_execution_end` 后丢弃，表按 200 条上限淘汰。
- thinking 的 rail 共享：thinking 没有自己的 surface，所以在所有折叠层级沿用与工具相同的 `▎` 前导槽（`#thinkingPrefix()`：`dim` 的 `▎` 加一个空格），预览行与全文换行行都从这两格开始算宽度。block 填了自己的底色（`Tool backgrounds` 打开或展开块由组补中性底色）时，底色已经界定块边界，rail 让位给两格空格，避免底色里多出一条竖线。同一前缀同时决定截断宽度（`width - 2`），所以切换底色不会让 thinking 行宽度跳变。
- 每帧都重新解析 transcript（`rebuild()`）而不是缓存投影：host 没有提供「transcript 已变化」的信号——`Container.addChild` 不触发 invalidate，宿主只调 `requestRender()`，而那与宽度变化、我们自己的重绘无法区分。实测 200 个成员（40 组）每帧 0.100 ms，200 × 20 KB thinking 时 0.241 ms，都低于未分组时的 0.133 ms，因此不为缓存引入可能过期的信号；若将来成为瓶颈，正确做法是 host 暴露 transcript revision，而不是按组件 identity 缓存。

已知缺口（后续单独处理）：

- 未知工具（ticket 09）尚不能从 UI 边界区分：嵌套子调用记录只有 name/summary/status/duration，没有解析事实；顶层未知工具已因没有 ToolView renderer 而断组且不计数，但容器内全部未知的子调用仍会被计入，需提供者或持久化补充解析事实后再实现。
- 每个 block 仅保持自身首次可观测时钟，不切换到其他 block；原生边界建立新 block 时钟，agent_end 冻结活跃 block。
- 请求统计覆盖 block 内全部 assistant 请求（含正文/异常等不展示的请求）；带 usage 的 toolResult、branch_summary、compaction 记录仍是断组边界，不计入任何 block。
- thinking 子项按连续 run 建项（一个 run 一个项，段落以空行保留）；容器子调用只由容器自己的看板展示，不重建子工具的 ToolView。
- 折叠层级仍由 group 的本地开关与 Pi 的 global expand 决定，未实现工具级的 `maxLines` 覆盖。
