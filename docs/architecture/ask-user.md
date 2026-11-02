# ask_user 架构

## 状态

本文件记录 `@hheei/pi-ask-user` 的模块边界与不变量。上游 fork 来源、参数契约和迁移
差异见 [`packages/pi-ask-user/README.md`](../../packages/pi-ask-user/README.md)。

## 目标与 ownership

`ask_user` 让模型在一次工具调用里向用户提问，并把结构化答案交回模型。它拥有：

- `ask_user` 工具定义（schema、描述、prompt 指南）与模型可见的文本结果；
- 交互式提问 UI（inline 呈现；单选、多选、自由输入）；
- 批量提问（2–4 个独立问题 + review 页）；
- 无自定义 UI 时的 dialog 回退（RPC / print）；
- `ask:answered` / `ask:cancelled` 事件的载荷构造。

它不拥有：Pi host 的 session、editor 与 surface 生命周期；TUI 基础组件；surface 互斥与
程序状态上报（由 ext-core 的 `openTuiSurface` 与宿主提供）。

## 模块边界

```text
index.ts            扩展入口：注册工具
tool.ts             registerTool：schema、描述、分派
presentation.ts     呈现事实（summary/sections/collapsedRows）与原生 renderers
execute.ts          executeSingle + executeBatch + runInteractive：事件、结果组装、取消语义
schema.ts           参数类型、选项归一化、批量问题归一化
response.ts         响应/结果类型、响应构造器、模型可见摘要
format.ts           单问/批量答案与结果的文本渲染
shortcuts.ts        按键匹配（up/down + tab/shift+tab）、数字键（digitKey）
constants.ts        跨模块共享常量
option-rows.ts      选项行模型：freeform 行索引、光标移动、可见窗口（泛型行）
multi-select-list.ts
                    多选列表组件：勾选状态、提交语义
single-select-list.ts
                    单选列表组件：单列选项行、分页指示
single-select-layout.ts
                    单选行渲染：行种类（option/description/helper/indicator）、折行与分页
ask-prompt.ts       单问组件：模式状态机（select / freeform）、键分发、提交/取消、渲染编排
prompt-layout.ts    纯布局：终端高度上限与 rail 行
prompt-help.ts      纯提示文本：一张键位表按模式拼出一行 dim 提示（含 formatKeyList）
prompt-context.ts   context 面板：折叠判定、展开状态、切换键、文本
batch-prompt.ts     批量组件：页头（页位 + ⇥ questions）、分页、review 页、跳过确认
dialogs.ts          ctx.ui.select/input 回退（含按 stage 的 deadline 与取消判定）
custom-prompt.ts    surface 生命周期、deadline、调用方 signal 转发
events.ts           事件发射（脱敏载荷）
```

依赖方向（单向，无环）：

```text
index → tool → execute → { ask-prompt → { prompt-layout, prompt-help,
                                          prompt-context, lists → option-rows }
                           batch-prompt → ask-prompt
                           dialogs, custom-prompt }
tool/execute → { schema, response, format, events }
tool → presentation → { format, response }
```

`ask-prompt` 与 `batch-prompt` 只依赖叶子模块；`execute` 是唯一把 UI、回退和事件串起来
的编排层。`prompt-layout`、`prompt-help` 是纯函数模块：输入是行数与状态快照，输出是行
数组或文本，因此布局规则可以直接单测而不必驱动整个组件。新增行为优先落在对应叶子模块，
不要把它们之间的依赖反过来。

## 数据流

```text
execute(params, ctx)
  ├─ schema.normalizeBatchQuestions / coerceOption      校验与归一化
  ├─ events.createAskEventEmitter                       事件载荷构造
  ├─ custom-prompt.runCustomPrompt(pi, ctx, request)   生命周期唯一入口
  │    ├─ 有 createComponent 且 ctx.mode === "tui"
  │    │                     → ext-core openTuiSurface  自绘组件（单 surface 互斥）
  │    ├─ 无 createComponent → 宿主原生 input 对话框    无选项的单问
  │    └─ 其它 mode          → dialogs.askViaDialogs      RPC 回退
  └─ 组装 AskToolDetails / AskBatchDetails → 模型可见文本 + 呈现事实
```

批量路径把每个问题渲染成 `AskComponent` 的一个页面，只有 review 页提交才产生答案；
中途取消（esc、abort、timeout）不发布任何部分答案。

## 不变量

- **取消与清理**：`custom-prompt` 独占 deadline、调用方 signal 转发与 surface 释放；取消后
  不再发布事件或结果。
- **surface ownership**：TUI 呈现走 ext-core `openTuiSurface`，同一 Pi runtime 同时只允许
  一个 surface（第二个请求得到 `TuiSurfaceBusyError`）。组件不得在 surface 结算后继续使用。
