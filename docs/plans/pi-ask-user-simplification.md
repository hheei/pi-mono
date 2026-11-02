# pi-ask-user 精简盘点与执行顺序

状态：第 1–4 步已实施（见文末进度）。行为边界项按"先核对再删除"处理，其中 `coerceOption`
的宽松输入经核对后保留，原因见进度一节。

本记录承接集成工作后的复查。pi-ask-user-integration-audit.md 是上一阶段历史快照，其中的行数、实现描述与推断不作为当前行为依据。本记录不是已完成实现的声明。

## 目标与约束

- 删除纯转发层、重复算法和旧兼容逻辑，不继续按行数机械拆文件。
- 深模块通过更小的 Interface 隐藏复杂度；优先使用已有问题数据、PromptSettings 和平台能力，不增加 builder、factory 或通用执行框架。
- 保留输入边界验证、取消、异常清理、宽字符与 ANSI 安全；内部不重复防御。
- 测试验证行为与契约，不以数量为目标；合并低价值用例，不降低关键覆盖。
- 不新增锁、队列、后台轮询、全局注册中心或未经测量的缓存。
- 保持无关修改不变。公共参数、持久化和重要 UI 行为变化须先明确设计与授权。

## 1. 首批：行为等价的局部精简

- presentation.ts：singleResult 直接返回 copy.primary，不再增加 plain 后拆除；直接返回 batchResult，删除重复 output fallback；从同一份文本生成 sections/output，避免先构造文本 section 再通用解包。
- settings-provider.ts：删除仅搬运字符串的字段名常量；保留跨模块共享的 SETTINGS_SECTION。booleanField、enumField 有多个实际调用方，继续保留。
- option-rows.ts：无额外行为的 selected getter/setter 改为普通字段。
- prompt-layout.ts：删除 ContextCollapseInput 未使用的 contextExpanded 输入，更新调用方。
- prompt-help.ts：comment shortcut 文案目前是 toggle context，应与 comment 行行为一致；作为单独的小型文案修正验证。

首批不改变公共参数、持久化或交互流程，不新增抽象。

## 2. 合并算法，缩小 Interface

- option-rows.ts 的 visibleBlockWindow 与 single-select-layout.ts 重复实现选中项窗口、指示行预留及前后填充。共享窗口计算，保留不同渲染与 itemIndex 信息；不建立分页策略类，不强制合并单选和多选。
- AskComponent 构造函数有 14 个位置参数。直接接收已有问题数据与 PromptSettings，保留必要 TUI 依赖及完成回调，减少调用方逐字段展开配置。
- 可用 constructor parameter properties 删除机械赋值，不牺牲字段语义。

## 3. 收敛执行与生命周期

- execute.ts 的 PromptRun/runPrompt 重述并转发 CustomPromptRequest；合并 runner 入口与生命周期 ownership，删除 singleDetails 这类纯字段搬运。
- 无选项单问直接调用 ctx.ui.input，绕过其他路径的 runner。统一取消、timeout 与 blocked 生命周期，保留原生 input UI，不强制改为 overlay。
- 单问与批量保留不同结果语义，不增加通用执行框架。
- custom-prompt.ts 在 beforeRelease 和 finally 都调用 overlay disposer：保留释放前清理与异常兜底两个时机，首次清理后清空句柄，不依赖外部 disposer 可重复执行。
- AbortController、deadline、timer 和取消转发有真实用途，不因追求短代码删除。

## 4. 边界与兼容：先核对，再删除

- presentation.ts 的 detailsOf 仅检查非空对象就断言为 AskDetails。核对渲染及历史恢复契约：可信内部结果用明确类型；外部或恢复结果在入口做一次必要验证，之后不重复猜测。
- coerceOption 仍接受数字、boolean 及 title/label/text/value/name/option 别名。核对调用方、持久化与恢复需求后，删除无必要的旧输入兼容；保留当前支持的 string 和 title/description 对象。
- strict 代理的顶层占位字段是已复现问题，单独评估，不随旧 shim 盲删。
- 最低支持 pi 1.2：确认宿主契约后删除 onTerminalInput 存在性探测与 notify 可选调用等旧兼容分支。
- 不以历史文档中的 paseo 依赖推断为删除或保留依据；用户已说明 paseo 自有 ask-user extension，具体跨仓契约仍以当前调用方证据为准。

