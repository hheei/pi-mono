# Terminal UI/UX Design

## Scope

Shared UI/UX rules for Pi terminal surfaces: visual hierarchy, theme usage, layout, interaction, responsive behavior, and accessibility.

Feature architecture, persistence, lifecycle, command semantics, and feature-specific UI contracts belong elsewhere.

Feature specs MAY specialize these rules but MUST NOT silently contradict them.

## Principles

The Pi TUI is **quiet, semantic, content-first, and terminal-native**.

- Content dominates; color, borders, backgrounds, spacing, and typography communicate state or hierarchy, never decoration.
- Prefer whitespace, alignment, and familiar terminal interaction over extra containers or custom interaction.
- Keep one obvious active focus point and stable geometry as state changes.
- Regular-mode redraws for tool collapse or streaming changes above the visible viewport must not erase terminal scrollback (`CSI 3 J`). Native terminal scrollback is not a fullscreen `ScrollView`: Pi can neither read nor move that scroll position, so protecting a reader's place there is **unsupported by design** and must never be patched or bypassed (no patched `pi-tui`, no monkey-patched `ScrollView`, no private members). Reading protection exists only in fullscreen, where the viewport is Pi's own (`isFollowingOutput`).
- Reuse existing UI primitives and semantic tokens before introducing new ones.
- NEVER use shadows, gradients, decorative cards, module-specific branding, or hard-coded colors.
- Add visual elements only when they improve readability, navigation, state recognition, or action discovery.

## Theme

Use Pi theme tokens by semantic role:

- Content: `text`, `muted`, `dim`
- Focus: `accent`, `selectedBg`
- Status: `success`, `warning`, `error`
- Structure: `border`, `borderAccent`, `borderMuted`
- Thinking/mode: `thinkingText`, `thinkingOff`…`thinkingMax`, `bashMode`
- Messages: `userMessage*`, `customMessage*`
- Tools: `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput`
- Markdown/diffs: existing `md*` and `toolDiff*` tokens

Rules:

- `accent` marks the active focus; status tokens represent status only.
- `muted` and `dim` represent hierarchy, not failure.
- NEVER invent feature-specific accent colors or new tokens when an existing semantic role fits.
- NEVER communicate selection or status by color alone.

### Semantic color table

Extension surfaces reuse these roles instead of dimming every secondary line:

| 内容 | token / 条件 |
| --- | --- |
| 组标题、分类标签 | `text`；当前展开的分类标签用 `accent`，并保留 `▸`/`▾`，不只靠颜色 |
| 分隔线、分组 rail | `borderMuted`；工具 frame 的 rail 用其自身 `railToken` |
| 次要耗时、计数、footer 元数据 | `dim` |
| thinking 预览与正文 | `thinkingText` + italic |
| notice | `info` 正文用 `text`；`warning`/`error` 用对应状态色，并保留 `Warning: `/`Error: ` 文字前缀 |
| 工具名 | `toolTitle` + bold |
| read 路径与行范围 | 路径 `accent`（终端支持时保留 file 链接），行范围 `warning` |
| bash 命令 | `toolTitle` + bold；`timeout` 与耗时是 `dim` 次要元数据 |
| 其他工具摘要 | `dim` |
| 工具输出 | `toolOutput` 或原生语法高亮；错误用 `error` |
| 状态字形 | `success`/`accent`/`warning`/`error`；streaming 用 `muted` |

## Layout

- Use terminal-native font and cell dimensions; measure layout by terminal cell width, ignoring ANSI sequences.
- Bold is for headings/labels; thinking uses italic `thinkingText`.
- Framed/background surfaces normally use one-cell padding; inline metadata, rails, and footers use none.
- Use at most one blank line between adjacent semantic blocks.
- Every rendered line MUST fit available width: wrap prose; ANSI-safely truncate compact metadata, status, and paths.
- One returned array element is exactly one terminal row, so it MUST NOT contain `\n` or `\r`. Pi writes the element verbatim: a line feed moves to the next row without clearing it, and a carriage return moves back to column 0, so a break leaks text across rows and desynchronizes the frame from the height it reports. Measure alone cannot catch this, because `visibleWidth` counts both as zero cells. Collapse a label, summary, or board row into one row; split genuinely multi-line content into one element per row.
- Preserve useful path suffixes and semantic fragments when truncating.
- Keep rows, columns, controls, selection slots, and fixed-height surfaces geometrically stable while state changes.
- Prefer clipping or scrolling within an established region over resizing surrounding layout.
- Hide complete low-priority content before clipping or moving higher-priority content.
- Columns SHOULD remain stable while scrolling and keep at least one cell of separation.
- NEVER let one overflowing field shift or corrupt adjacent content.

## Interaction

- A surface SHOULD expose one primary focus point.
- Selected rows use `→` and `accent`; unselected rows reserve the same marker width.
- Disabled, inherited, read-only, and unavailable states remain distinguishable without replacing the focus signal.
- Use compact hints consistently: `↕` vertical, `↔` switch, `↵` activate, `⎋` cancel, `␣` Space, `⇥` Tab.
- Show non-obvious shortcuts near the relevant control; omit redundant hints.
- Nested interactions handle `Esc` inside-out: editor/transient interaction → detail/form → filter/mode → surface.
- Parent surfaces act only after the active child declines the key.

## Surface Patterns

### Messages

- User messages: one padded `userMessageBg` block with `userMessageText`.
- Thinking 分类统计显示 `thinking xN · T tokens`；N 为当前分类的非空 thinking 项数，按现有 assistant-message 项粒度计数，流式更新原项不重复增加。展开子项的标签保持不变。
- Assistant prose: terminal background with whitespace between semantic blocks.
- Assistant prose 的裸路徑只在 host app 判定「讀者就在這台機器」時才變成 `[path](file://localhost/<abs>)`，其餘一律保持純文字。每個 host app 是一個 `LinkHostProvider`（`pi-ext-ui/src/file-links.ts`）：VS Code 認得但從不改寫，它自己的 terminal link provider 會在擁有檔案的一側開檔；Rex 每 session 問一次 `client.list`，全部 app client 都在 loopback 才改寫，網路上的 app client 代表需要 ssh target，而那在這側不可知。OSC 8 由 Pi 的 markdown 渲染器加；fenced code、行內 code、既有連結與 URL 不改寫，點擊失敗由終端與讀者機器負責，不在擴充內補償。
- Thinking: italic `thinkingText`. While Pi hides thinking, each item is one row: a content preview of at most 20 graphemes (ellipsis for anything after it) that opens the full text on click; while Pi shows thinking, the aggregate prints the full text flat with no preview row.
- Extension messages: one `customMessageBg` block using `customMessageLabel` and `customMessageText`.
- NEVER add avatars, decorative labels, nested cards, or large collapsed placeholders.
- Preserve partial output before reporting a later error.

