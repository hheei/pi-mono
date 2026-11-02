# pi-subagents V1 规格

统一工具契约见 [统一 Agents API Spec](unified-api-spec.md)，逐项状态见 [AGENTS Tickets](unified-api-tickets.md)。AGENTS-01～07 已落地（`agents_delegate`、`agents_get`、`agents_stop`、`agents_dashboard`），AGENTS-08 的实机验收未完成；本文的 session/runtime ownership 是那条工作线的基础，旧工具名称不作为兼容要求。

本规格是 V1 的运行时合同。设计依据与 Pi API 核对记录在归档的 [`PLAN.md`](../archive/pi-subagents/PLAN.md)，V1 的任务历史在归档的 [`tickets.md`](../archive/pi-subagents/tickets.md)；当前已落地行为以 package README、源码和测试为准。

本文只保留运行时合同。用户目标、明确不做、完成定义与实施顺序见 [范围与路线](roadmap.md)。

## 1. 核心身份与所有权

### 1.1 身份

```text
logical child = subagent ID + parent session ID + Pi child session
runtime       = child Pi process + mailbox connection（+ 可选 host panel attachment）
presentation  = 由 spawn 决定：host panel 里的 native Pi TUI，或无终端的后台进程
```

Pi child session 保存对话。PID、mailbox 连接（SQLite 命令队列 + 进程锁）、pane ID 和 surface ID 都是可替换的 runtime attachment，不是 child identity。
bridge 是控制面（实现在 `mailbox.ts` 的 SQLite 命令队列与进程锁上）：指令、事件和「这份 runtime 是否还在应答」。它不是所有权。所有权是 §6.7 的会话租约：`intent` 与 attachment（Herdr tab、cmux surface 或 pid）在副作用之前写入。宿主列表或 pid 用来对账，不扫 session JSONL。

### 1.2 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| Pi host | session JSONL、原生 RPC、原生 TUI、model registry | child ownership、handoff、跨 parent 恢复 |
| `pi-subagents` parent branch | agent/config resolution、manager、tools、registry、transition、delivery policy、HostAdapter | 重画 Pi TUI、通用 scheduler |
| `pi-subagents` parent branch 的 MailboxTransport | state.sqlite 命令队列、进程锁、registry、单 runtime 规则、panel 生命周期、host 选择 | 解析终端画面、镜像 transcript |
| `pi-subagents` child branch | 执行 parent 请求、转发 Pi 事件、上报 `contact_parent`/lifecycle/task result、断线重连与有界缓冲 | manager、spawn tool、递归 child、关自己的 panel、旁路文件、扫 session |
| 后台 child 进程 | 无终端运行；stdin 由 parent 持有，parent 进程结束它即结束 | 自行重连另一 parent session |
| ext-core | parent lifecycle、JSON 原子更新、`ToolPresentation` 契约、可选 surface/widget primitives | durable child supervisor、跨进程 IPC、handoff policy |
| Herdr/cmux | panel 的 open/observe（含聚焦）与 cleanup | child identity、语义消息、session persistence、拼第二份 Pi argv |

child 的身份与生命周期由本规格定义（见 §4、§6）。ext-core 不再提供可承载 child 的 coordinator。

**已删除的所有权**：独立 runner 进程及其 endpoint/claim/handshake 体系、pause gate、attach/detach 状态、`writer_exit` 语义、`controller`/`reporter`/`recovery` 角色划分。

## 2. 目标数据流

### 2.1 后台执行（presentation=background）

```text
agents_delegate / Task tool（无 host 时）
  -> resolve agent + effective launch config
  -> persist child/session intent（state=starting，presentation=background）
  -> parent spawn 一个 headless child Pi（--mode rpc，stdin 由 parent 持有）
  -> child 持有自己的进程锁，父端据锁判定"写者还在"
  -> mailbox 就绪后投递 initial task（bridge request: prompt）
  -> state=running
  -> parent tools <-> bridge <-> child branch
```

多个 `spawn_subagent` tool call 可由 Pi 并行执行；不增加 batch spawn API 或 extension-owned scheduler。

### 2.2 Panel 呈现与 bridge 控制面

```text
agents_delegate
  -> presentation 在 spawn 时决定（panel：host tab/surface + LaunchSpec argv；后台：parent 直接 spawn）
  -> child 进程内 MailboxTransport 轮询同一 state.sqlite
  -> parent 只经 bridge 驱动 child（prompt/steer/follow_up/get_state/session_facts/get_entries/abort/shutdown）
  -> child 经同一连接回传 Pi 事件、child_lifecycle、child_input 与 report（contact_parent/task_result）
  -> agents_stop：先写 stopped 意图，再关闭 panel / 结束进程
```

不再有 attach/detach：没有 writer 交接、没有输入冻结、没有 pause handshake、没有 `close_writer`/`start_rpc`。
同一个 child session 在整个受管理流程中最多一个受管理 runtime（§4.3）。用户直接用 Pi 原生 `/resume` 或外部进程打开同一 session 不在该保证范围内，也不得被 extension 拦截。

呈现方式在 spawn 时冻结并记录在 registry 的 `presentation` 字段；`agents_delegate` 不暴露该参数，默认在有 host 时用 panel、没有 host 时用后台，并且**在 spawn 结果里明说**用了哪一种以及 fallback 原因（不静默改变执行环境）。Task tool 同样采用这个 host 优先策略；Task 仍由 parent 收口并在提交最终结果后结束，panel 只是 child runtime 的可见呈现，不改变一次性 Task 合同。

