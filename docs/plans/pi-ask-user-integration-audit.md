# pi-ask-user 集成与架构盘点

状态：只读盘点结论（快照）。未修改任何代码；本文件记录发现与建议顺序，作为后续重构的输入。

范围：`packages/pi-ask-user/`（20 个 src 模块，3986 行；13 个测试文件，4486 行），
对照 `packages/pi-ext-core/` 与 `packages/pi-ext-ui/` 已提供的公共能力。

## 1. 生态集成现状

`pi-ask-user` 对 ext-core 的全部依赖是 2 个符号，均来自 `json-settings`：

```text
packages/pi-ask-user/src/preferences.ts
import { defaultExtensionSettingsPaths, readMergedJsonSettingsSection } from "@hheei/pi-ext-core";
```

这是仓库内集成度最低的包。对照表：

| 能力 | 提供者 | ask_user 现状 | 仓库内使用者 |
|---|---|---|---|
| settings 文件分层合并 | ext-core `json-settings` | 已使用 | 多包 |
| settings 注册与设置页 | ext-core `settings.ts` `registerSettings` + `pi-settings` 页面 | 缺失：7 个偏好只能手改 JSON | 8 个具体包 |
| TUI surface 生命周期与互斥 | ext-core `openTuiSurface`（单 active surface、abort → `{status:"aborted"}`、`withHiddenOverlay`、`beforeRelease`、`TuiSurfaceBusyError`） | 自建 `custom-prompt.ts`（173 行） | pi-loadout |
| 错误整形 | ext-core `errorMessage` / `abortError` / `throwIfAborted` | 手写 `error instanceof Error ? …`，18 处裸 `?.aborted` | 多包 |
| JSON 记录窄化 | ext-core `isRecord` | 手写 `typeof === "object"`、`(entry ?? {}) as {...}` | 10+ 包 |
| 行宽适配缓存 | ext-core `fitRow`（text+width 缓存，避免每帧重算 grapheme） | 33 处裸 `truncateToWidth` | ext-ui、loadout、settings、status |
| 布局常量与滚动数学 | ext-core `pad` / `calculateScrollTop` / `LIST_HINT_ROWS` / `WIDE_COLUMNS` | 自写 `padLine`、自算 scroll offset | 多包 |
| 滚动条 | ext-core `panelScrollbar` | 自绘 `↑ ↓ ↕` 标记 | 部分包 |
| 工具渲染契约 | ext-core `createToolPresentationRenderers` + ext-ui `createToolView` / `ToolView` / `transitionFoldLevel`（0/1/2 折叠） | `tool.ts` 手写 `new Text(...)`，仅 `expanded` 二态 | apply-patch、bg-bash、ext-memory、ext-tools |
| prompt 段落注入 | ext-core `setSectionBullet` / `setOptionalToolBullet` | 使用 `promptSnippet` / `promptGuidelines`（可接受） | 部分包 |

不适用：widgets、background-delivery、page-router、model-selection、process、output-tail、
context-usage、tool-output、extension-point、service、render-throttle、diff-view、
message-view、nested-calls-view。

结论：可直接替换的是 `openTuiSurface`（生命周期 + 互斥）、`errors`、`isRecord`、`fitRow`、
`pad` / `calculateScrollTop`。设置页属于能力缺口，不是重复实现。

## 2. 架构：模块深度不足

上一轮拆分解决了"单文件过大"，未解决模块深度。

- `AskComponent` 仍是 897 行 / 42 方法的无接缝巨类：overlay 与 inline 两套布局、溢出标记、
  Editor 懒创建、草稿保存、滚动、键分发、帮助文本、批量 chrome、两个列表懒创建。对外接口窄
  （`render` / `handleInput` / `focused` / `setBatchChrome` / `invalidate`），但内部没有可单独
  验证的接缝。切法应为 `PromptFrame`（纯布局与预算）→ `PromptModes`（select/freeform/comment
  状态机）→ `PromptChrome`（标题/帮助/批量）→ `AskComponent`（组合）。
- 14 个位置参数的构造函数（`tool.ts`、`batch-prompt.ts` 各调用一次），参数顺序即契约。
  `PromptSettings` 已可直接传入。