### Tools

整组展开透明且无组级 rail；notice 始终是自身 customMessageBg 块并在上下各留一行同色 padding；着色模式下每个展开块都是独立面板（工具用 Pi 原生底色，thinking 由组补中性底色），默认模式下工具与 thinking 不填背景；复用原生 Box 不双加 padding。

- **成组门槛：** 同一连续段内 `notice / 2 + thinking / 2 + 顶层 tools >= 2` 即显示 collapse views，不取整。thinking 按分类中的非空 thinking 项计数；空 assistant/toolCall 占位不计。4 notice、4 thinking、2 notice + 1 tool、1 notice + 1 thinking + 1 tool、2 tool 均成组。容器子调用不增加顶层项数；此权重与“工具完成后才计入 calls”独立，未知 renderer/正文等既有断组边界不变。

- **collapse views 外壳：** 收起时整个组是一个原生背景块（header、分类、footer 同一底色），并在 header 下与 footer 上各画一条 `borderMuted` 组级横向 rail 框住内容；局部分类展开保留组底色。整组展开（标题或 Ctrl+O）后只有标题仍是背景块（上下各一行同色 padding），成员区域完全透明、不再画组级 rail，所以展开不会给整段对话着色。展开时 footer 的统计并入标题行（`collapse views · 用时 · N calls · requests ×N · ↑… · ↓…`），末尾不再追加 footer 行；标题块与第一个成员之间留一行无色空行。组底色取 block 自己的事实，不取最后一次调用的状态：任一成员 running/streaming 且 block 尚未结算时用 `toolPendingBg`；一旦成员都带状态且都不在运行，block 结算，按 block 内是否有失败取 `toolErrorBg` / `toolSuccessBg`，保持 5 秒后回到中性底色 `toolPendingBg`（Pi 主题里唯一的中性背景槽，chroma 3–5%），旧 block 不再抢眼但仍是一块可读的 panel。结算之后的调用不会把底色翻回 pending：否则一次请求里连续调用工具时底色会随每次调用反复变化。组外壳复用原生 `Box`（`paddingX=0` 不重复 `outputPad`；`paddingY=1` 只在有底色时启用，`Tool backgrounds` 关闭时组外壳没有上下留白行），同一渲染/鼠标路径；组前空行与相邻块间空行不着色。- **工具自身底色（可选）：** settings 里 `Tool backgrounds` 打开后，工具完全改用 Pi 原生着色：成功 `toolSuccessBg`、失败 `toolErrorBg`、进行中 `toolPendingBg`，上下各加一行同色 padding，并去掉 `▎` 前导导轨；组外壳仍保留自己的 block 底色，工具底色只在工具自己的行内覆盖它，组级 rail、分类行、footer 与计时不变。默认关闭，工具透明。
- **背景填充必须抗 reset：** 子组件用自己的 `\x1b[0m` 结束每个 span，一行只包一次背景会让第一个 reset 之后的文字失去底色，所以填充要在每个 reset 之后重新开始、补到整行宽度，并恢复该行最内层的底色（工具底色盖住组底色时，reset 之后回到工具底色）。
默认模式下工具与 thinking run 都不填自身背景（`ToolView` 透明），notice 始终由 `MessageView` 拥有 `customMessageBg` 并在上下各留一行同色 padding（见 [12：原生背景块](docs/plans/pi-ext-ui-rendering-tickets/12-native-background-blocks.md)）。`Tool backgrounds` 打开后，工具与 notice 各自成块（工具用自身 Pi 原生底色，notice 用自身 `customMessageBg`，都带自己的 padding），thinking run 仍是原生正文：不填背景、不加 padding，只保留块间那一行空行；它的行首导轨同样只属于非着色模式。

最后一个可见的受支持尾项采用无状态的总高度下限，成组前后规则相同：Tool backgrounds 开启时至少 4 行，关闭时至少 2 行。内容和自带的上下背景 padding 均计入总高度；不足时在完整色块之后补无背景空白，达到下限则原样输出，不截断、不保留历史高度。顶部语义分隔和独立 OSC 标记行不计入高度，正文内部空行仍计入。例如着色模式的 2 行工具内容加 2 行色块 padding 无需补偿，无色块的 1 行 thinking 或 notice 补 3 行。空 assistant/toolCall 占位不替代前一个可见尾项，空输出不凭空补行。补偿行不属于 collapse view，不参与点击命中；尾项换成工具、notice 或 thinking 时按本帧重新计算。正文断组、尾项不再单独展示时，补偿不转移给组。组外壳的上下留白行属于底色本身（`Tool backgrounds` 关闭时不存在）；退色只改变颜色，不改变行数。超过下限、成组及断组造成的高度变化允许自然发生。

thinking 项每项只有一行：约 20 个 grapheme 的预览（`▎` 导轨），点该行展开换行的全文、再点首行收起，项与项之间不加空行；thinking 可见时直接平铺全文、没有预览行。预览行与展开后的正文行共用同一个 `▎` 导轨（与同级工具对齐），因此二次展开时正文文字列不移动；`Tool backgrounds` 打开后导轨让位给组底色，thinking 的预览与正文都不画导轨。