- **回退优先级**：`ctx.mode !== "tui"` 或请求没有 `createComponent` 时直接走宿主对话框，
  不尝试 `ui.custom()`；所有路径共享同一 deadline 与调用方 signal 转发。自绘 surface 通过
  ext-core `openTuiSurface` 的 `blocked: { kind: "question", message: "Waiting for user response" }`
  上报等待状态，宿主据此写入 OSC 7501 程序状态（回退对话框由宿主自身上报）；本包不再发布
  私有事件。取消后宿主若仍返回答案，`execute` 以 signal 为准丢弃它。
- **跨仓契约**：dialogs 的哨兵字符串与 placeholder 是 paseo 的匹配依据，见
  [`docs/plans/pi-ask-user-integration-audit.md`](../plans/pi-ask-user-integration-audit.md) §6。
- **键位语义一处**：`digitKey` 属于数字跳转，列表自己不再解析按键字符串。
- **批量入口有且只有一种形状**：`questions` ≥2 条走批量；1 条在 `tool.ts` 解开成单问（模型常把
  单问包进数组），0 条或 >4 条在打开 UI 前报错并说明怎么改。`questions` 与顶层
  `context`/`options`/`allowMultiple`/`allowFreeform` 同时出现时，顶层值被忽略而不是报错：
  严格 provider 会用空默认值填满每个顶层属性，报错会让模型原地重试（#88）。
- **渲染安全**：所有行按单元格宽度折行/截断（`wrapTextWithAnsi`、ext-core `fitRow`），
  终端高度上限由 `prompt-layout.getMaxRenderLinesForRows` 计算；窄宽度与短终端必须仍能
  看见问题、context 摘要和一个选项。列表行自带 `kind`（option/description/helper/
  indicator），样式按种类决定，不嗅探行首字符。
- **原生 rail，无外框**：prompt 与 review 页用两行满宽 `──`（`borderMuted`）夹住内容，
  和 `pi-ext-ui` 的 tool group 完全一致：rail / 内容 / rail / 提示脚注。不画 `╭─╮` 圆角、
  标题框或版本标签。rail 行由 `prompt-layout.railRow` 唯一产出。批量页的页位信息是 rail 内、问题之前的一行 dim 页头（`AskComponent.setBatchChrome`）。
- **键位提示一处**：`prompt-help` 的键位表是唯一来源，按模式输出一行提示；键名用
  `↕`、`↵`、`⎋`、`␣`、`⇥`，可配置的 confirm/cancel 走 `keybindings`，提示随重映射变化。
- **事件是通知**：事件只携带问题与响应种类，context 和实际答案留在工具结果里（#51）。
- **呈现是事实**：`presentation.ts` 只描述 summary、status、sections、collapsedRows 和
  可复制文本，不拥有边框与折叠。安装 `@hheei/pi-ext-ui` 时由它的 frame 渲染 0/1/2 折叠
  层级；未安装时由 ext-core 的原生 renderers 输出纯文本。
- **没有隐藏状态**：提问期间不提供隐藏浮层、搜索过滤或备注二次输入；用户看到的提示就是
  当前唯一的输入源，取消只有 esc / ctrl+c / abort 三种入口。

## 测试布局

`test/` 按模块职责划分，共享夹具在 `test/fixtures/harness.ts`（tool 注册、主题、键位、
环境变量、批量挂载、`customUI` surface 适配、`runPrompt` 驱动）与 `test/fixtures/fake-host.ts`
（host/TUI/typebox 替身）：

`runPrompt(params, drive, { rows, width, keybindings })` 挂载工具打开的提示，`drive` 里用
`press(component, ...keys)` 按键、`record(label, width?)` 记录一帧；返回 `frameOf(label)` /
`rowsOf(label)` 与工具结果。同形用例写成一个 `test.each` 矩阵（布局、按键），不再复制挂载
样板。deadline 用例用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，不要替换全局
`setTimeout`。

`ctx.mode` 决定走 surface 还是 dialogs：需要自绘组件的用例传 `mode: "tui"`，验证
dialog 回退的用例传 `mode: "rpc"`。`customUI()` 模拟 `ctx.ui.custom`：组件调用完成回调
时以该结果结算；回调未完成就返回时，返回值作为答案（`null`/`undefined` 视为取消）。

```text
tool.test.ts           工具注册、执行、结果渲染
schema.test.ts         参数校验、选项归一化、typebox shim
context-pane.test.ts   context 折叠、展开、编辑器按键
ask-prompt.test.ts     编辑模式与帮助文本
single-select-list.test.ts / multi-select-list.test.ts / single-select-layout.test.ts
dialogs.test.ts        RPC 回退
cancellation.test.ts   abort / timeout 语义
batch-prompt.test.ts   批量分页、review、跳过确认
events.test.ts         事件载荷脱敏
prompt-layout.test.ts  终端高度上限
option-rows.test.ts    选项行索引、光标移动、可见窗口（单选与多选共用）
shortcuts.test.ts      select 导航按键、数字键（纯函数）
presentation.test.ts   调用/结果/批量/取消的呈现事实
```

新增用例放进对应职责的文件；跨文件共享的替身放 `test/fixtures/`，不要复制。