## 5. 测试与资源

- fixtures/harness.ts 的 customUI 同时兼容 factory 返回答案、done、surface result 与空值，是旧测试契约适配器。统一为当前 Pi host 完成契约，改写旧 fixture，不继续为适配器补测试。
- 收紧共享 harness 的 any、宽泛 execute 签名，移除 presentation.test.ts 的双重 Theme 断言。根 Biome 对测试放宽 any，lint 通过不等于类型可靠。
- settings-provider 测试删除“描述至少 20 字”；合并 id、字段集合、默认值契约；补写入后 preferences 读回及项目覆盖行为，不重复测试 ext-core 原子写实现。
- option-rows 数量、索引、开关组合用表驱动；同输入的分页可见性与指示行断言合并。
- 参数/env/settings 优先级集中在 preferences 层；TUI 保留代表性接线用例，不为每种组合启动完整工具。
- 保留取消、超时、异常清理、批量提交前不发布答案、窄屏、ANSI/宽字符及光标覆盖。
- isolateAgentDir 创建临时目录后未删除：afterAll 恢复环境变量并清理目录。
- 未发现本包业务锁、线程池或后台轮询；不新增并发基础设施。

## 执行顺序与验证

1. 首批局部精简，不改变公共契约或交互流程。
2. 统一分页计算，缩小 AskComponent Interface。
3. 收敛 prompt 生命周期，保留原生 input 行为。
4. 清理共享测试 harness，合并低价值测试，补资源清理。

边界及兼容项作为相关步骤的前置核对，不默认授权行为变化。

## 进度

四步全部完成，公共参数、持久化格式与 UI 交互未变。

1. **局部精简**
   - `presentation.ts`：`singleResult` 一次构建 sections 与 `output`，直接给出 `copy.primary`；
     删除 `plain` 临时字段、`rows()` 解包与 `output ?? ""` 兜底。
   - `settings-provider.ts`：删除 7 个只搬运字符串的字段名常量。
   - `option-rows.ts`：`selected` 改为普通字段。
   - `prompt-layout.ts`：删除 `ContextCollapseInput.contextExpanded`（未参与计算）。
   - `prompt-help.ts`：备注快捷键提示从 `toggle context` 改为 `toggle comment`，与行行为一致。

2. **算法与 Interface**
   - `visibleBlockWindow` 改为接受 `RowBlock` 并返回可见块，单选与多选共用同一窗口算法；
     `single-select-layout.ts` 删除自己的前后填充循环与指示行计算。
   - `AskComponent` 构造函数从 14 个位置参数收敛为
     `(prompt: BatchQuestion, settings: PromptSettings, tui, theme, keybindings, onDone)`；
     单问与批量都直接传已有问题数据。

3. **执行与生命周期**
   - 删除 `execute.ts` 的 `PromptRun` / `runPrompt` / `singleDetails`：`whileBlocked` 直接包住
     `runCustomPrompt`，details 由同一份 base 对象展开。
   - `CustomPromptRequest.createComponent` 变为可选；没有组件时（无选项单问）统一走宿主
     `ui.input`，因此 deadline、signal 转发、blocked 窗口与取消语义只有一条路径。
   - `custom-prompt.ts` 的 overlay disposer 首次清理后清空句柄，`beforeRelease` 与 `finally`
     都可安全调用；删除 `onTerminalInput` 存在性探测与 `notify?.`（pi 1.4 契约中两者必选）。
   - 保留 `execute` 中"答案返回后调用方已 abort 则取消"的最终判定：宿主忽略 signal 时
     仍不能把过期答案当作答案。

