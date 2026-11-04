# 委派参数、请求用量与 subagents 状态补充排查

状态：只读排查与需求记录；未修改实现。现有 worker 继续原 01–03，本文件不扩大其任务。

## 1. agents_delegate 多次失败

### 实际调用顺序与原因

1. 直接调用提供自造 id（特殊字符、ci-ui-worker）：Unknown child。当前 id 不是创建时的自定义名称，而是已有 child 的选择器。
2. 提供空白字符串：Child id must not be empty。空白当前不等价于省略。
3. 提供 agent-1 同时写 agent=worker：实际接受的是已有 reviewer。描述与 manager 都明确 id 优先，忽略 agent/cwd；因此这次没有创建 worker。随后停止了该 reviewer，不能将这次接受算作成功启动 worker。
4. 提供当时尚不存在的 agent-2：Unknown child。
5. describeTool 后通过 codemode 调用，省略 id，仅传 agent=worker、cwd、task、wait=false：成功创建 worker agent-2。

直接原因包括本次错误填入 ID、尝试空白和猜测已有 ID。没有证据是子进程启动失败或身份分配冲突。正确调用是创建时省略 id，复用时提供已经查明的 id，不能猜测。

### 契约与暴露层不一致

- packages/pi-subagents/src/tools.ts delegateSchema：task 必填；wait/id/agent/cwd 均 Type.Optional；id 字符串 minLength=1。
- manager.ts 的 delegate/submitDelegation：id 存在即选择复用路径，空白拒绝、未知拒绝，agent/cwd 忽略；不支持调用者指定新 ID。
- session-bootstrap.ts 的 nextSubagentId 路径自动分配 agent-N。
- MCP 的 mcp/delegate.ts 同样 optional，但运行时拒绝空白。
- 本次对模型暴露的直接 functions.agents_delegate 声明中，agent/cwd/id/wait 全列为必填；describeTool 返回的 codemode declaration 则正确为 optional。两者与同一 TypeBox 来源不一致。
- 已观察到“直接声明 optional 丢失”，但尚未定位丢失发生在 harness 工具声明桥接、schema 转换还是最终展示阶段。不能仅凭声明反推仓库 schema 错误。
- 已检查本机 pi-ai constrained-sampling.js：strict 转换将 optional 变为 required + nullable，并非本次看到的 required string。它不能单独解释现象。未检查实际 outbound provider payload，不能宣布 provider 是根因。

### 用户提出的候选语义

用户询问是否允许手动 ID，或 optional/空白自动分配。建议保持“非空 id 只复用已有 child，省略自动创建”；是否接受空白作为省略，需要显式定稿并同步 native/MCP/schema/描述/测试。不能将未知非空 ID 自动创建，否则打错 ID 会启动新 agent，掩盖错误并改变复用语义。

后续验收：直接暴露与 codemode 都保留 optional；创建不传 id 成功、返回自动 ID；已有 ID 复用；未知 ID 无副作用；空白按已选契约一致处理；id+agent 的优先级有明确例子。先用假的 manager 验证工具契约，不为复现而启动/停止真实 worker。

## 2. Requests 与 IN/OUT 累加口径

### 用户明确要求

Requests ×8 对应同一集合的 8 次请求。IN、OUT 是这 8 次请求的总和，字段口径与 Pi 原生一致，不是最后请求、不按平均、不使用上下文窗口大小、不因展示折叠而漏记。不将 cacheRead/cacheWrite 混入 IN 冒充 Pi 原生输入字段。

### 当前实现与 Pi 对照