- `pi-ext-tools` renders every registered tool with `renderShell: "self"`: terminal background, no Pi `tool*Bg` box.
- A tool frame has a header and up to two bodies. A `request` body (the tool's input: command, code, task text) may sit between the header and the result body; a tool whose header already carries the whole call, and a tool whose input becomes the result, keeps one body. Omit a body's paired rails when it has no rendered lines:

  ```text
  󰄴 tool summary · metadata
  ─────────────────────────  opening rail
  request                    tool-owned, optional, ≤10 head rows
  ─────────────────────────  shared rail
  tool body                  tool-owned result rows
  ─────────────────────────  closing rail
  typed footer               optional, tool-owned text
  ```

- A declared `request` renders in the call slot for the whole lifetime of the row: while arguments stream, while the tool runs, and after the result arrives. It replaces the tool's own call-phase `renderCall` body. A collapsed frame still renders the header and its one-line metrics summary only, and expanding the frame lifts the request and result caps together.
- Request rows preserve the input: they wrap instead of truncating, keep the head (at most 10 rows, then a dim `… (N later lines, ctrl+o to expand)` row), strip terminal escape sequences because the text is model-controlled input, and never exceed the terminal width. The result body keeps the tail instead.
- The result body omits its opening rail when the tool declares `request`, so exactly one rail separates the two sections; a tool that declares `request` renders at least one row for the arguments it receives.
- Pi `renderCall` and `renderResult` are host lifecycle slots, not separate visible sections: the call slot owns the header and the request body, the result slot owns the result body and the footer. Both slots stay mounted, so the call slot must not repeat what the result slot shows.

- When the header fully represents a tool call, omit a duplicate body. `grep` and `find` use only the header until their result body exists.
- `MessageView`（`pi-ext-ui`）画会话 info / notice，不画工具。独立渲染时整块是 `customMessageBg` 背景，上下各一行同色 padding（Pi 的自定义消息在安装 renderer 后会绕过自己的默认 Box，所以由 view 自己提供同样的块）；组内通过 `previewRows`/`bodyRows` 交给组底色，不叠加第二层。它没有状态 glyph、复制按钮、rail 或三级折叠。header 是 `▸ kind · summary`；没有 body 时不画 pin，点击无效。preview 在折叠和展开时都在，body 只在展开后出现，并缩进两格。只有 header 行响应左键。展开状态按 `stateHolder` 的对象身份记住，不写回 session entry。`forcedExpanded` 对应 host 的 ctrl+o：强制打开，期间的点击只记下收起，ctrl+o 关闭后再生效。它不替代 Pi 自己的 `[compaction]` / `[branch]`，那两个没有渲染钩子。其他 extension 不把 `@hheei/pi-ext-ui` 放进 `dependencies` 或必需 `peerDependencies`，也不要 `openExtensionPoint`。渲染时调用 ext-core 的 `readMessageView(pi)`：有工厂就用，没有就继续自己的 `Text`。`pi-ext-ui` 在 session 启动时 `registerExtensionHook(messageViewPoint, createMessageView)`，session 结束时卸下。info 文本、session 记录和模型上下文不变。`pi-ext-ui` 不依赖具体 extension。memory、optimizer、subagents 的 info 已接上：kind 分别是 `memory`、`optimizer`、`agents`。memory 的 preview 是页面标题和截断行，body 按页重复标题、id 和 snippet。optimizer 没有 preview，details 进 body 的 JSON，warning 只给 summary 上色。agents 的 summary 整段用状态色，报告进 body；没有 body 就不画 pin。

- 工具包拥有展示语义、参数摘要、结果解析、状态和内容行；pi-ext-ui 不按具体工具名分派，仅读取 ToolPresentation 绘制通用框架。每个具体工具在所属 package 的 definition 上提供 optional renderer 与原生回退。ext-core 的 `createOptionalToolRenderers(pi, name, native)` 在每次 render 读取 `toolRendererPoint`，`pi-ext-ui` 只在 session 生命周期内注册渲染工厂；缺少 UI 时调用工具自己的 native renderer。UI 全局 resolver 遇到该 wrapper 直接委派，确保直接调用与嵌套调用都只画一层框架。后加载 UI 可见，shutdown 后不保留旧工厂；工具 schema、执行与历史 details 不改变。
- 工具展示分两层：`pi-ext-core` 的纯 `ToolPresentation` 契约描述内容语义（`summary`、`request`、`output`、`collapsedRows`、`copy`、diff 字段），`@hheei/pi-ext-ui` 的 ToolView 提供视觉框架。ToolView 拥有三级折叠、body 的 paired rails、footer placement 与 `stateHolder` 上的折叠记忆；concrete extension 继续拥有其 tool 语义、header summary、body、typed footer 与 warning 判定。未加载 `pi-ext-ui` 时，`createToolPresentationRenderers` 生成 Pi 原生 Text 渲染，保留参数与结果。
- 折叠层级：Level 0 是默认折叠态，只显示 header 与 `collapsedRows`（没有 collapsed rows 的工具显示 header 加一行 dim summary）；Level 1 显示全部 rail sections；Level 2 与 1 相同，由 Pi 的 global expand（Ctrl+O）强制打开。点击在 0 与 1 之间切换，Ctrl+点击直达 2；Ctrl+O 优先于记住的层级。没有自动收合定时器，也没有 `longOutput` / `collapseMode` 设置：折叠时机只由用户交互和 Pi 的 global expand 决定。
- A Level 1 section keeps at most 9 rendered rows (a tool may override `maxLines`) followed by a dim `… (N more lines)` row; Level 2 renders every row. Tools that must show the tail of their output (bash, grep, read) cap the body themselves before handing it over. Header, paired rails, and typed footer stay outside that limit. Paired rails always use `muted` and do not encode success, warning, or error. Expanded results are not capped. Tool renderers retain their semantic colors, widths, collapse rules, model-visible `content`, and body component caches, but never add outer rails or typed footers. When the body has no rows, omit both rails and show only its typed footer when present.
- A collapsed footer uses only tool-owned typed details, a captured execution duration, or a caught single-line error message. It never parses model-visible `content`. In the collapsed frame the summary is always one truncated row, so a collapsed frame is exactly two rows at every width. No frame row may exceed the terminal width, because the Pi renderer rejects an overlong row.
- `grep` collapses to `N match(es) · M file(s) · L line(s) · duration`. Count nouns are singular when the number is 1. Its current-Trace header follows the shared wrapping rule; only a historical collapsed header is compacted. Match and context rows use the same ` XXX │ ` gutter and path-based cli-highlight as `read`. Matching ranges keep full-intensity syntax colors with a `success` overlay; the rest of the same line uses dim syntax colors. Per-file omissions use a dim line-number-aligned `…` / `┊` skip whose body keeps the recovery hint. Every grep body row follows `read`'s single-line, ANSI- and cell-width-safe truncation rule, using a dim trailing `…` rather than wrapping.
- `find` fully represents its call in the shared header: `status find /pattern/ in path`; it has no duplicate pre-result body. ToolView frames its result-phase body with paired rails and places the typed footer after the closing rail. The body groups candidate paths with base-text paths in the terminal default. Its typed footer is `X match(es) · duration`. Count nouns are singular when the number is 1. Collapsed body omission uses dim `… (N more lines, <key> to expand)`, where `<key>` is the host's configured `app.tools.expand` binding, so a remap stays accurate.
- 工具按独立包注册：文件工具与前台 `bash` 归 `pi-ext-tools`，后台 Bash 归 `pi-bg-bash`，补丁归 `pi-apply-patch`，Python 归 `pi-python-eval`，Todo 归 `pi-todo`。工具名、默认激活与 exposure 保持原契约，激活由 Pi host / Loadout 决定。`apply_patch`、`python_eval` 默认 inactive；停用工具不注入提示、不拦截流式 shell 命令、不触发额外回合。具体包不依赖 `pi-ext-ui`；历史 details format、edit/write view key 与 Todo status key 不随包名更改。
- `edit` and `write` keep Pi's execution semantics and render through ToolView like the other `pi-ext-tools` tools; they never silently switch the catalog to `apply_patch`. They must not show a second built-in header inside the body, and they must not fall back to Pi `renderDiff` or the built-in edit/write body. `edit` shows only its diff or error body inside the shared rails. `write` shows a new-file highlight preview when creating a file, the same unified diff when overwriting a file small enough to snapshot, a `wrote (N lines)` preview when the existing file is too large to snapshot, or a `no changes` row; successful `write` results retain that body after completion rather than collapsing to a header-only success row. Persisted write views store only the visible parsed diff lines or a line count; they do not copy the full old and new files. New-file and large-replace previews reread `args.content` instead of duplicating the payload. Legacy views that still contain `oldContent`/`newContent`/`content` keep rendering through the same custom body. Call-phase `edit` is header-only; call-phase `write` may show the new-file preview before the result exists.
- Native `write` header is `write <path>` with a space separator. Native `write` bodies use the pix-adapted split/unified renderer (wide terminals split, narrower terminals stack) with syntax highlighting. They own their own preview cap (`150` diff rows; new-file write shows `20` head lines plus a dim expand hint) and raise the shared ToolView section cap so the start of a diff is not cropped. Diffs normalize CRLF before comparison so line-ending-only changes do not explode the body. Each write diff omits its own top/bottom rails so only the shared ToolView rails wrap the body. The body is the preview or diff only — no `+A -D` heading. Typed `write` footer is `X byte(s) · +A -D · Y line(s) · duration` when overwriting with a diff; otherwise `X byte(s) · Y line(s) · duration`. Count nouns are singular when the number is 1.
- Native `edit` header is `edit <path>` with a space separator and no middle dot. Current-Trace summaries are not dimmed, while historical collapsed headers still dim them. It captures the pre-edit file to render each requested replacement as a unified diff block: three context lines, absolute file-line gutters, and syntax highlighting. Context rows are one cell-width-safe line clipped to the live TUI width with a dim trailing `…`; add/remove rows may still wrap. Multiple replacements render in request order with a dim `…` in the line-number column; skipped context inside a block uses the same omission. All blocks share the widest line-number column. Each diff block omits its own top/bottom rails so only the shared ToolView rails wrap the body. `edit` raises the shared ToolView section cap so a diff is not cropped from its beginning; its own per-block `MAX_RENDER_LINES` cap remains. The body is only the diff blocks — no `+A -D`, `at line N`, or `N edits` heading. Typed footer is `N edit(s) · +A -D line(s) · duration` (`4ms` or `1.0s`). `edit` and the `+A -D` unit are singular when that count is 1. Resumed Pi-native edits use their persisted unified patch; if that patch is absent or invalid, the persisted text remains visible instead of an empty body.
- A Write or Edit Unconfirmed Path Outcome uses the shared warning-colored `󰘥`, must not render its diff as applied, sets `isError: true`, and tells the model to `read` that path before another mutation. NotApplied is dim and is not a success diff. Resumed native `edit` results prefer the persisted `pi-ext-tools` view captured at execution. Older Pi-native results may fall back to their persisted unified patch for the same gutter/diff renderer and for collapsed `N edits · +A -D lines`; they never read the current workspace to reconstruct history. Duration absent from persisted typed details stays absent rather than being inferred from model-visible text.
- An unexpanded successful text `read` uses the same gutter and highlighting as native `edit`: ` XXX │ ` plus cli-highlight from the file path, ten head lines, a dim line-number-aligned `…` / `┊` omission whose body is `(N hidden lines, ctrl+o to expand)`, then nine tail lines when more than nineteen lines were returned. Expanded text reads keep that renderer for the full returned range. Its full header is `status read path[:range]`. An explicit `limit` shows inclusive `start-end`, while no `limit` shows at most `:start`. TUI rows derive one-based source line numbers from the request only; model-visible content stays Pi-native and unnumbered. The footer is `Unicode-code-point char(s) · returned line(s) · duration`. Count nouns are singular when the number is 1. Every preview row is one cell-width-safe line: it reserves the source-line prefix and a dim trailing `…` before truncating content, and never wraps. Error, partial, and image reads retain Pi native render behavior.
- All tool UI compaction and truncation markers use dim `…`; model `content` remains unmodified. Their body paths, and bash body text share the terminal default on the current Trace and `dim` on a later Trace. They do not use the theme `text` token. Grep body file headings are relative to the search path and are omitted when that path is a single file. Truncated `…/tail` headings and path-like spans inside highlighted source follow that same tone and stay dim syntax on the match line; match ranges use `success` over full-intensity syntax-colored source.
- Streaming and completed states SHOULD share a visual grammar while remaining distinguishable.
- A live tool (streaming args or running) animates one spinner phase from a shared 200ms clock: `· ✢ ✳ ✶ ✻ ✽` in `muted` while args stream, the same phase in `accent` while it executes. The phase occupies the row's leading slot: a live tool shows the spinner where a settled tool shows its fold pin `▸`/`▾`, never both glyphs in one row. A container (`codemode`, `python_eval`) keeps the spinner while it generates and while it runs with no child call yet, and returns to `▸` as soon as it lists child calls. Entering execution must not restart the phase, and a cached frame carries the spinner frame in its key so a repaint can never freeze the glyph. The frame that drew a live glyph owns the next repaint: one self-terminating 200ms timer per live row, because no host event says "still running" — a tool that streams args, runs, or lives in a container board keeps its own clock without depending on the activity-group patch.
- `apply_patch` 的渲染由 `pi-apply-patch` 通过 ext-core presentation provider 拥有（`sections`、`collapsedRows`、`summary`、`status`、`copy`、`replaceCallOnPartial`）；pi-ext-ui 只提供通用 frame，不再按工具名分派。header 为 `apply_patch modify N file(s) (+A -D) · duration`（N=1 用单数 `file`）。执行前按已收到的 patch 预估文件数与总增删行；执行后按去重的 `changedPaths` 和执行方总增删行展示实际修改，拒绝的操作不计入文件数。codemode 子调用折叠摘要沿用同一统计格式。聚合 status 沿用执行方事实：success 顶层无 glyph、partial 为 `!`、failed 为 `✗`。Level 0 collapsed rows 与 Level 1+ sections 都显示 operation rows（七态 Nerd Font glyph：`󰄰` pending、`󰄴` applied、`󰪠` partial、`󰾞` fuzzy、`󰘥` unconfirmed、`󰍷` not applied、`󰅚` rejected；verb 用 `create|modify|delete`），Level 1+ 继续追加每个 applied snapshot 的单列 diff 行（符号 + 绝对行号，来自 executor 记录的 before/after 窗口）与 rejected/unconfirmed/notApplied 诊断行（error rail）。partial 保留 `(appliedHunks/totalHunks hunks applied; reason)`，fuzzy 保留 dim `fuzzy` 标记。模型生成 tool arguments 时，`renderCall` 从 partial `args.patch` 识别已换行的 operation header，显示 `󰄰 create|modify|delete path +A -D` 的 pending rows（`󰄰` 只表示 prefix 已识别，不表示验证或入队；不读取 workspace、不持久化 preview）。copy primary 是请求的 `args.patch`（可整段重试），full 是 patch + 输出；不冒充 git-apply unified patch。details 缺失时退化为纯输出文本。执行语义不变：V4A Publish 顺序、progress 快照交还事件循环、add/delete snapshot 150 行窗口、final Patch Outcome 持久化、`/reload` 取消进行中的 execute。
- `apply_patch` 的模型结果只报告执行事实与诊断，不附加 `Next:` 或恢复指令。歧义报告候选起始行号与总数，由模型自行选择后续 read/search。
- `bash` 只在前台执行；后台命令使用 `bg_bash_spawn`，不自动转后台。工具输入代码与结果保持可检查。两个 spawn 成功返回 JSON `{ id, path }`：Bash 的 path 是日志绝对路径，agent 的 path 是 Pi 分配的 session 文件绝对路径（可能尚未落盘）。send、stop 成功只返回一句确认，失败只返回原因，不附带 session ID、presentation 或状态快照。两个 get 的 progress 内路径字段同样命名为 path。`bg_bash_get` 返回状态与有上限的运行信息，`bg_bash_stop` 发出进程树取消请求。
- The command itself is a request body: one row per command line, wrapping instead of truncating, with terminal escapes stripped and the head kept behind a dim `… (N later lines, ctrl+o to expand)` hint. Copy takes the request bytes as the model sent them (no trim, no escape stripping); only the output half of a `full` copy is stripped. The header carries only the call facts above, so a wide command appears exactly once, in full, in the request body.
- Unexpanded bash output keeps at most 10 logical lines: a dim `… (N earlier lines, <key> to expand)` hint plus the tail, where `<key>` is the host's configured `app.tools.expand` binding. `N` is total logical lines emitted minus the visible tail, not wrapped display rows and not the current byte-window line count. Each body row is one cell-width-safe logical line with a dim trailing `…`. Header, request body, paired rails, and typed footer stay outside that limit.
- `todo` 使用 ToolView：header 是 `todo #1 #2 #3`（本次涉及的 task id，无中间点）；mutation body 只显示该次 typed operation outcome，`list` body 按 active、pending、blocked、completed 显示 task rows；footer 只显示 `active #X · N pending · duration`。未展开 Todo body 最多八条 task rows并保留 `… +N more`，展开后显示全部。Todo 取消 `above-editor` widget，改用 Pi 原生 Footer 状态行（`ctx.ui.setStatus` 靠左展示）显示轻量会话状态：Nerd Font 状态 glyph（`󰪠`/`󰄰`/`󰀪`/`󰄴`/`󰅚`）按 status 语义着色，id 用 `accent`；刚完成在有后续进行中任务时显示 15 秒、否则保留展示 3 分钟，阻塞保留展示 15 秒，无内容或超时后清空状态并保持零纵向占位。仲裁优先级见 [docs/todo/README.md](docs/todo/README.md)。
- `pi-subagents` 在父会话使用原生 `ctx.ui.setStatus("pi-subagents", text)`，不挂 aboveEditor widget、不做 elapsed 刷新、不为终态保留展示窗口。状态投影只读 manager 的当前快照；过期异步读取不能覆盖新快照。child 会话的身份只靠 session title（`🤖 <agent> · <id>`）与 child branch 自己的原生 TUI 表达，不挂身份 widget；离开绑定 session 后 `contact_parent` 停用。
- 后台 Bash 停止请求进入 `stopping`，仅在进程实际退出、输出收集结束后显示终态；停止确认句不冒充退出确认。extension reload 保留运行中的 job：registry、输出收集、timeout 与账本锁留在进程级 carried 表中，下一次 `session_start` 按 sessionId 接管同一 registry，footer 与交付通道重新绑定；其余 shutdown（quit / 新 session / resume / fork）停止进程组。resume 只恢复记录与未记录的报告，绝不自动重跑或接管旧 PID；缺少可靠终态时由调度器投影 `unknown`，不覆写原始执行证据；保留命令与日志，提示副作用和日志可能不完整，由 agent 决定下一步。当前已观察到退出但写盘失败时，保留退出结果并明确报告持久化失败。报告按原始分支中的 job ID 去重，compaction 后不重复通知；tree 会重新排交无实际收据的未确认报告。fork 关闭原 session 并清理其拥有的命令，新 session 不继承旧工具 ID 的查询或控制权；需 resume 原 session 查证。Bash 结果、child 报告与提醒均及时交付，空闲父会话在同一 microtask 批次只唤醒一次，不等待无关执行完成。
- 后台执行使用 `bg_bash_spawn`、`bg_bash_get`、`bg_bash_stop`；完成结果通过 `bg-bash-report` 自动交付。只有后台 Bash 具有提醒：连续 180 秒无 stdout/stderr 发送一次 idle notice，每 1800 秒发送 heartbeat；提醒沿用交付通道，不消费终态结果。完整输出通过返回的日志路径读取。没有 list 或等待工具。
- `pi-bg-bash` 通过原生 `setStatus("pi-bg-bash", text)` 用 `bash xN`（muted 标签 + accent 计数，与 `agents xN` 同构）显示运行中及 stopping 的 job 数量，启动、工具结果及终态更新时刷新，session 关闭时清空；单个 job 的身份只在 entry 与工具结果里出现。job id 形如 `bash-3f9a1c`，与 child id 同构，不带顺序号。结果、idle/heartbeat 提醒和跨 branch 待交付提示追加 `bg-bash-info` custom entry，折叠标题为 `info · bg-bash · ✢ #3f9a1c terminal · completed`：状态 glyph 与 subagent entry 共用一套（`✢` running、`✓` completed、`!` cancelled/timed_out、`✗` failed/unknown），`#` 短 id 占 subagent 的 id 位、kind 占 agent 位；默认只显示该行，展开查看有界输出、诊断和日志路径；跨 branch 提示不泄漏结果正文。模型仍通过隐藏的 `bg-bash-report` 接收原交付，不因 UI 失败重发。可选使用 MessageView，无 pi-ext-ui 时使用 Text；展示剥离终端控制字符，原始日志保持完整。
- 子代理工具为 `agents_delegate`、`agents_get`、`agents_stop`、`agents_dashboard`。`agents_delegate` 新建时提供 `agent` 并省略 `id` 或传入 `id: ""`（纯空白同样新建），由系统分配 ID，不猜测 ID；非空 `id` 优先并接续已有 agent，未知非空 ID 报错，接续始终是 steer。`agents_get` 按 `id` + `revision` 读取某次委派，`includeOutput` 为真时才返回结果正文并沿用同一输出上限；`agents_dashboard` 只给运行状态与最新委派摘要，不返回正文。Bash 的 get 仍使用逗号分隔 keys 的投影契约。
- 两族工具声明 `exposure: "deferred"` 与 `defaultActive: false`。每个 extension 在 `before_agent_start` 用 ext-core `setOptionalToolBullet` 往结构化 system prompt 的 `optional_tools` 段落写入一条稳定条目（key 为 `subagents` / `background bash`），段落自带固定 preamble，提示用 `tool_search` 或 codemode 加载。工具 description 与 guidelines 说明完成结果自动返回、派发后继续独立工作或结束 turn、禁止轮询等待。PTY 交互留给后续独立能力。
- `pi-ext-memory` 的原生 `mcp__hindsight__*` 工具与本地 recall 工具各自注册 renderer：MCP 工具经 Pi 的 renderer resolver 渲染，不包装执行或重复注册；工具集合由服务端决定。search / recall / reflect 显示 query，页面读取显示 page_id；未知工具仍保留可检查的参数与结果。渲染不引入独立折叠策略，展开由 Pi 的 ctrl+o 与全局 expand 决定；完整输出路径保持可见。业务错误保留错误语义，历史调用在服务器未连接时仍可渲染，不能伪造历史时长。诊断使用 /om（本地）与 /mcp（连接），共享 bank 明示不保证仓库隔离。
- `pi-status` 提供 2-line Compact Footer：
  - Line 1: `[path (muted)] [( (dim)][branch (accent)][) (dim)]` 居左；`auto-title` 动态进度或 `[sessionName (muted)]` 靠右。
  - Line 2: `[provider/ (dim)][model (text)][(thinking) ((dim) + (accent) + (dim))] · [N% (muted)][/window (dim)]`（超过 70% 升为 `warning`，超过 90% 升为 `error`）居左；保留原生 Todo 状态组件靠右（Nerd Font glyph 按 status 语义着色、id 用 `accent`、subject 依状态分级，样式完全不改）。
- opt-in `eval` 的渲染由 pi-ext-ui ToolView 负责（容器规则同 codemode）：header 为 `eval py (reset) · N calls/rows · duration`，`(reset)` 只在本次确实重置 kernel 时出现，`timeout_ms` 不进入 header（它几乎总是同一个默认值，而 duration 已占用这一行的宽度；硬截止仍由工具描述说明），顶层不画 ✓/◐；Level 0 的 collapsed rows 显示每个 nested tool 调用的 `<tool> <path>` 摘要行（file-tool presentation，含 `(+N -M)`），Level 1/2 按 execution 顺序展开全部 rows（printed text 行原样、`display:`/`result:` 带 dim label）。✗ 只在 cell 自身失败时出现；nested tool 失败的 ✗ 保留在子行。copy primary 是 code 原文（不 trim、不剥离控制序列），full 是 code + 已剥离控制序列的输出。code 在 call phase 以 heavy-input rail section 显示。details 缺失时保留 persisted model-visible text，不重跑 code 或读取 workspace。Eval settings form presents `Enable Eval`, `Enable Code Mode`, and `Python interpreter`; Code Mode remains visibly inactive until its exposition is implemented, and all values apply after reload or a new session.
- NEVER fabricate counts, metrics, deltas, or success state absent from the underlying result.

- `pi-subagents` 的父会话状态行只列运行中的 child，不显示 elapsed、不为终态保留展示窗口。启动失败必须刷新为错误状态，不能留下持续计时的 `running` 行。
- `pi-subagents` 自动交付保持终态语义：`error` 不因报告发送变为 `blocked`；成功重试清除旧错误并显示 `done`。
- `pi-subagents` 的自动报告按批次发出：没有其他 child 工作时 500ms 内发出，有 child 仍在工作时最多等 10 秒合并同批报告。批次延迟对 success、blocked、error 相同，只发送本次结果，不拼接历史回答。等待期间用户继续输入、parent 发送新消息或自动重试会取消旧报告；自动重试期间不报告暂时错误。

- 后台 Bash 与子代理各自拥有工具展示格式，通过 ext-core 的纯 `ToolPresentation` 契约提供摘要、输入、结果与 copy 内容。加载 pi-ext-ui 时使用 ToolView 的折叠、上下段和 copy 控件（`toolGroups.copyControl` 关闭后 header 不再占右缘、截断提示也不再承诺 shift+click）；缺少 pi-ext-ui 时保留 Pi 原生主题与 Text 渲染。UI 不硬编码两族工具的字段。spawn 结果始终保留 ID 和路径，get 展示真实查询字段，错误保留可检查原文。

### Lists and Forms

- Lists keep one focus point, stable selection/indentation slots, and stable columns while scrolling.
- Descriptions, providers, scroll metadata, and ordinary empty states use `muted` or `dim`.
- Current/confirmed values MAY use `success` with `✓`.
- Forms use aligned label/value rows; informational rows are not focusable and disabled values use `dim`.
- List-valued settings open a nested editor with one focus list. The editor exposes existing items and an add action, keeps selection geometry stable while add/edit/remove/reorder changes occur, and handles `Esc` before its parent form.
- Prefer compact in-place editing/cycling; use Pi native input/editor for free-form values.
- Forms SHOULD keep their geometry stable while editing.
- Long labels MAY marquee only while selected and non-editing.

### Overlays

- Use overlays for bounded tasks or compact information, not as a second application shell.
- Prefer one page and one focus region unless hierarchy is required.
- Clamp dimensions to the terminal and avoid horizontal overflow.
- A native Pi editor/prompt MUST NOT compete with an active overlay for focus.
- Closing or aborting MUST leave no stale surface.

### Frames and Backgrounds

- A component owns its frame, background, title, padding, dimensions, clipping, scrolling, and line filling as one visual unit.
- Frames are structural; rounded, square, or absent frames are all valid.
- Frame and background are independent choices and MUST use existing semantic tokens.
- Avoid generic wrappers until multiple components demonstrate genuinely identical behavior.
- NEVER nest frames/cards solely to create visual hierarchy.

### Editor-Adjacent UI

- 父会话的子代理状态使用 Pi 原生 `setStatus`；`pi-status` 将运行中的子代理数量以 `agents xN`（如 `agents x3`）放在第二行右侧，位于 TODO 前，两段以 ` ‧ ` 分隔，例如 `agents x3 ‧ <TODO>`。任一段缺席时不保留分隔符；没有运行中的 child 时移除 agent 段，不占额外 Widget 行。窄屏沿用 Footer 的 ANSI/单元格宽度安全裁剪。
- 子代理已确认的完成、错误或阻塞报告通过原生 `subagent-info` custom entry 一次性显示，默认仅显示状态 glyph、编号、agent 名称和结果状态，展开查看完整报告。模型仍通过隐藏的 `subagent-report` 接收原有自动交付；交互 info 不进入模型上下文、不触发新回合。暂时错误不绕过 manager 的沉降、重试和报告去重。
- `pi-subagents` 不注册全局快捷键；用户通过 `/subagents` 命令管理 child，停止操作使用 `/subagents stop [id]`。
- Widgets and rails are status-oriented, normally unframed, and do not take editor focus.
- Use compact semantic formatting and stable left/right regions.
- Preserve usable editor height; temporary status SHOULD disappear when no longer useful.
- Editor text uses `text`; the hardware cursor remains host-owned.
- Editor borders use existing thinking/mode tokens or `borderMuted`.
- Response telemetry, when present, is secondary and low-emphasis.
- Completed response telemetry appears on the bottom rail after `message_end`, including normal responses and responses containing tool calls. It stays visible for the rest of the running request, is replaced by the next response, and is dismissed 15 seconds after the run ends, without adding vertical space.

## Responsive Design

Design the same interaction model for narrow and wide terminals.

- Wide layouts MAY place related regions side by side and expose secondary metadata.
- Narrow layouts SHOULD stack regions and hide optional legends/details while preserving content, focus, and required actions.
- Avoid horizontal scrolling unless the underlying content is inherently horizontal.
- Fixed regions clip or scroll internally rather than changing overall height.
- Cursor-bearing inputs SHOULD preserve one trailing visible cell where practical.
- NEVER create a separate interaction model solely for narrow layouts.

## Accessibility and Rendering

- NEVER rely on color alone; pair it with glyphs, text, structure, or position.
- Maintain semantic contrast across Pi themes.
- Re-render after visible state changes and rebuild cached theme-dependent output after theme changes.
- Extension-owned repaints have exactly two windows. Interaction and discrete state changes call `requestRender()` / `setStatus()` directly and let Pi native frame coalescing (`MIN_RENDER_INTERVAL_MS = 16`) decide when to paint; extensions MUST NOT build their own timer on that path. Paths where one event rebuilds a whole snapshot — subprocess or kernel output, per-operation progress, high-frequency status sources — MUST use `createRenderThrottle` from `@hheei/pi-ext-core` (`STREAM_REPAINT_INTERVAL_MS = 100`) instead of inventing a private window. The throttle decides when to rebuild, never what: the callback reads current state. It paints the first request immediately, collapses a burst into one trailing paint, and MUST be disposed when the execution or session that owns it ends, because a late paint would rewrite a settled result. See `docs/architecture/render-throttling.md`.
- Pi re-renders every mounted component on every frame: a component MUST derive its rows once per width instead of repeating cell-width truncation each time, and MUST keep that cache inside one component instance, because the host re-running a renderer is what rebuilds theme-dependent and collapsed output. A cache keyed by rendered text and width (as `pi-settings` fits its rows) is exempt: the key already contains the theme-dependent string, so a theme change produces a different key instead of a stale hit.
- `truncateToWidth` costs ~4-6us on any row carrying ANSI styling or non-ASCII glyphs, against ~0.1us for plain ASCII, because it falls back to `Intl.Segmenter`; any per-frame row fitting must therefore be cached by `(text, width)` rather than recomputed.
- Rendering MUST remain ANSI-safe, Unicode-width-safe, and terminal-cell-width-safe.
- UI changes SHOULD be tested at representative narrow and wide sizes and verified in Pi.

## Feature Specs

工具行的着色词汇只有一处定义（`@hheei/pi-ext-ui` 的 `formatToolHeaderText`）：`状态字形 + toolTitle(bold(工具名)) + 摘要 + 次要元数据`，按上表着色。摘要的语义由拥有该工具的层给出：`read` 传入已着色的 `accent` 路径与 `warning` 行范围，`bash` 的命令按上表 `toolTitle`+bold，其余工具为 `dim`；`meta`（耗时、`timeout`）始终 `dim`，两者以 `dim` 的 ` · ` 分隔。容器工具（`codemode`、`eval`、`subagent`）在 Level 0 画子调用看板时，每一行都复用同一个函数，只把折叠针 `▸` 换成父级导轨 `▎`；看板不得自行拼行——自行拼行会让子工具摘要失去语义、工具名失去 `bold`，同一个调用在容器内外呈现不一致。`pi-python-eval` 不能反向依赖 `pi-ext-ui`，其子调用行在 presentation 内按同一张表着色。


[`pi-loadout`](docs/architecture/pi-loadout.md) 的 `/ext-loadout` 是 Pi 原生资源装配面板，拥有 `PANEL_ROWS` 行固定高度：上边线、标题行、搜索行、列表视口、提示行、下边线。它按资源类别分组（`skills`、`extensions`、`prompts`、`themes`、`packages`、`tools`），宽终端（≥76 列）列表与详情并排，窄终端上下堆叠。每一行的状态只用 Nerd Font 字形表达，不依赖颜色：`󰄴` 启用、`󰄰` 停用、`󰐙` 项目显式启用、`󰍷` 项目显式停用；项目作用域下无覆盖时显示继承结果。详情面板按优先级排布（名称、来源、Global、Project、Effective、路径、描述），行数不足时先丢掉空行再截断描述，因此状态事实永远可见。Tab 切换写入作用域，并且标记本身随作用域移动，不以颜色区分。同名资源（例如两个 `research` skill）用来源目录限定，避免两行无法区分。

[`DESIGN.md`](DESIGN.md) owns shared visual and interaction invariants. Exact dimensions, row counts, feature shortcuts, field layouts, command presentation, and other feature-specific behavior belong in the owning feature's design or architecture document.

Promote a feature rule into this document only after it becomes a genuinely shared pattern.

[`pi-optimizer`](docs/optimizer/README.md) 的 `/optimizer` 使用 Pi 原生选择与输入对话框；四项功能与 RTK 路径共享同一 Settings provider。Esc 取消当前层，不写入未确认值；会话关闭时通过 signal 关闭对话框。T2S、Prompt 的实际注入、RTK 异常与设置结果通过原生 custom entry 即时显示为对话 info；RTK 成功应用不追加提示，实际执行命令由 bash 工具调用展示：默认 dim 摘要，展开完整 payload，错误以 warning 语义标明。记录支持 resume，Headless 消费 `entry_appended`；不进入模型上下文、不触发额外 turn。

[`pi-ext-memory`](packages/pi-ext-memory/README.md) 的 Hindsight 记忆注入同样通过原生 custom entry 即时显示为对话 info：默认列出本轮召回页面的标题（`󰄴` 表示确实进入 prompt 的内容），展开后显示每个页面的 id 与真正注入给模型的片段，容器被 `maxMemoryChars` 截断时在同一 entry 内以 `󰀪` warning 行说明。记录支持 resume，Headless 消费 `entry_appended`（`customType: "memory-info"`）；不进入模型上下文、不触发额外 turn。
- `pi-ext-memory` 空闲到期只提示，下一次发送消息时先压缩再请求模型；空闲提示与压缩均不设 token 门槛。

[`pi-goal`](docs/architecture/pi-goal.md) 的 `/goal` 使用 Pi 原生 editor/confirm dialog 收集目标与替换确认；`/goal status` 通过 `ctx.ui.notify` 输出完整事实，包括 recovery 错误、清理未确认诊断与会话尚未落盘时的 `Durability:` 提示。目标状态变化追加 `pi-goal` custom entry，由 `registerEntryRenderer` 渲染为单行信息：状态字形 + `accent` 的目标摘要，默认只显示 disposition、definitionRevision 与额度余量，展开后显示完整 objective、acceptance、checkpoint、evidence、lastReview 与清理诊断；窄终端按单元格宽度折行，不横向滚动。`/goal start`/`resume` 投递一条可见的 `pi-goal-kickoff` 消息唤醒模型；自主续跑使用 `display: false` 的 custom message，不占聊天正文；审查拒绝的 `pi-goal-review` 消息 `display: true`，让用户看到 reviewer 的反馈。kickoff 走 ext-core BackgroundDelivery，只在父会话 idle 时发送且不进入原生 follow-up 队列；`hasPending` 与 flush 都会重新校验 run，过期消息不唤醒父会话，也不抢占其他 channel 的最终唤醒。审查拒绝反馈不调用 void 的扩展 `sendMessage`，而由 native `agent_before_settle` 的可见 custom_message draft 提交并继续一次请求；提交后以 branch 中匹配 run/goal/attempt 的 entry 作为真实交付证据，提交失败则显式 pause，不静默 ACK。pending 反馈期间不额外消耗 continuation 预算。若 reviewer 在父操作最后一次 settle 之后才拒绝，则不做不安全的异步唤醒，而是显式 pause 并在 resume kickoff 中带上 findings。`goal` 工具行沿用工具表：`toolTitle(bold(goal))` + `dim` 摘要，复用现有 presentation，不新增主题 token、dashboard 或模态 UI，也不修改 pi-status 排序。