4. **测试与资源**
   - `customUI` 收敛为一条契约：组件完成回调的结果优先；回调直接返回时，返回值作为答案。
     删除四分支适配与 `{status}` 透传。
   - `isolateAgentDir` 与 settings 临时目录在 `afterAll` / `onTestFinished` 中删除。
   - 共享 harness：`RegisteredTool.execute`、`PromptComponent`、`createTheme(): Theme` 类型化，
     `as unknown as Theme` 只在 harness 内部保留一次。
   - `option-rows.test.ts` 用表驱动合并 helper 行用例，分页用例合并为三条。
   - `preferences.test.ts` 重组为 `resolvePromptSettings` 的优先级/默认值/非法值直测，
     加一条 settings provider 写入回读；TUI 只保留三条接线用例（surface options、
     terminal 快捷键、comment 阶段）。`settings-provider.test.ts` 删除"描述至少 20 字"。

### 第二批（继续简化）

- `constants.ts` 删除 8 个单次使用的按键别名（`PROMPT_SCROLL_*`、`VIM_SELECT_*`），
  调用处直接用 `Key.pageUp` / `Key.ctrl("k")`；常量文件只剩真正跨模块共享的值。
- `prompt-layout.ts` 删除 `overlayMaxRenderLines` 包装：NaN 兜底已在
  `frame.getOverlayMaxRenderLinesForRows` 内，ask-prompt 直接调用后者。
- `ask-prompt.ts`
  - `showFreeformMode` 与 `showCommentMode` 合并为 `showEditorMode(mode)`；编辑器头
    （标题 + 已选列表）只由 `editorHeader()` 生成，inline 子组件与 overlay 预算路径共用。
  - 删除 `buildQuestionLines` 包装与 `setPromptScrollOffset` 的重复前置判断；滚动键
    改为直接比较 `Key.*`。
  - 两个列表字段合并为 `optionListValue` + `optionList` 访问器：取消/自由输入/提交接线
    只写一次，`showSelectMode`、`renderModeLines`、`handleInput` 不再各写一遍分支。
  - `handleInput?.()` 去掉无意义的可选调用，`contextPane.toggleKey()` 返回 `KeyId`，
    删除 `as KeyId` 断言。
- `batch-prompt.ts` 复用 `applyOverflowMarkers`（原先内联 15 行重复的 ↑/↓/↕ 标记逻辑），
  并去掉 `reviewLineCap` 里重复的 NaN 兜底。
- `dialogs.ts` 把 `dialogStageOptions` 并入 `runDialogStage`：一个函数负责"还有多少时间"
  和"是否已被取消"。
- `theme.ts` 内联只被 `createEditorTheme` 使用的 `createSelectListTheme`。
- `schema.ts` 新增 `coerceOptions` 与 `malformedOptionsError`，单问与批量共用同一段选项
  归一化与同一条错误文案（原先两份）。
- 测试：把优先级解析从 TUI 用例移到新的 `test/shortcuts.test.ts`（纯函数），
  `events.test.ts` 删除 4 条 displayMode 解析用例，`overlay.test.ts` 删除 3 条快捷键解析
  用例；inline 渲染、overlay 监听、禁用快捷键等接线用例保留。

src 从 4058 行降到 3907 行，测试从 5089 行降到 4888 行，用例数 198（含新增 7 条 shortcuts
单测）。

### 第三批（深模块化与测试矩阵）

src：

- `frame.ts` 成为唯一的边框 owner：删除 `prompt-frame.ts` 与两个一次性 `Component` 类，
  改成 `frameTopBorder` / `frameBottomBorder` / `frameBox` 三个纯函数，prompt 与 review 页
  共用；ask-prompt 只保留 `frameTitle` 字段。
- `ask-prompt.ts` 删除从未参与渲染的 `titleText`（两套布局都手工组装 body，它只会
  产生一个空行）；select 体、滚动键与上下文键的判定各收敛到一处。