- 单问流程存在两条实现：`tool.ts` 内联 execute（dialog 分支 + custom 分支 + 5 份 details
  字面量 + 2 次 `as`）与 `execute.ts` `executeBatch`。设置解析、事件发射、取消判定、details
  组装各写两遍。应收敛为 `askOnce` / `askBatch` 共用 `runPrompt`。
- `format.ts` 混装两个消费者：模型可见纯文本（`formatBatchAnswers`、`formatBatchForMessage`）
  与 TUI 彩色渲染（`formatOptionMarkers`、`formatBatchResult`，需要 theme 与宽度）。
- 列表逻辑双份：`single-select-layout.ts` 与 `multi-select-list.ts` 各自实现选项块、备注开关行、
  自由输入行、视口窗口，10 个同名方法。应为 `OptionRows`（选项 → `AnnotatedRow[]` 纯函数）+
  两个只保留选择语义的列表。
- `preferences.ts` 把 section schema、优先级解析、shortcut 组装合成一个 129 行函数。

## 3. Code smell

### 3.1 monkey-patch 与兼容 shim

1. `schema.ts` `StringEnum`：probe `Type.Optional(Type.Unsafe(...))` → catch → union 路径 →
   sniff `.describe` / `.default` 链式方法 → 两次 `as unknown as`。为一个 5 行 helper 承担三套
   宿主 schema 实现；本仓 typebox 单一版本 1.3.27。
2. `theme.ts` `safeMarkdownTheme`：调用 `md.bold("")` 强制触发宿主 theme Proxy 才判定可用
   （上游 issue #17：跨 scope 双份包导致单例未初始化）。应改为启动时校验一次。
3. `tool.ts` `const modelOnly: Record<string, unknown> = { exposure: "model-only" }` + spread，
   为"1.0 之前 host 忽略该字段"保留；peer 已是 1.0.2。
4. `custom-prompt.ts` `buildCustomUIOptions` 的 `default` 分支整段复制 overlay 分支，并留有
   `const _exhaustive: never` 死代码。
5. `schema.ts` `coerceOption` 的 6 个标题别名键（title/label/text/value/name/option）：真实边界
   （proxy 剥 schema），但兜底逻辑与正常路径混在同一函数。

无 prototype 改写、无 `globalThis` 注入、无 `Object.assign` 补丁。仓库内真正的宿主补丁在
`packages/pi-ext-ui/src/host-transcript-patch.ts`，与 ask_user 无关。

### 3.2 防卫式

1. `dialogs.ts` 8 处 `dialogOpts?.signal?.aborted`，每个 stage 后重查；`dialogStageOptions` 用
   `null` 哨兵表示 deadline 已过。取消传播应统一为 `throwIfAborted(signal)`。
2. `custom-prompt.ts` 4 处 aborted + `customCompleted` + `hasAnnouncedHide` +
   `customResult !== undefined` 四重完成保护，`openTuiSurface` 已覆盖。
3. `execute.ts` 同时存在 `AbortController`、deadline timer，以及 dialogs 内部再算 `remaining`。
4. `tool.ts` execute 两次 `signal?.aborted` 早返回并构造两份 `as AskToolDetails`。
5. `frame.ts` `Number.isFinite(rows)`、`single-select-layout.ts` `!Number.isFinite(maxRows)`。
6. `shortcuts.ts` 非法 spec 静默跳过，最终回落 disabled：用户写错 `overlayToggleKey` 得到
   "快捷键消失"而不是提示。
7. `shortcuts.ts` `isValidShortcutSpec` 正则预校验后再交给 `matchesKey`。
8. 保留：`preferences.ts` `parseAskUserSettings` 白名单——不可信文件边界，正确。

### 3.3 真 bug

`single-select-layout.ts` 的 `wrapText` 按 `String.length` 折行，而包内其它路径
（`multi-select-list`、`single-select-list`、`batch-prompt`）使用 pi-tui 的 `wrapTextWithAnsi`
（按显示宽度并保留 ANSI）。中文、宽字符、emoji 会错行，且与其它路径排版不一致。

### 3.4 重复