- tool-group-view.ts #usage 遍历 #members：每个 kind=assistant 令 requests+=1，即使没有有效 usage；有 usage 才累加 input/output。因此“按最后一条显示 IN/OUT”不是当前代码的错误：这两字段已经求和。
- 只有 CH 取 latest usage 的 cacheRead/(input+cacheRead+cacheWrite)；这与 Pi footer 的 latest prompt CH 方向一致，不应顺手改成平均 CH。
- host-transcript-patch.ts assistantInfo/rebuild 只把 eligible assistant 传入组；混有非空正文、length/aborted/error 等会走原生边界，不加入该组。工具本身的 usage 未投影入 #usage。
- requests 当前计数的是 eligible assistant 组件，不是独立已确认的 provider request 集合。无有效 usage 的组件也算一次，partial/final/错误和展示过滤必须逐项核查。
- 本机 Pi dist/core/usage-totals.js addUsageToTotals 分别相加 input/output/cacheRead/cacheWrite。
- 本机 Pi dist/modes/interactive/components/footer.js getSessionStats 遍历所有 session entries：usage entry、assistant message usage、toolResult usage、branch_summary/compaction usage 都会累计。它的全会话累计范围不等于当前活动组；不能为了数字相同把全会话总量放进每组。

### 已证实与未证实

已证实：字段本身已有 sum；来源集合与计数来源依赖 UI 投影，与 Pi 完整 usage 来源不同，存在丢项及计数/用量集合不一致的风险。

未证实：用户截图 Requests ×8 · IN 3.6k · OUT 1.3k 的具体差额。本轮未读取对应会话 8 个请求，不能断言具体漏掉哪一条或认为 cache 必须并入 IN。缓存命中高时 uncached input 较小可能正常，需以实际 usage 为准。

### 后续修正与验收

1. 以有稳定身份的请求/usage 事实定义集合，先明确 block 边界、组外尾部和工具附带 usage 的归属；计数与求和使用同一集合，展示迁移不重复或漏记。
2. 给定 8 个确定 usage，精确断言 Requests=8，IN=sum(input)，OUT=sum(output)；以未格式化整数对比，再检查 compact format。
3. 用与 Pi 相同的字段加法对照该请求集合，而非拿组局部值比较整个 session 的总值；缓存读写独立，CH 不被误改。
4. 加入 partial→final、取消/失败、包含正文的 assistant、缺 usage、工具附带 usage、断组、resume/compaction 后历史案例；未纳入哪些来源须有明确归属说明，不能重复计费型 usage。
5. 对用户原始 8 请求记录列出逐请求 input/output 及总和，确认差额；找不到该 session 时报告证据缺口，使用确定 fixture 验证算法，不伪造现场复现。

此项补充到 ticket 04 的统计验收；若需独立 usage 数据边界或跨包接口，先记录设计再实现，不直接增设“请求注册中心”。

## 3. subagents footer 简化

### 用户目标与原因

改为 agents xN，去掉机器人、运行 glyph 和 ID 列表，保留简明数量。

直接发生点：packages/pi-subagents/src/status.ts formatSubagentStatus 过滤 visual running children，然后拼“🤖 ”+running glyph+formatSubagentId 列表；#2 来自 agent-2 的展示简写。status.test.ts 明确断言旧字符串。extension.ts 通过 createRenderThrottle 刷新原生 setStatus，本身不需要换状态传输机制。

### 建议验收契约

- 沿用现有计数含义：N 为 visual running child 数，不包括 done/error/blocked/interrupted，不按 delegation revision 重复计数；若改为全部 agent 总量，另行明确。
- 一台运行显示 agents x1，三台显示 agents x3；使用用户要求的 ASCII x，不增加 emoji、Nerd Font glyph 或 #id 列表。
- N=0 沿用当前行为移除状态，不显示空占位；保留现有 abort/dispose 幂等清理、节流与最后状态送达，不新增 timer/widget。
- ID 仍在 dashboard/工具结果可检查；不要删除 formatSubagentId，info.ts 仍使用它。
- 通过 status.test.ts 验证混合状态计数、running→done、重复 refresh、abort 后不能恢复；窄屏无依赖特殊字体。

本轮只记录。后续实现仅涉及状态文本与聚焦测试，并同步 DESIGN.md 对应 UI 契约。

## 验证与边界