- `shortcuts.ts` 新增 `pageDelta`（PageUp/PageDown）、`scrollDelta`（箭头 + page）与
  `digitKey`（含 kitty CSI-u 数字）：prompt 面板、review 页、单选/多选列表不再各写一遍
  按键解析与嵌套三元。箭头键**不**进入 prompt 面板的滚动集合，否则会偷走列表选择。
- `dialogs.ts` 新增 `askText` / `askSelect` 包装；`execute.askForText` 复用同一包装，
  "Type your answer..." 只有一处。
- `format.ts` 新增 `formatSingleForMessage`，与 `formatBatchForMessage` 共享
  `COMMENT_HINT`；execute 不再内联拼装无 UI 时的提示文本。
- `execute.ts` 新增 `runInteractive`：`whileBlocked` + `runCustomPrompt` 的参数组装只有一处。
- `presentation.ts` 复用 `schema.coerceOptions` 渲染调用参数里的选项，删除内联的
  title 猜测与 `as` 断言。
- `prompt-layout.ts` 的行数常量合并为 `MODE_ROWS` 表；`prompt-overflow.ts` 抽出
  `truncateLines`。
- `single-select-layout.ts` 的行改为带 `kind` 的注解行（option/description/helper/
  indicator），`visibleBlockWindow` 变成泛型：单选与多选共享窗口计算，样式按 kind
  决定，不再靠 `line.startsWith("      ")` 嗅探。helper 文案（备注行、自由输入行）
  改用 `constants.ts` 的共享常量。

test：

- `test/fixtures/harness.ts` 新增 `runPrompt(params, drive, { rows, width, keybindings })`：
  挂载提示、`press` 按键、`record` 记帧，返回 `frameOf` / `rowsOf` 与工具结果。
- `context-pane.test.ts` 853 → 372 行、`single-select-list.test.ts` 591 → 约 190 行、
  `ask-prompt.test.ts` 147 → 60 行：同形用例合并成 `test.each` 矩阵（contextExpanded 优先级、
  context 切换键冲突、备注开关、select 导航与搜索、布局宽度），删除对私有字段
  `optionListValue` / `helpText` 的 `as any` 读取，改断言渲染帧。
- `batch-prompt.test.ts` 与 `cancellation.test.ts` 不再替换全局 `setTimeout`/`Date.now`：
  改用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，"整批只有一个 deadline 计时器"
  由 `vi.getTimerCount()` 直接断言。
- 删除 `harness.renderSingleSelectFromFactory`（唯一用途是读私有列表）。

规模：src 3907 → 3871 行，test 4888 → 3937 行（-951），用例 198 条不变。

### 第四批（对齐 ext-ui 呈现风格）

按“不重复造轮”复查了全仓的 surface 风格：`pi-settings`、`pi-loadout`、`pi-ext-ui` 都只输出
普通行（`→` 选中 + accent、muted/dim 次要信息、一行 dim 键位提示、`·` 分隔、rail 用
`theme.fg("border")`），只有 `pi-ask-user` 自己画 `╭─╮` box、标题和版本标签。

- 删除 `frame.ts`（`frameTopBorder` / `frameBottomBorder` / `frameBox`、`BOX_BORDER_*`、
  `ASK_USER_VERSION` 版本标签）：不再有 `╭─╮` 外框、左右内缩和版本标签。改为原生 rail——
  两行满宽 `──`（`borderMuted`）夹住内容，顺序与 `pi-ext-ui` tool group 一致：
  rail / 内容 / rail / 提示脚注。`railRow` 与 `RAIL_ROWS` 在 `prompt-layout.ts`，
  `getOverlayMaxRenderLinesForRows` 也移入该模块，overlay 预算扣掉 rail 两行。
- `prompt-help.ts` 改写成一张键位表：按模式列出 `[键, 含义]`，拼成一行 dim 提示，键名用
  `↕`、`↵`、`⎋`、`␣`、`⇥`（与 `DESIGN.md` 的紧凑提示约定一致），可重映射的 confirm/cancel
  仍走 `keybindings`；`PgUp/PgDn` 只在 prompt 面板真的被裁剪时出现。删除 `hints.ts`。