1. `tool.ts` 5 份 `{question, context, options, response, cancelled}` 字面量。
2. `dialogs.ts` 4 段相同序列（`input` → aborted → `isCancelledInput` → `createSelectionResponse`）。
3. `single-select-list.styleListLine`（5 分支）与 `multi-select-list` 内联着色。
4. 三套选项/答案排版：`formatOptionsForMessage`、`formatBatchForMessage`、`formatBatchAnswers`。
5. 布局预算无单一 owner：`constants.ts`（`ASK_OVERLAY_*`、`REVIEW_MIN_CONTENT_ROWS`、
   `INLINE_DOCK_RESERVED_ROWS`）、`frame.ts`（`BOX_BORDER_*`、`getOverlayMaxRenderLinesForRows`）、
   `ask-prompt.ts` 内部预算各自计算。

### 3.5 过度工程

1. `events.ts` 双形状载荷（`emitFullEvents` 脱敏）+ `BatchPosition`；诉求真实（issue #51），
   但应收敛成单一 `AskEvent` 类型。
2. `singleSelectLayout: "auto" | "list"` 的宽度判定在 `single-select-list.getSplitPaneWidths`，
   而宽度常量在 ext-core `WIDE_COLUMNS`，两处阈值。
3. `batch-prompt.ts` review 页自算 scroll、overflow 标记与窄屏退化，与
   `ask-prompt.ts` `applyPromptOverflowMarkers` 概念重复。

### 3.6 锁

0 处 lock / mutex / queue / retry / semaphore；并发手段只有 `AbortController` 与幂等 `finally`，
符合 AGENTS.md。唯一并发缺口：没有 surface 互斥，两次并发 `ask_user` 会叠加 overlay，
而 `openTuiSurface` 的 `TuiSurfaceBusyError` 正是为此存在。

## 4. 建议顺序

| 优先级 | 动作 | 收益 | 风险 |
|---|---|---|---|
| P0 | `single-select-layout.wrapText` 改用 `wrapTextWithAnsi` | 修宽字符错行 | 5 个 layout 测试期望变化 |
| P1 | 换用 `isRecord` / `errorMessage` / `fitRow` / `pad` / `calculateScrollTop` | 删重复，去掉每帧重算 | 低，行为等价 |
| P2 | `custom-prompt.ts` 换 `openTuiSurface`；dialogs 取消改用 `throwIfAborted` | 获得 surface 互斥与 `beforeRelease`，删约 173 行 | 中：RPC 回退须留在 surface 之外 |
| P3 | 拆 `AskComponent`（Frame/Modes/Chrome）；单问与批量共用 `runPrompt`；列表共用 `OptionRows` | 真正的深模块 | 中高，需先补快照测试 |
| P4 | `registerSettings` 提供 `askUser` 设置页；`createToolPresentationRenderers` + ext-ui `ToolView` | 接入生态，去掉手写渲染 | 中：renderResult 快照变化 |
| P5 | 删 `StringEnum` probe、`modelOnly` spread、`safeMarkdownTheme` probe、`default` 重复分支 | 去兼容层 | 低，需确认最低 host 版本 |

进度：P0、P1、P2、P5 已完成。P3 已完成：`ask-prompt` 拆出 `prompt-layout`、
`prompt-overflow`、`prompt-help`、`prompt-frame`，单问与批量共用 `execute` 的
`runPrompt`，两个列表共用 `option-rows`。P4 已完成：`presentation.ts` 提供呈现事实
（ext-ui 装有时由它渲染 0/1/2 折叠），`settings-provider.ts` 把 `askUser` section 注册为
ext-core settings provider。P0–P5 全部完成。

P6（减法）已完成：按"非必要 / 与项目风格冲突"复核后移除