“有 host”由事实判定，不由环境变量判定：只有当宿主的 pane/surface 的前台进程是本进程或其祖先时，才认为该宿主可以承载面板；pane 自己的 shell 不算（它是空闲兜底，否则 `pi &` 也会认领这个 pane）；继承来的 `HERDR_ENV`/`HERDR_PANE_ID` 只用于候选排序。panel 打开失败且调用方未显式要求 `panel` 时，在同一 spawn 窗口内把记录改为 `background` 并在 spawn 结果里写明原因，child 照常运行——此时还没有任何 panel 呈现给用户，因此不违反“呈现方式冻结”。只有显式 `presentation: "panel"` 才以失败结束。宿主拒绝命令时，其错误码与消息必须进入调用方可见的原因（两个宿主都用 exit code 0 + JSON error 报告 API 失败）。

panel child 的进程由 host 持有，parent 只持有 attachment：

- spawn 时 parent 仍然铸造 runtime identity 并构造唯一的 LaunchSpec（`presentation=panel` 时不含 `--mode rpc`、stdio=inherit），再交给 HostAdapter 打开 panel 并运行该 argv；
- 写者是否还在只看进程锁，以及本进程自己持有的进程句柄。关闭 panel 只证明 attachment 消失。
- 写者消失不是终止：child 保持身份与 session，后续 `agents_delegate` 用同一 session 再起 runtime（不重放中断的 turn）。宿主已确认 panel 进程不在时关掉空标签；标签还在则留着，调用方要收掉就 `agents_stop`。

### 2.3 Recovery

```text
parent 启动
  -> 打开同一 state.sqlite，接管 parent-scoped 命令队列
  -> 载入 parent-scoped registry
  -> 仍持有进程锁的 child 被重新识别 ⇒ adopt（读 entries 与 get_state，不新建 runtime、不重开会话）
  -> background child 的 runtime 证据随之作废：进程随 parent 结束，记录清掉 runtime、落 idle 并记 interrupted，后续 send 用同一 session 拉起新 runtime
  -> panel child 由 host 持有，可能仍在运行：记录保留 runtime 证据并标记为「未确认」，send 一律拒绝，直到那个 runtime 自己重连（adopt）或被 stop 显式清掉
```

后台 child 由 parent spawn 并持有 stdin，因此随 parent 进程结束（registry 记 interrupted，不自动重放）。
panel child 由 host 持有进程，天然跨 parent 存活，因此它的 runtime 不能因为「没在 adopt 窗口内重连」就当作已死。
重新打开 session 不等于继续任务：中断的 turn、initial task 或未确认消息不得静默重放。

## 3. 最小公共合同

### 3.1 Model-facing tools

会话模式注册 deferred 工具，通过 `tool_search` 按需加载：

```ts
agents_delegate({ task: string, agent?: string, id?: string, cwd?: string, wait?: boolean })
agents_get({ id: string, revision?: number, includeOutput?: boolean })
agents_stop({ id: string })
agents_dashboard({})
```

执行状态各自管理：
SubagentManager 与 SQLite ledger 独占 child conversation、runtime lease、恢复和报告；不依赖 pi-ext-tools 的任务服务。后台 Bash 与子代理只共享 ext-core BackgroundDelivery 的交付批次协调，模型工具按 ownership 分成 `bg_bash_*` 与 `agent_*`；没有 list 或等待工具。

规则：

- 不提供批量派发工具；并行由 Pi parallel tool calls 提供。
- 新建 agent 必须给出明确 agent name；缺名或解析失败在启动前失败。有 `id` 时 `agent` 被忽略。
- 新 agent 的 ID 由系统分配，不接受调用方指定；不暴露 model、thinking、tools、extensions、skills 或 budget 参数。
- `agents_delegate` 返回 `{ id, revision, status, task, hasOutput }`：`revision` 是该 agent 上单调递增的委派序号，标识这一次派发。`wait:true`（缺省）等到结算并带结果正文；`wait:false` 受理即返回，结果仍会自动交付。`agents_stop` 成功返回该 agent 的同一投影。
- 委派没有 `title` 与 `mode` 参数：child session 标题由系统用 `🤖 <agent> · <subagentId>` 推导，接续始终是 steer。
- `agents_delegate` 返回后，模型不得用 `agents_get` 轮询等待 child 完成。Child 沉降后 Harness 自动提取最终输出文本并以 `customType: "subagent-report"` 交付父会话：没有其他 child 在跑时 500ms 内成批发出，有 child 仍在工作时最多等待 10 秒把同批报告合并；卡点则通过 `contact_parent` 立即唤醒父会话。
- `agents_get` 缺省读取该 agent 最新的委派，`revision` 选择历史委派，`includeOutput` 为真时才返回结果正文，并沿用 ext-core 的同一输出上限。投影同时给出委派 `status` 与 `progress.runtimeState`，两者分开呈现，历史结果不会被新一轮覆盖。
- `agents_dashboard` 只返回运行统计和每个 agent 的最新委派摘要，不返回正文。
- `agents_delegate` 用 `id` 接续时接受目标 child 的任意状态；接续已完成（done）的 child 会自动唤醒并恢复其上下文。模型切勿在派发前等待或要求 Worker “冻结代码”。
- `agents_stop` 是唯一 model-facing 终止操作：先持久化 stopped 意图，再结束 runtime；未结算的委派记为 failed，已完成的结果与会话保留。

### 3.2 Child-facing tool

child branch 注册：

```ts
contact_parent({
  message: string;
  reason?: "blocked";
})
```

- **正常完成不调工具**：子 Agent 完成任务时直接输出最终回答文本即可。Harness 在 child 沉降后自动提取文本完成汇报，并将 child 状态保留为 `done`。
- **卡点与决策**：子 Agent 仅在遇到真正阻碍自身无法继续的严重卡点、或必须由父 Agent 决策的关键问题时调用 `contact_parent`。报告立即唤醒父 Agent，并将 child 状态记为 `blocked`。