## 4. 拼错工具名不计入有效调用统计

用户补充：grep ×4 · codemodE ×1 · edit ×31 中，若 codemodE 没有解析到真实工具，不应出现该类别或增加有效 calls。错误调用仍保留原记录与报错，不能为美化统计隐藏诊断。

静态发生点：host-transcript-patch.ts 的 toolMember 只核对 assistant toolCall ID 与 ToolView renderer，不验证该调用是否解析到真实工具；ToolGroupView.#calls 对每个 tool member 累加 childCount/children.length/1；renderer.ts nestedChildren 同样把捕获调用映射成统计项，没有“未解析工具”过滤。能够构造一个错误 ToolView 不等于真实工具已被找到。

这说明当前统计层缺少区分“未知工具请求”和“真实工具失败”的事实；具体 codemodE 示例是否经过顶层或容器路径仍需原调用确认，不能仅凭名称外形判断。

验收约束：

- 未解析到工具的调用不增加 header 有效 calls、分类名称或容器有效 childCount；顶层、codemode、python_eval 一致。
- 名称大小写必须遵循真实 resolver，不能擅自 lowercase；若确实注册了 codemodE，必须正常计数。
- 真实工具的执行失败仍计数。参数验证失败/取消/权限拒绝的计数边界需写清楚；本次明确排除的仅是未知工具，不能一刀切剔除 isError。
- 错误正文保留完整可检查入口；未知工具不产生新的正常工具统计类别。
- 不用错误字符串匹配判断 unknown tool；不拿“当前激活工具清单”过滤恢复历史，因为已卸载工具的旧调用当时可能有效。
- 容器父替子规则同步修正：存在子调用但全为未知时，有效子调用数为 0，不能回退把父容器计 1；真正没有子调用的容器仍按既定规则计数。
- 如已有事实不能区分，先查 host resolver/捕获边界，再提出最小事实字段；不能只在 UI 加一个工具名白名单，也不能静默增设持久化契约。

## 5. delegate 易用性讨论（未批准实现）

先修声明暴露链，保证 optional 不丢；这是工具形状问题，改描述不能替代修 schema。

两个可选设计：

1. 保持单工具：创建必须 agent 且省略 id；复用必须已有 id。若两者同时非空，建议改为明确拒绝，避免静默复用错误角色；空白可在入口规范化为省略，但必须同步 native/MCP 并确认契约。优点是迁移小，缺点是同一 schema 仍有两条条件分支，依赖参数组合。
2. 拆分创建与续派：创建工具只收 agent/task/cwd/wait，续派工具只收 id/task/wait。优点是两种真实生命周期动作在 schema 上分开，agent 无法在创建时误填 child ID，也不能在续派时误以为可换角色。成本是工具名/公共契约迁移、MCP 与 callers/tests 更新；需检查持久化回放与现有调用方再决定是否删除旧入口，不自动加永久兼容 wrapper。

推荐把方案 2 作为目标，先批准再改。无论哪种方案，都禁止 unknown ID 自动创建、禁止猜已有 ID，也不增加 fuzzy 工具名自动纠正。

验证入口：直接工具和 codemode 的 schema 一致性测试；有效创建/续派、缺目标、双目标、空白、未知 ID、并行 busy、错误无副作用；错误给出正确的创建/续派示例，不泄漏无关内部状态。

- 已执行 graphify query，读取 delegate schemas/manager、状态与测试、活动组 usage/投影、本机 Pi footer/usage-totals 和 strict schema 转换实现。
- 没有为调查新增 delegate 调用，没有扰动正在运行的 worker，没有修改代码。
- 文档检查：git diff --check；未运行 TypeScript、单元测试或 herdr。

## 6. 声明暴露链复核（2026-10-29，已实现最小描述修正）

### 结论：仓库、会话工具快照与已检查桥接链未发现 optional 丢失