| 移除 | 原因 |
|---|---|
| `alt+o` 隐藏浮层 + `onTerminalInput` 监听 | 隐藏一个正在等答案的模态，用户看不见问题；与"行为可检查"冲突 |
| `PI_ASK_USER_*` 环境变量层 | 隐藏配置源；优先级降为 参数 > askUser section > 默认 |
| `emitFullEvents` 双载荷 | 推测性抽象，无消费方；事件固定脱敏 |
| `StringEnum` 本地副本 | `@earendil-works/pi-ai` 已导出同名实现 |
| `allowComment` 备注二次输入 | 组合爆炸（模式 3→2），freeform 已能承载备注 |
| `singleSelectLayout` + 左右分栏 | 双布局 + 宽度魔法数；ext-core `panel-layout` 才是这类逻辑的位置 |
| `contextExpanded` | inline 下会偷换成 overlay 布局，命名与行为不符 |
| 单选模糊搜索 | 选项通常 <10；与 pi 原生 select-list 行为不一致 |
| review 页滚动键与溢出标记 | 批量最多 4 题，review 最多约 10 行 |
| `ctrl+j` / `ctrl+k` vim 别名 | pi-tui 原生列表不支持，交互与宿主不一致 |

结果：参数 14 → 8，`AskMode` 3 → 2，配置层 4 → 3，`src` 约 4.6k → 3.3k 行，测试 202 → 146。
保留 RPC dialog 回退（§5.1 已决）与 skill。

## 5. 已决（原待决策项）

1. **RPC 回退保留**：`ask_user` 的 dialog 回退路径是 paseo 的唯一可用路径（见 §6），
   不能删除。重构时按 `ctx.mode` 分流：非 `tui` 模式直接走 dialogs，TUI 模式才用
   `openTuiSurface`（它在非 TUI 模式会 throw）。
2. **折叠层由 ext-ui 提供**：采用 ext-ui 的 0/1/2 折叠（`createToolView` / `ToolView` /
   `transitionFoldLevel`），放弃现有 `expanded` 二态；`renderResult` 的快照测试随之更新。
3. **最低宿主版本 pi 1.2**：低于 1.2 的兼容层全部删除——`StringEnum` 的 typebox shim 探测、
   `modelOnly` 的 `exposure` spread、`safeMarkdownTheme` 的 Proxy 试探，以及为旧 scope
   （≤0.73.1）写的注释与分支。oh-my-pi 等其它宿主不再列入支持范围。

## 6. paseo 兼容契约（5.1 调查结论）

结论：paseo 对 `ask_user` 的支持**完全依赖** dialog 回退路径，并且依赖三个字符串常量。

证据链：

```text
pi RPC 模式        ui.custom() 直接 return undefined，且从不发出 method:"custom" 请求
                   (pi-coding-agent dist/modes/rpc/rpc-mode.js:152)
        ↓
ask_user           runCustomPrompt 收到 undefined → request.fallback() → askViaDialogs
                   (src/custom-prompt.ts, src/dialogs.ts)
        ↓
pi RPC 事件        extension_ui_request: select / input（含 title、placeholder、options）
        ↓
paseo              mapExtensionUiRequestToPermission 只处理 select/input/editor/confirm，
                   其余 default → null（丢弃）
                   (paseo packages/server/src/server/agent/providers/pi/agent.ts)
        ↓
paseo 映射器       pi/extensions/pi-ask-user/index.ts：按 onToolStart 记录的 args
                   (allowComment / allowMultiple / allowFreeform) 与精确字符串匹配
```

因此以下内容是跨仓公共契约，改动前必须同步 paseo：

| 契约 | 值 | paseo 侧用法 |
|---|---|---|
| 自由输入哨兵（select 选项标签） | `✏️ Type custom response...`（`FREEFORM_SENTINEL`） | 从 options 中滤除，并置 `allowOther` |
| 备注阶段 placeholder | `Optional comment (press Enter to skip)...` | `/\boptional\b|\bskip\b/i` 命中 → 回填备注 |
| 自由输入阶段 placeholder | `Type your answer...` | 不命中 optional → 当作自由答案 |
| 选择阶段 | `ui.select(title=prompt, options=labels)` | `event.title` 作为问题文本 |
| 工具名与参数 | `name: "ask_user"`，args 含 `allowComment` / `allowMultiple` / `allowFreeform` | `onToolStart` 捕获，决定是否合并为单个权限卡 |

已知限制（不是缺陷，是 RPC 形态）：批量 `questions` 在 paseo 下退化为逐题对话框，没有 review 页；
`timeout` 由 pi 侧 `createDialogPromise` 兜底，paseo 不显示倒计时。