### 3.3 Agent definitions

按下列顺序发现 Markdown agent definitions，较具体 scope 优先，重名行为必须确定且可测试：

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
~/.pi/agent/agents/*.md
<builtin>              # 随包发布的定义，不写入用户 home
```

使用 Pi `parseFrontmatter` 解析 YAML，再对 `unknown` 做本 extension schema 校验。V1 支持已验证且能兑现的字段：

- catalog：`name`、`display_name`、`description`、`hidden`；
- runtime：`model`、`thinking`、`tools`、`exclude_tools`、`extensions`、`skills`；
- policy：`interactive`（boolean，缺省 `false`；`true` 表示用户会在原生 TUI 操作该 child。除 `contact_parent` 外本包不得 `triggerTurn` 叫醒 parent。创建时冻进 launch config，RPC/TUI/restart 复用）；
- Markdown body：固定 prompt assembly 的 agent instructions。

内置层有三个定义，都可被发现但不会被自动派发，都继承父模型与 thinking：
`scout`（只读侦查：`read`/`grep`/`find`/`ls`/`contact_parent`）、`worker`（实现：再加 `bash`/`edit`/`write`）、
`reviewer`（审查：`read`/`grep`/`find`/`ls`/`bash`/`contact_parent`）。工具名允许被 extension 扩展，因此内置
定义必须显式列出 `tools`——空的 `tools` 在下游意味着“全部工具”，与其承诺相反，属于配置失败而不是静默
放宽。这是工具能力限制，不是操作系统沙箱。

**`skills` 是白名单**（`extensions` 仍是 additive：bridge 必须始终在选中的 extension 列表里，二者语义不同）：

| 写法 | child 实际加载 |
|---|---|
| 省略 / `true` / `all` | Pi 发现的全部 skill（`skills: true`，不传 `--no-skills`） |
| `false` / `none` | 一个都不加载（传 `--no-skills`） |
| 列表 | **只加载这些**：传 `--no-skills` + 每个条目的 `--skill <绝对路径>` |

列表里的条目按形状区分：以 `./`、`../`、`~/`、`/`、盘符开头 → 定义文件旁的本地路径（必须存在，否则启动前报错）；
含 `:`、`/` 或 `\` → 原样交给 Pi 的路径/包规格；**其余当作 skill 名字**，在 parent 已加载的 skill 列表里解析。
名字的权威来源是 Pi 自己：`before_agent_start` 事件的 `systemPromptOptions.skills`（`name` + `filePath`），
所以本包不重新扫描磁盘、也不会与 Pi 的优先级/同名冲突规则不一致。名字找不到时**只 warning**（parent UI），
该条目被丢弃 —— 白名单只会变窄，绝不会因为写错名字而回退成「全部继承」；没捕获到 catalog 时同理（child 不加载任何 skill）。

内置层有三个定义，都可被发现但不会被自动派发，都继承父模型与 thinking：
`scout`（只读侦查：`read`/`grep`/`find`/`ls`/`contact_parent`）、`worker`（实现：再加 `bash`/`edit`/`write`）、
`reviewer`（审查：`read`/`grep`/`find`/`ls`/`bash`/`contact_parent`）。工具名允许被 extension 扩展，因此内置
定义必须显式列出 `tools`——空的 `tools` 在下游意味着“全部工具”，与其承诺相反，属于配置失败而不是静默
放宽。这是工具能力限制，不是操作系统沙箱。

`reviewer` 需要 `code-review`、`ponytail-review` 这类审查 skill。内置定义保持 `skills: all`（把具体 skill 名字
写进随包发布的定义会让没装它们的机器直接启动失败），要收窄就在项目级或 user 级同名定义里写白名单，例如
`~/.pi/agent/agents/reviewer.md` 里 `skills: [code-review, ponytail-review]`。

未知字段、未知模型、无效 thinking、冲突的 tool policy、非 boolean 的 `interactive`、被禁用的 `contact_parent`、不存在的本地 path 条目在启动前报错；未知的 skill **名字**只 warning。`exclude_extensions`、`preload_skills`、`max_turns` 和 `max_tokens` 在拥有明确执行语义前不属于 V1 合同。

### 3.4 Effective launch configuration

agent definition 与 parent 显式默认值只解析一次，形成可观察、非 secret 的 immutable launch spec：

```text
Pi invocation + argv + cwd
session ID/path
session title（可选，展示用）
agent identity + prompt assembly
provider/model + thinking
final tool/extension/skill selection
interactive policy
child bridge environment
```

后台 child、panel child 和 replacement runtime 共用同一 builder；只有 presentation、stdio 和 attachment 不同。默认 model/thinking 的继承必须显示在结果和状态中，不得静默替换 provider/model。API key 等 secret 不写 registry。

## 4. 持久化合同

### 4.1 Parent-scoped registry

V1 使用一个 SQLite 账本 `<agentDir>/pi-subagents/state.sqlite`（WAL，`busy_timeout=5000`，0600），按 `parentSessionId` 隔离。它同时承载 `children`（记录 + revision）、`session_meta`、`commands`（双向命令队列）与 `delegations`（委派 receipt）四张表，并用 `revision` 做条件写入、拒绝过期 writer。它不写入 `settings.json`，也不引入 event ledger 或 handoff history。库用 `PRAGMA user_version = 2` 标识当前格式。打开旧库时**原地升级**：建缺失的表、按需 `ALTER TABLE ADD COLUMN` 补齐已知新增列、建索引，最后写入版本号。文件与 WAL 不换名，因此同一台机器上另一个还在运行的 Pi 进程不会与升级后的账本分叉；升级只做加法，已有的 `children` 与 `delegations` 行全部保留。版本号高于本程序时明确报错并拒绝打开，而不是猜格式或重写别人的账本。

每个 child 至少保存：

- `subagentId`、`parentSessionId`、`sessionId`、可选 `sessionPath`；
- `cwd`、agent、初始任务、active/stopped 意图；
- 非 secret effective launch config；
- `state`、`presentation`（`panel` | `background`，spawn 时冻结）及 last-known summary/usage；
- 最后一次 launch 的 `runtimeIdentity` 与 endpoint（是证据，不是 liveness 证明）；
- 首次落盘状态与未确认输入。

mailbox 没有凭据：「谁在写」由 `locks/<parentSessionId>/<childId>.lock` 上的内核锁回答，「哪个 runtime 在通信」由 `runtimeIdentity` 回答。早期 socket 握手用的 bridge token 已随握手一起移除，`tokens` 表在升级时被删除。

保留策略按数据语义分开，不按时间或进程存活回收：`children` 与 `delegations` 是账本，runtime 消失、child 结束、parent 重启都不删除它们——`agents_delegate({ id })` 要用同一 session 接续，`agents_get({ revision })` 要能读历史委派；它们只按 `parentSessionId` 归属，不设 TTL。`commands` 里只有进度事件是有界快照（见 §5），控制请求与报告保留到其等待者读到结果为止。删除整个 parent session 的账本目前没有自动入口：那是用户的显式动作，不做猜测式清理。

所有跨进程读取先做 runtime validation。损坏、版本不支持或身份不匹配时明确失败，不返回部分伪状态。

`presentation` 不做兼容读取：旧版本记录写的 `mode: "rpc" | "tui"` 的字段含义已不同（它描述进程由谁持有），因此解析直接失败并在错误里给出文件路径与「删除该记录」的指引，由用户手动清理，而不是猜测迁移。

启动失败同样不丢弃证据：panel 已经打开但 child 没连上时，先尝试关掉它，只有 host 明确确认「panel 已不在」才算干净（清 runtime 证据、交回空句柄）；否则把句柄交回 manager 并保留 runtime 证据——句柄阻止第二个 runtime，证据让稍后真的连上来的 child 能被 adopt，而不是变成没人拥有的进程。后台 child 的 SIGTERM 未能结束进程时同理。

### 4.2 首次 session 落盘

- 启动 runtime 前先保存原始 session ID、目标路径和 initial task。
- session 从未落盘且旧 writer 已确认死亡时，用原 session ID 显式创建，不对不存在路径调用会生成随机 ID 的 open 路径。
- session 已落盘时核对文件和 session ID；丢失、损坏或 ID 不符不得当作首次创建。
- bridge 就绪前不投递 initial task；投递失败时 child 记 failed 并把该输入记为未确认，不静默重发。
- RPC response 不等于 durability acknowledgement；断线时的输入标记 interrupted/待确认，不自动重发。
- child session 写在 parent 默认 session 目录下的 `agents/` 子目录里，并作为显式 `--session-dir` 传给 child：Pi 用非递归 `readdir` 枚举会话，所以 delegated session 不再出现在人的 session 列表里，而 registry 记录的显式目录/路径仍让 recovery 找得到文件。
- child branch 在首次 bind 的 session 上写入 title `🤖 <title>`；`title` 省略或纯空白时用 `🤖 <agent> · <subagentId>`（agent 名为空则只用 id）。该 marker 让 delegated session 被特意打开时一眼可辨。

### 4.3 单 runtime 规则

同一个 parent session 同时只有一个受管理 runtime，由三件事共同保证：

1. 进程锁：每个 child 在自己的 `locks/<parentSessionId>/<childId>.lock` 上持有 `BEGIN EXCLUSIVE` 的 SQLite 内核锁；进程死亡（含 SIGKILL）时内核释放它，因此"锁还在"就是"写者还在"。父端探测只读不持锁；
2. registry 记录：child 的 `runtimeIdentity` 是事件与报告的身份依据，身份不匹配的 frame 一律丢弃；
3. 不叠第二个写者：本进程的进程句柄还活着时，send 拒绝再起 runtime，先 stop 这个 child。锁还被持有时输入交给当前写者。锁已空、面板打开未确认、或重启后从未重连，都不是拒绝理由：后续 send 用同一 session 再起一个。

同一台机器上两个 parent session 共享同一个 `state.sqlite`：`children`、`commands`、`delegations` 的每行都带 `parent_session_id`，因此后写的一方不会抹掉对方的记录。

不存在 claim 交接体系：没有 runner 进程可交接，也不做 PID/`/proc` 死亡探测。

## 5. Runtime 与协议合同

### 5.1 Bridge 控制面

parent 与每个 child 通过 `state.sqlite` 的 `commands` 表交换消息，每个 child 以自己的进程锁声明存活。父端每 50ms 轮询一次待取命令（空队列只做一次读，不取写锁），一条命令承载一个方向：

parent → child 请求：`prompt`、`steer`、`follow_up`、`get_state`、`session_facts`、`get_entries`、`abort`、`shutdown`。回合投影和自动回报走 `session_facts`（usage、最后一条 assistant 文本、某句输入是否已落会话），不传整段 transcript。`get_entries` 只给显式查看。mailbox 里的 command 在接收方取走后删除。
child → parent 请求：`contact_parent`、`task_result`（需要 parent 确认，例如重复的 task result 会被拒绝）。
child → parent 事件：允许转发的 Pi 事件（`FORWARDED_PI_EVENT_TYPES`）、`child_lifecycle`（`left_session | tui_quit | user_interrupt`）、`child_input`（只带来源，不带文本）。

- 每个命令都验证 parentSessionId、subagentId，并核对 registry 中该 child 记录的 runtime 是否就是这个 runtimeIdentity：命令上的 id 说明「哪个 runtime 在通信」，registry 说明「该 runtime 属于哪个 child」，两者缺一不可（否则一个 child 可以冒用另一个 child 的 id 顶掉它的控制通道）。child 只有在持有进程锁时才被视为在线，同一 child 永远只有一个写者；
- request/response 由命令行关联：父端写入 `to_child` 命令后按命令 id 轮询结果，child 取走命令时在同一写事务里标记 claim，处理完写回 result 或 error。重发沿用同一个命令 id，因此「重发」不等于「第二条报告」：父端会重放第一次的结果而不重复执行副作用。去重按 **child + runtimeIdentity + 命令 id** 生效（child 换 runtime 后 id 重新计数，只按 child 去重会把新 runtime 的第一份报告答成上一个 runtime 的结果），覆盖重连而不覆盖 parent 重启；命令 id 是 UUID，跨进程也不会撞号；
- 同一命令 id 的重复 claim 共享同一个结果：后来者读到同一份答案，而不是被判为重复请求——把重发判错会丢掉一份 parent 已经执行过的报告；
- 两个方向都有界等待：parent 请求 child 有 30 秒 request timeout，child 交给 parent 的 report 也有同样上限——父端不回答时 report 可见失败，而不是永久 pending；
- 等待由 deadline 决定，不由行是否存在决定：命令被别的写者删掉、transport 关闭或账本读失败都立即结束等待，不会留下永久 pending；
- child 排队的事件有上限（`DEFAULT_MAX_BUFFERED_EVENTS`）：父端不再读取时保留最新的事件快照、丢弃更旧的进度帧，控制请求与报告不受此限；
- 接管 mailbox 的 parent 会删掉上一进程留下的终态命令行（`done`/`failed`），它们的等待者已经随进程消失；
- 没有按条数限制的命令队列，也没有重放缓冲：每一条排队的行都有一个负责删除它的等待者——取走、deadline 到期、signal 取消，或下一次接管时清掉终态行。只有没人读的事件流需要条数上限；
- timeout、锁消失、无法解析的 payload 会结束相关请求，不留下 pending promise；parent 关闭时未取走的 `to_parent` 命令由下一次 `open` 重新排队；
- child 的 report 是单条命令加一次有界等待：parent 不可达时它在 deadline 或取消时可见地失败，不排队重放、不静默丢弃。Pi 事件是 advisory，断线即丢；无法序列化的 advisory frame 被丢弃并诊断，不因此断开控制通道——一条坏掉的事件不该让 child 失去 parent；
- report 携带调用方（tool call）的 AbortSignal：被取消的 tool call 不会再等 parent 回来，report 会从队列里退出并可见地失败，而不是永久 pending；

- parent 可以把某个 child 从"在线"集合中移除（`disconnect(childId)`），用于「这个进程已经不是这个 child」的情况；
- busy/idle 由 child 自己的 `get_state`（`ctx.isIdle()`/`hasPendingMessages()`）回答，parent 不推断。
- child 在 `session_start` 才打开 mailbox 并持有进程锁，因此"锁存在"即"该 child 会话已就绪"：parent 的第一条请求不会落在一个还没拿到会话的进程上，adopt 时的 `session_facts`/`get_state` 也一定有意义。
- child 侧 `session_shutdown` 在 `quit` 与 `reload` 都关闭 mailbox 并释放进程锁（reload 后由新实例重新加锁）：否则 reload 出的第二个写者会和旧的争同一个 child。session 绑定不变。
- adopt 时 child 自己的 `get_state` 是「此刻是否在忙」的权威答案，并同步进 state projector：transcript 以 tool result 结尾只是说明上一轮结束，如果不回写，随后任何一个不带状态的 Pi 事件都会把这份记录改回 `running`。

ParentChannel 复用这条连接，不建立第二套 message bus，也不依赖 terminal scraping 或 session JSONL polling。

### 5.2 State 与 presentation

公开 state：

```ts
type SubagentState = "starting" | "running" | "idle" | "done" | "stopped" | "failed";
type Presentation = "panel" | "background";
```

`done` 表示 runtime 已回收、session 与身份仍在（可被 send 用同一 session 拉起）。

启动时的 recovery 不能让 extension 挂掉：registry 读不出来（例如旧版本写的记录）时，把错误作为一条
`pi-subagent-recovery-failure` 消息报给用户，并提示删除该 registry 记录或整个文件以重置该 parent session
的 subagent 状态，其余功能照常加载。
Handoff/recovery 的细节属于内部 transition，不扩展 public enum。interrupted 是 status/summary diagnostic，不是额外 state。

`presentation` 描述 child 的进程形态：`background` 是无终端的 headless Pi（`--mode rpc`，stdin 由 parent 持有），`panel` 是 host panel 里的 native Pi TUI。它是 spawn 时冻结的事实，不是可切换的显示选项：改变呈现等于换一个 runtime，而 identity 与 session 不变。

### 5.3 Transition serialization

同一 child 的 spawn/send/stop/recover/adopt/事件投影由 SubagentManager 的 per-child rejection-safe chain 串行化。成功或失败都释放 queue。所有 late frame 必须按当前 runtime identity 核对后才能修改状态；stop 只等待运行中的 transition，不排在它后面造成死锁。

## 6. 生命周期合同

### 6.1 Spawn

1. 校验输入、agent definition、model 和最终 resources。
2. 创建 child ID/session ID，先持久化启动意图和 initial task，并按有无 host 冻结本次呈现。
3. 后台：parent spawn headless child Pi 并由 stdin 持有；panel：parent 铸造 runtime identity、构造 LaunchSpec，交给 HostAdapter 打开 panel 并运行该 argv。
4. child branch 在 `session_start` 打开 `state.sqlite` 的 mailbox 并持有自己的进程锁，父端据此确认身份。
5. 只有 child 持有进程锁、收到并接受 prompt 后才报告 running；内部失败记录保留已完成副作用和可确认状态，工具只返回原因。

### 6.2 Send

- running child：`steer`（缺省）在当前回合的工具调用结束后、下一次模型请求前插入；`follow_up` 等整个 run 没有工具调用和 steering 后再作为新回合继续。
- idle child：`steer` 没有可插入的回合，直接开新 run；`follow_up` 同样开新 run。不按屏幕状态猜测意图。
- 没有可用 runtime 时先按冻结的 presentation 拉起同一 session（panel 会开一个新 panel），失败同理返回可见错误。
- 写者消失（锁已空，或本进程看见后台进程退出）不是终止：runtime 从账本拿掉；当时在跑则记 `blocked` 并回报一次，intent 保持 active。后续 `agents_delegate` 用同一 session 再起 runtime。宿主已确认 panel 进程不在时关掉空标签。标签还在不拒绝 send。
- `agents_stop` 才是终止：先写 stopped intent，再关 panel 或结束进程。
- 系统 idle 自动回收落 `done`，后续 send 可以恢复同一个 session；不得把自动回收后排队到达的断线事件当成人工终止。
- 本进程的进程句柄还活着时，send 拒绝再起 runtime（`safeToRetry=false`）。调用方先 `agents_stop` 这个 child，再对同一个 id 发送，不要另 spawn。面板打开未确认、或看不到锁文件，都不是拒绝理由。未知的宿主列表仍然不得当成死亡。attachment 身份按 §6.7 持久化。
- Task child 不接受后续输入，拒绝也标记为不可直接重试。
- 已接受但未确认持久化的输入被记录为待确认，断线后不静默重放。

### 6.3 Idle 回收

- 收到最终 `agent_settled`（不是 `agent_end`）且没有待处理输入后 child 落 `idle`；`SUBAGENT_IDLE_TIMEOUT_MS`（15s）到期即回收 runtime（先经 bridge 请求 `shutdown`，再结束进程），state 落 `done`，identity 与 session 保留。
- 回收只针对 `idle` 的 child：running 的 child 永远不会被自动结束，只有 `agents_stop`（或人自己关掉 panel）结束正在工作的 child。
- Task child 不参与 idle 回收：它的 parent 在收下结果后立刻清理 runtime。
- 回收时关不掉或观察不到：不改记录，句柄留着。标签是调用方的。进程句柄仍活着时 send 仍拒绝再起 runtime。
- panel child 的倒计时受聚焦影响：到期时先 `observe()`，panel 仍然聚焦（或聚焦不可判定）就重新计时，只有明确「没人在看」才关闭 panel。观察不清楚时不关闭——panel 只在有判断依据时被关掉。
- 在检查期间到达的任何 child 信号都会让这一次回收作废并重新计时：这些事件排在回收任务之后处理，只有「入站信号计数」能拦住一个已经在飞行中的判断，否则一个刚开始使用 panel 的人会失去它。
- 人手动输入（`child_input` 且 `source=interactive`）取消倒计时；parent 自己经 bridge 发的消息（`source=rpc`）不算人的存在。turn 结束后若没有待处理输入会重新计时。
- 宿主无法报告聚焦时（今天的 cmux）不倒计时：这类 child 只由 `agents_stop` 关闭，`HostAttachment.reportsFocus` 让 manager 不必猜。
- 本进程不持有 runtime 的 child（例如 parent 重启后 adopt 的 panel child）不倒计时：既无法确认退出，也无法判断聚焦，因此不做回收。

### 6.4 Session switch

TUI child 内 `/new`、`/resume` 或 `/fork` 进入不同 session B 后，child branch 以 `left_session` 上报：

- 该进程不再是这个 child 的 runtime：清 projector、清 idle 计时，状态落 `idle` 并记 interrupted，并从记录中删除 runtime 证据，因此它既不会在重连时被 adopt，也不会被当成 A 的 runtime；
- B 留在原生 TUI，不自动成为 subagent：本进程不再观察、也不再关闭它的 panel（panel 属于 B），后续 stop 不会影响 B，child 侧的 bridge 也会拒绝父端对这条连接的控制请求（`inactive_session`）；
- parent 同时把这个 child 移出在线集合，child 侧则在离开后**永久关闭自己的 mailbox 并释放进程锁**（不再重连）：即使 parent 当时没收到 `left_session` 或自己重启过，它也不会 adopt 这个进程、更不会去关人正在用的 panel；
- 后续 send A 会按冻结的 presentation 拉起一个新 runtime，而不是把输入打进 B；输入能否投递取决于 bridge 连接，而不是「进程还活着」。

`/resume` 当前同一 session 与 `/reload` 不算 leave。

### 6.5 Stop

先在 registry 保存 stopped 意图（`intent=stopped`、`state=stopped`），再经 bridge 请求 `shutdown`，随后按 presentation 收尾：后台 child 结束自己 spawn 的进程（SIGTERM，必要时 SIGKILL）；panel child 关闭该 panel，并再次 `observe()` 确认它真的不在了。确认不成立时返回可见失败并保留 runtime 证据（「关闭命令成功」不算证据，「panel 已消失」才算）。两者都完成后删除 runtime 记录。

对 adopt 来的 child（本进程既不持有进程也不持有 panel），stop 只能请求 `shutdown` 并等待 bridge 断开（有上限）；等不到就明确报告「需要人手动关闭它的 panel」，不谎报已停止。

进程锁还被持有时，连接看起来断了也不结束这个 child，也不自动关 panel。锁已经空了才按写者消失入账。panel 标签可以留着；只有宿主确认进程已退出时才丢掉句柄并关掉空标签。调用方要收掉留下的标签，自己 `agents_stop`。

非显然不变式：headless child 跑在 Pi 的 rpc mode 下，`ctx.shutdown()` 只置一个 flag，而 rpc mode 只在处理完一条命令或 `agent_settled` 之后检查它，因此对 idle child 的 `shutdown` 请求不会让进程退出，它只是"这一轮结束后请退出"的礼貌请求。真正的优雅退出是 **SIGTERM**：rpc mode 注册了 SIGTERM handler，会走完整的 dispose（发出 `session_shutdown`、flush 会话、清理 runtime）并以 143（128+15）退出，所以退出码 143 是预期的优雅退出，不是失败；进程是否结束只看存活，不看退出码。进程退出无法确认时返回可见失败并保留证据。exit callback 看到 stopped 后不得触发自动恢复。Stop 幂等；stopped child 永不自动恢复。

### 6.6 Parent reload/restart

Parent lifecycle cleanup（含 `/reload`）只释放本地 mailbox transport、订阅、计时器和 UI，不终止仍活的 child 进程：后台 child 由 stdin 管道持有，只随 parent 进程结束；panel child 由 host 持有。
新 parent branch 打开同一 `state.sqlite`；仍持有进程锁的 child 会被重新识别并 adopt（读 entries 与 get_state，不新建 runtime）。
parent fork/new session 不继承旧 parent 的控制权。

§6.6 的「reload 后没有 HostAttachment」由 §6.7 取代：attachment 写入租约，重新打开会话时用宿主列表重建句柄。在 SUB-12～SUB-14 落地前，源码仍是旧行为。


### 6.7 会话租约

子 agent 状态属于父会话，不属于某一次进程，也不属于模型的一项技能。模块 `ConversationLease` 把 §6 的生命周期收在一个小接口后面。extension 的 `session_start`、`before_agent_start`、spawn/stop 和 child lifecycle 只走这个接口；测试也只走这个接口。Herdr CLI、5 秒 adopt 窗口、内存里的 unresolved 集合和 stdin 句柄都不出现在接口上。

```text
open(boundary)   session_start。boundary = startup | resume | reload | fork | new
ready()          before_agent_start 等待本次 open 结束。未完成不得开始这一轮
commit(edge)     只写 intent、runtime，或把它拿掉。第一次写入有效
roster()         这个父会话的 child 账本
```

`cancel` 不是 boundary，也不是 edge：父回合或子回合被中断都不改租约。进程被 kill 没有回调；下次 `open(resume)` 读的是上次 `commit`。

租约落在 `state.sqlite` 的 child 行：`childId`、`sessionPath`、`presentation`、`intent: active | stopped`、runtime（identity、endpoint、attachment）和 state。usage、activeTool、summary、working 只留在内存。写者是否还在只看进程锁。

写盘只发生在 `commit`：

| edge | 何时 | 写什么 |
| --- | --- | --- |
| `spawn-intent` | 进程启动之前 | `intent=active`，还没有 runtime |
| `runtime-bound` | 启动证据先落账 | runtimeIdentity 与 endpoint，替换旧 runtime |
| `attachment-bound` | 宿主或 pid 交回句柄 | attachment，一次 |
| `stop-intent` | kill 或关 panel 之前 | `intent=stopped` |
| `runtime-gone` | 写者没了，或启动确认没连上 | 清 runtime。`drop` 把 running 记成 blocked；`finished` 记 done；`clear` 只删除 |
| `left-session` | 子进程进入另一个 session | 清 runtime。不关 panel |

重新绑定且句柄没变：零次写。回灌出新 tab：每个新 attachment 一次写。

**父进程**

| 事件 | `open` / `commit` |
| --- | --- |
| kill / quit | 无调用。panel 是否还在，看下次对账时 Herdr 是否还在。background 随父进程结束。 |
| resume / startup | `open(resume)` 或 `open(startup)`。tab 或 pid 还在就绑回，不新开。 |
| reload | `open(reload)`。不杀 child。用租约里的 tab、surface 或 pid 重新包成句柄。bridge 自己重拨。 |
| cancel | 不调用。下一轮 `ready()` 看到同一份账本。 |
| fork / new | `open(fork)` 或 `open(new)` 的账本是空的。旧 child 留在旧 session id。不复制 attachment。 |

**子进程**

| 事件 | 结果 |
| --- | --- |
| reload | 绑定不变。旧 client 停止拨号，新 client 重拨。不 `commit`。 |
| resume 同一 session | 不算离开。 |
| resume 到别的 session，或 fork / new | `commit(left-session)`。panel 留给那个人。 |
| cancel | 不 `commit`。runtime 仍是它。 |
| 人关掉这一个 panel，或这个进程自己死了，宿主还活着 | `commit(stop-intent)` 然后确认后 `commit(runtime-gone)`。不自动复活。 |
| 人用原生 `/resume` 打开该 child session | 账本保持未知，不回灌，不起第二个 writer。 |

**重开 Herdr，再打开这个父会话**

`open` 向宿主要一次列表，`ready()` 在列表有结果之前不返回。

| 列表 | 动作 |
| --- | --- |
| 未知（超时、命令失败、Herdr 尚未就绪） | 继续等。绝不新开进程。 |
| 租约里的 tab 还在 | 绑回原 tab。 |
| 宿主是新一代，当时 `intent=run` 且仍有 attachment 的 tab 全部不在 | `ready()` 返回前，用同一个 session 把这些 panel 拉回。这是回灌，不是工具调用。已 idle 回收或 `intent=stop` 的只留在 `roster()`，不开 panel。 |
| 宿主还活着，只有其中一个 tab 不在 | 只终止那一个。其余绑回。 |

background 不参加回灌：它活不过父进程，resume 时 pid 已死就 `runtime-gone`。同一进程里的 reload 如果 pid 仍在，只重绑，不开第二个；stdin 写端属于进程，不随 `session_shutdown` 关掉。

seam 只有一个：`HostDirectory`。生产 adapter 包现有的 Herdr/cmux 列表和开 panel；测试 adapter 在内存里。租约模块拥有上面的矩阵。删掉它之后，extension、child bridge 和工具会各自再解释一遍 reload 和 Herdr。

## 7. Host 与 UI 合同

HostAdapter 只负责 capability probe、开 panel（Herdr 新 tab / cmux 新 surface）、观察 panel（含聚焦状态）与 cleanup，返回可观察 attachment。

- herdr：`tab create`（`--cwd`、`--no-focus`、`--label <subagentId>`、`--env`）后用 `pane run <root pane> <LaunchSpec argv>` 运行 child，cleanup 关闭该 tab；聚焦 = 该 tab 的 `focused` 且其 workspace 的 `focused`。
- panel child 的 LaunchSpec 带 `--approve`，因为 parent 已明确选择并提供了项目级 agent、extension 与 skill 配置；native Pi TUI 启动不得停在项目文件信任提示上。
- cmux：`new-surface --command`；聚焦状态无文档化查询，因此 fail open（不自动回收），代码内以 `TODO(cmux-focus)` 标注。
- 关闭 panel 只证明 attachment 消失，不证明进程已死；进程证据以进程锁消失（+ 后台 child 的进程句柄）为准。
- 开 panel 不是原子操作：host 可能已经建好 panel 并跑起进程，只是没能把结果报回来。此时 launch 明确报「未确认」，**保留** runtime 证据（child 真起来了还能被 adopt），并且不因此允许第二个 runtime。
- `observe().alive` 回答的是「这个 child 的进程是否还在该 panel 里运行」，不是「panel 是否存在」：host 关闭命令失败但 child 已死时 stop 仍算完成，残留的空 tab 由人处理。判断「已关闭」必须 `known === true`：观察超时或查询失败都算未知，未知既不算已关闭，也不触发回收。
- 不做隐藏 panel、send-keys、readScreen、屏幕抓取。

- attachment 暴露 `reportsFocus`：宿主能报告聚焦时 manager 才为它安排 idle 回收，能力缺失时明确退化为「只由 stop 关」。

默认顺序为 herdr 后 cmux，用户明确指定时按指定选择；选择和 fallback 原因必须可见，不能静默改变执行 provider：选择结果写在启动诊断里，而每次 spawn 的结果都带上 `presentation` 与 fallback 说明。

parent 只在 spawn 时选 host：它持有 panel 的 attachment（身份、观察、清理），但绝不解析终端输出、不镜像 transcript、不替 child 构造第二份 argv。

V1 UI保持最小：

- tools完整显示结果并可引用collapsed output；
- `ctx.ui.select`提供child/agent选择；
- `setStatus`显示紧凑状态；
- 不注册全局快捷键，避免与 Pi host 或其他 extension 争用按键；停止操作使用 `/subagents stop [id]` 或 `agents_stop`；attach 及其快捷键已随 §2.2 一并删除；
- parent 用原生 `setStatus("pi-subagents", text)` 投影 `SubagentManager.list()` 中正在运行的 child，仅显示一个 running glyph 和编号，例如 `󰪠#3f9a1c #0beef1 #a1b2c3`。`pi-status` 将其放在第二行右侧、TODO 前；两段以 ` ‧ ` 分隔，缺席段不留分隔符。无额外 Widget、elapsed 计时器或终态保留窗口；过期异步投影不得覆盖最新状态，生命周期结束清除状态并取消订阅。
- 已确认的 done/error/blocked 报告用一次性 `subagent-info` custom entry 展示，默认只显示结果状态和身份，展开查看完整报告；支持 resume 和 Headless `entry_appended`，不进入模型上下文。模型仍接收原有 `subagent-report`，其重复的可见展示隐藏；保留沉降、重试取消和报告去重。
- TUI child 不挂身份 widget；身份由 session title（`🤖 <agent> · <id>`）与 child branch 自己的原生 TUI 表达。

Native child交互始终使用真实Pi TUI；不实现transcript viewer、RPC event mirror或terminal scraping。

## 8. Usage、summary与结果

Usage从Pi已完成assistant turns/session stats重建并按child累计：input、output、cache read/write、cost和turns。重连不得重复累计，缺失provider数字明确按不可用处理而非猜测。

Latest summary取当前branch最后有效assistant内容，并区分：正常完成、仍在运行、interrupted、failed和stopped。panel与后台 child 使用同一口径。完整结果不得因UI折叠丢失。

## 9. 失败、取消与并发语义

所有工具、transition和后台恢复遵循同一合同：

- 已知失败、未知异常、protocol mismatch及无法确认的ownership/liveness通过Pi原生tool error或等价可见通知返回；
- 内部错误保留 child、操作、原因、已完成副作用、当前可确认状态和安全重试条件；模型工具只返回原因，运行状态通过 get 显式查询；
- ready、exit、重连识别、panel cleanup 均有有限 deadline 并响应 AbortSignal；
- deadline后释放本地等待和transition queue；后台迟到结果仍做identity校验；
- fail closed表示拒绝当前危险操作并返回，不表示无限等待；
- model可查询状态或选择其他完成方法，但不得绕过 ownership、单 runtime 规则或消息去重；
- 用户主动中断正在执行的child时，通知parent“任务未完成，等待用户意图”；没有明确继续指令不得自动恢复；
- 不同children可并行，同一child的mutation串行；不引入global scheduler。