§1 记录的直接工具呈现与仓库、会话快照不一致。复核确认仓库与已检查链路的 required 正确，不能据此修改 schema；会话快照不等于原始 outbound payload，也不能单独证明最终模型侧呈现一定正确。

证据（按链逐段核对，未修改任何 Pi host 代码）：

1. 仓库契约：`packages/pi-subagents/src/tools.ts` delegateSchema 的 `required` 只有 `["task"]`；`wait/id/agent/cwd` 为 `Type.Optional`。已安装的 `~/.pi/agent/npm/node_modules/@hheei/pi-subagents@0.8.0` dist 与仓库源一致。
2. 会话记录（模型实际收到的声明）：`~/.pi/agent/sessions/--repo-session-/2026-10-28T17-54-53-219Z_01a183a6-....jsonl` 中 system message 的 `toolsAdded` 记录为
   `{"type":"object","required":["task"],"properties":{"task","wait","id","agent","cwd"},"additionalProperties":false}`。
   全目录扫描只找到这一份 agents_delegate 声明，说明当时暴露的就是正确形状。
3. host 桥接：`dist/core/tools/tool-definition-wrapper.js`、`dist/core/extensions/wrapper.js` 原样复制 `parameters`；`_applyToolLoadout`/`prepareLoadout` 只改 description 与隐藏项，不改 schema。
4. provider 映射：provider 的 tools 来自 `pi-ai/dist/utils/transcript.js getCurrentTools(messages)`，即上面的 `toolsAdded`。`openai-completions`、`anthropic-messages`、`openai-responses`、`google-shared` 都只在 `constrainedSampling: {type:"json_schema"}` 时走 `makeStrictJsonSchema`；delegate 未声明 constrainedSampling，因此 strict 解析为 undefined，payload 保持 `required:["task"]`。strict 路径本身把 optional 变成 required + `anyOf [T, null]`，也不会产生“required string”。
5. codemode/tool_search：`describeTool` 与 codemode 描述都用 `pi-codemode/dist/declarations.js schemaToType`，读同一 `required`，所以显示 `agent?: string` 等。
6. MCP：`fromJsonSchema(delegateInputSchema)` 的 `~standard.jsonSchema.input()` 原样返回 TypeBox，`required` 同样只有 `task`。

已检查实现没有定位到“required 丢失”的仓库缺陷；最终传输/呈现差异仍缺原始 payload 证据。不要把 optional 改成空白占位，不 vendor/patch Pi host，不为猜测修改 schema。

### 已实现的改动（只改描述与测试）

- `getDelegateDescription`：把“supply agent 或 id”改为“省略 id 即创建，Pi 分配 id，不要猜或传空白 id；id 只用于已见过的 id，优先级高于 agent，未知 id 无副作用地失败”，并加一行创建/续派示例。仍是 native `ToolDefinition.description`，未新增 prompt monkey patch、wrapper 或全局重写。
- `test/agents-tools.test.ts`：新增两条声明/描述契约测试（`required` 只有 task、属性集合固定；描述包含创建/续派示例、available_agents 列表，且行数上限 7）。
- `README.md`：同步“省略 id 创建、id 由 Pi 分配”。
- 运行语义未改：未知非空 id 仍然只报 Unknown child，不创建新 child。

### 未解决

- §1 的观察来源仍未知（模型自述或人工转述均可能）；现有证据只能证明当时暴露的声明正确。若再次出现，请保存当时会话的 `toolsAdded` 记录或 outbound payload，才能定位是否还有别的前置层。
- 用户已拒绝拆成两个工具；后续提出单工具规则：已有 id 复用、未知显式 id 创建、未写 id 自动分配。该候选运行语义本次未实现，当前描述仍对应现有运行时，不把讨论误写成已交付行为。

### 主助手复核

- 原生工具 description 的新增指引进一步压缩为两行规则/示例，无 prompt monkey patch。
- 直接工具呈现中的字段必填现象不应被会话快照证据直接否定；当前结论限定为已检查链路没有发现 schema 缺陷。