- 提示行不再是常驻子组件：`ask-prompt` 在渲染时按当前预算生成，因此不需要
  `updateHelpText` 与第二次 `helpText.render`。
- 单选的左右分栏对齐 `pi-loadout`：`WIDE_COLUMNS` 阈值、列表占 56%、三格间距、`pad` 补宽；
  搜索行改成 `> _`（`pi-settings` / `pi-loadout` 的写法），详情面板用 pi 内置
  `Markdown` 渲染描述，删掉手写的 `## 标题` / `---` / "Press Enter" 装饰和四个
  `SINGLE_SELECT_SPLIT_PANE_*` 常量。
- 批量页的页位与 `⇥ questions` 提示移到 `batch-prompt` 自己的一行 dim 页头，
  `AskComponent.setBatchChrome` 与 `navigationHint` 删除。
- 设置只保留 ext-core 的配置：`settings-provider.ts` 导出 `ASK_USER_FIELDS`（唯一的字段、
  默认值、枚举定义），设置页与 `preferences.ts` 都从它取值；删除 `preferences.ts` 里重复的
  `AskUserSettings` 接口、`parseAskUserSettings` 与重复默认值常量。两个模块保持独立，
  不做合并。
- `theme.ts`（15 行、唯一调用方）内联进 `ask-prompt.ts`。

规模：src 3871 → 3682 行，test 3937 → 3947 行；18 files / 198 tests 全绿。

### 核对后未改动的项

- `coerceOption` 的数字/boolean 与 `title/label/text/value/name/option` 别名：这些是
  schema 被代理剥掉后模型的真实输入形态（issue #22，本仓已复现 strict 代理改写），
  属于当前边界保护，不是历史兼容层，因此保留。
- `detailsOf` 仍是渲染入口的一次记录窄化；下游不再逐字段防御。
- `dialogs.ts` 每个 stage 的 deadline/取消复查保留：宿主忽略 signal 是真实存在的边界。

### 验证

实际执行：

- `pnpm exec vitest run packages/pi-ask-user/test` → 18 files / 198 tests passed。
- `pnpm run typecheck` → 0 errors。
- `pnpm --filter @hheei/pi-ask-user run build` → 成功。
- `pnpm -w exec biome check packages/pi-ask-user` → 无 findings。
- `pnpm run verify:changed` → 成功：typecheck 0 errors、受影响包 build 通过、22 files / 353 tests passed、code graph 已更新。

测试数量从 202 降到 198 是合并低价值用例与参数化后的结果，取消、超时、清理、批量
提交语义、宽字符/窄屏与设置优先级的覆盖均保留。

### 第五批（按"非必要 / 与项目风格冲突"做减法）

复核后删除（详见 `pi-ask-user-integration-audit.md` 的 P6 一节）：

- `alt+o` 隐藏浮层（`attachOverlayToggle`、`onTerminalInput` 监听、`notify` 提示）；
- `PI_ASK_USER_*` 环境变量层，优先级降为 参数 > `askUser` section > 默认；
- `emitFullEvents` 双载荷，事件固定脱敏；
- `StringEnum` 本地副本，改用 `@earendil-works/pi-ai` 的实现；
- `allowComment` 备注二次输入（`AskMode` 3 → 2，`AskResponse` 去掉 `comment`）；
- `singleSelectLayout` 与左右分栏详情面板（回到单列，描述在选项下方）；
- `contextExpanded`（inline 下偷换 overlay 布局的分支一并删除）；
- 单选模糊搜索（`> _` 行、`fuzzyFilter`、搜索态 esc/backspace 分支）；
- review 页滚动键与 `↑/↓/↕` 溢出标记；
- `ctrl+j` / `ctrl+k` vim 别名，列表键位回到 pi 原生 select-list 语义。

结果：参数 14 → 8，配置层 4 → 3，`src` 约 3.7k → 3.3k 行，18 files / 146 tests。
`prompt-overflow` 的 prompt 滚动键保留（overlay 下长问题仍需滚动）。
