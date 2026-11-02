# pi-subagents

`@hheei/pi-subagents` is the concrete extension for independent, reconnectable Pi
child sessions. Live contract: [`docs/pi-subagents/spec.md`](../pi-subagents/spec.md).
Design sources, archived under [`docs/archive/pi-subagents/`](../archive/pi-subagents/): `PLAN.md`,
`PLAN-delivery-presentation.md`, and `PLAN-panel-bridge.md`.

Ownership:

- Parent branch: agent policy, the sqlite ledger, SubagentManager, model-facing tools, UX.
- Child branch: command dispatch, lifecycle reporting, `contact_parent`. Not a manager, and it never closes its own panel.
- HostAdapter: Herdr tab / cmux surface open/observe/cleanup (including the `focused` answer and the
  `reportsFocus` capability). Not identity, and never a second Pi argv builder: the parent builds the
  LaunchSpec, the host only runs it and reports what it observes.

Host attachment is decided by a fact, not by the environment. A pane is this process's pane only when
the kernel says so: `herdr pane process-info` lists the pane's foreground processes, and the pane
matches when one of them is this process or one of its ancestors. Ancestry is included because a
wrapper (`pnpm exec`, a supervisor) runs this process as a child while the pane's foreground job is
still the Pi above it. The pane's own shell is excluded: it is the idle fallback, so counting it would
let `pi &` or anything else started from that terminal claim the pane. `HERDR_ENV`, `HERDR_PANE_ID`
and `HERDR_WORKSPACE_ID` are inherited and outlive the pane that set them, so they only order the
candidates; a pane still has to prove it runs this process. `herdr pane current --current` answers
which pane a human is looking at and is therefore never used as identity. No match means no panel, and
the child runs in the background.

Both hosts report API rejections as JSON with exit code 0, so a host command is only successful when it
exited zero and returned no error body; the error code and message belong in the reason the caller sees.

ext-core no longer has an in-process subagent coordinator. This package owns child identity and lifecycle.

Control is one sqlite file (`state.sqlite`): child rows are the ledger, command rows are the mailbox.
Parent and child both open it. A dropped poll is not a dead child. Each child holds an exclusive lock
file while it is that child's writer; the kernel releases it on process death. The lock is the only
liveness fact — there is no presence row. Every read projects it: a record that still says `running`
while no writer holds its lock reads as `blocked`, so a death this process can see happen writes
nothing. The one exception is startup. A writer that was already gone cannot report itself, and a
projection is not a delivery, so `ready` settles those children once through the same lease edge an
exit takes: a panel child becomes `blocked` and is reported, a background child becomes `done` with the
parent-exit note. Reconcile otherwise repairs surfaces only — it rebinds a panel that is still there
and reopens the panels a new host generation took down. A background pid is a diagnostic, not
evidence, because pids are reused. Parent reload drops only local state (timers, projectors,
subscriptions); a surviving child keeps writing the same file, and a background child is held by its
stdin pipe, so it ends with the parent process.

There is no attach or detach: a child is presented where it was spawned and never switches
afterwards. `agents_delegate` prefers a panel (a new Herdr tab or cmux surface
running the child's own Pi TUI) targeting the workspace of the pane that runs this process, and falls back to a headless
background process when this parent has no host. Panel launches pass Pi's `--approve` flag so project-file
trust cannot interrupt startup. The presentation is frozen in the registry as `panel` | `background` (see
[`spec.md`](../pi-subagents/spec.md) §2.2).

A panel is an optimization and the child is not: when the panel cannot be opened and the caller did not
ask for one by name, the record moves to `background` before any runtime exists and the child runs
anyway, with the reason in the spawn result. Only an explicit `presentation: "panel"` request fails
instead of degrading, because there the panel is what was asked for.
Native `/resume` of the same session outside the managed path is not intercepted.

系统确认成功的 idle 回收保留可恢复身份：后续 `agents_delegate` 使用同一 session。本进程看见自己的后台进程退出时记 `blocked` 并回报一次，不改成 stopped intent；进程锁只是空了的情况不写盘，读时投影成 `blocked`（唯一例外是 parent 启动：写者已经消失、无法自己回报的 child 由 `ready` 一次性落库并回报）；后续 `agents_delegate` 用同一 session 再起 runtime，调用方不要为此另建 agent。宿主已确认 panel 进程不在时关掉空标签；标签还在则留着，要收掉由调用方 `agents_stop`。只有本进程的进程句柄还活着时，send 才拒绝再起一个 runtime，并要求先 stop 这个 child。锁还被持有时输入交给当前写者，不另起一个。
`agents_stop` 仍先写 stopped intent。runtime 的写入和删除只走会话租约的边（`runtime-bound` / `runtime-gone`），manager 不再直接改 runtime。panel 身份按 [`spec.md`](../pi-subagents/spec.md) §6.7 写进会话租约。reload 只重绑还在的 tab 或 pid。宿主换代时，`before_agent_start` 之前把当时仍挂着的 panel 拉回。

启动失败必须写回 registry 的 `error` 状态，工具结果保留 child ID、已发生的副作用和安全重试条件。
已确认退出的启动尝试删除 runtime 证据；仍可能存活的 runtime 保留证据，不允许直接重试。
新 runtime 的启动窗口为 20 秒，旧 runtime 的重连识别窗口为 5 秒；启动包含宿主命令和清理，
manager 的默认启动 deadline 为 60 秒。
使用 `pi-dev` 时，child 复用父启动器已经构建的扩展；构建归普通开发启动所有，child 的启动和恢复不触发构建，也不写构建缓存，避免把编译耗时误判为 bridge 连接失败。
自动汇报读取 transcript 后必须重新核对工作版本、入站活动和当前状态；过期汇报不能覆盖新 turn 或触发回收。
宿主确认进程退出不能说明是人工关闭，诊断不得将退出原因归到用户。

## 紧凑状态与交互报告

父会话通过原生 `setStatus("pi-subagents", text)` 发布机器人 emoji、运行 glyph 与正在运行的 child 编号；`agent-3f9a1c` 显示为 `#3f9a1c`，显示编号不改变真实工具 ID。`pi-status` 在 Footer 第二行右侧按 agent、TODO 顺序组合，以 ` ‧ ` 分隔。缺少 pi-status 时使用 Pi 原生状态展示，不需要修改 Pi host 或依赖具体扩展。

移除父会话的多行 Widget、elapsed 刷新和终态保留计时器。状态投影从 manager 读取，过期异步读取不能覆盖新快照；session 切换、reload 或 shutdown 移除状态并取消订阅。子会话自己的身份展示不受影响，完整管理仍通过 `/subagents`。

child 的最终回答是一个父会话要读的结果，因此和所有工具结果共用同一个上限（ext-core `truncateWithSpill`，默认 5000 tokens / 20KB）。超限时保留头尾并附上 `[Full output: …]` 路径，报告不因过长被拒绝。完整回答另存为纯文本，而不是指向 child 的 transcript：transcript 是 JSONL，要解析才能定位那一条消息，成本高于直接存一份。已经放得下的报告走同步路径，不为一次不会发生的落盘而 `await`，批次仍在同一 microtask 内发出。

已确认的报告由原有 ParentChannel 交付后追加一个 `subagent-info` 原生 custom entry：折叠时只显示 glyph、编号、agent 名称和 done/error/blocked 状态，展开时显示完整报告。entry 支持 resume 和 Headless `entry_appended`，不进入模型上下文。对应的模型消息 `subagent-report` 使用 `display: false`，避免可见报告重复；错误等待、自动重试取消和去重继续由 manager 拥有，跨 producer 的单次唤醒由 ext-core BackgroundDelivery 协调。加载时不重新生成历史终态 entry。交互渲染剥离终端控制序列与 C0/C1 字符（保留换行、将 tab 转为空格），持久化和模型仍保留完整原文。info 写入失败时使用原生 error 提示说明原因；已经提交的模型报告不重发。

## 子代理工具说明与动态启用

父会话通过 `tool_search` 按需加载 `agents_delegate`、`agents_get`、`agents_stop`、`agents_dashboard`；已有协作说明由动态启用逻辑提供。`agents_delegate` 的工具描述直接列出父会话启动时发现的可用 agent 名称和职责，沿用发现优先级并排除 disabled/hidden 定义；没有可用定义时明确显示空列表。工具描述明确说明完成结果自动返回，派发后可继续独立工作或结束当前回合，无需轮询。`agents_get` 与 `agents_stop` 同样说明自动返回结果。工具不通过 `promptSnippet` 或 `promptGuidelines` 注入额外内容。子会话仍独立提供 `contact_parent` 的阻塞报告指导。

`agents_get({ id, revision?, includeOutput? })` 缺省读取该 agent 最新的委派，`revision` 指向历史某次委派，`includeOutput` 为真时才返回结果正文并沿用同一输出上限。投影同时给出委派 `status` 与 `progress.runtimeState`，两者分开呈现，历史结果不会被新一轮覆盖；不跨族查询 Bash。`agents_delegate` 不接受调用方指定的 ID，已有 child 只能通过 `id` 接续。`agents_dashboard` 只给运行统计与最新委派摘要。工具族没有等待入口，完成结果自动返回。

工具声明 `exposure: "deferred"` 与 `defaultActive: false`；`before_agent_start` 用 ext-core `setOptionalToolBullet` 往结构化 system prompt 的 `optional_tools` 段落写入 key 为 `subagents` 的条目，段落自带 `tool_search` preamble。动态声明与 provider 的 prompt 重建仍由 Pi host 负责。

## 后台交付协调

`SubagentManager` 与 SQLite ledger 独占 child conversation、runtime lease、恢复和报告。子代理可独立安装，不等待 Bash 或通用任务服务，不向第二套任务状态机镜像状态。模型工具按 ownership 分族（契约见 [`background-tasks.md`](background-tasks.md)）。

- child conversation ID 可跨多轮执行复用，状态保留 `running`、`done`、`blocked`、`error` 等自身语义。
- 子代理报告与后台 Bash 结果只共享 ext-core BackgroundDelivery。parent 忙时以 `steer` 进入下一模型步骤；空闲时同一 microtask 批次只由最后一个有效通道请求新回合，不等待其他 child 或 Bash。
- `blocked` 报告仍立即请求交付，交付协调不管理紧急原因或报告内容。
- 自动交付保留已确认的终态：失败为 `error`，可继续的中断或阻塞为 `blocked`，成功为 `done`；不能把失败统一改写为阻塞。重试成功的最终 assistant 消息清除旧错误，交付前在 child mutation 锁内读取最新状态。
- 自动报告按批次发出：没有其他 child 正在工作时 500ms 内发出，有 child 仍在工作时最多等 10 秒把同批报告合并。批次延迟对 success、blocked 与 error 相同，只发送本次结果，不拼接历史回答。等待期间用户继续输入、parent 发送新消息或自动重试会取消旧报告；自动重试期间不报告暂时错误。
- `agents_delegate` 用 `id` 接续时接受已有 child 的各种状态，包括 `error` 和已停止的 child。写者还在就把输入交给它；写者已经没了就用同一 session 再起 runtime，调用方不要另建 agent。显式接续会重新激活 stopped intent。只有本进程的进程句柄还活着时才拒绝再起 runtime，并要求先 `agents_stop` 这个 child。失败不保证上游错误会恢复。
- 接续始终是 `steer`：当前 assistant turn 的工具调用执行完后、下一次模型请求前插入，用来改变正在进行的工作；child 已空闲时没有可插入的回合，直接开新 run。模型不再选择 mode，协议层的 `follow_up` 队列能力不对外暴露。
  - 不存在 "auto"：Pi 的 steering 队列本来就是这种情形，按 child 状态猜只会替调用方做它没做的决定。
  - 已结束 runtime 的 child 会被 resume，resume 本身就是开新 run，此时接续消息作为该 run 的 prompt 送达。
- 内置定义（`scout`/`worker`/`reviewer`）是最后发现层，不写入用户 home，也不会被自动派发。其中 `scout` 默认禁用（需用户显式配置模型），`worker` 与 `reviewer` 继承父模型。
- `skills` 是白名单：`all`（缺省）/ `none` / 名单；名单条目可以是 skill 名字，按 parent 已加载的 skill 列表解析成绝对路径，未知名字只 warning 并丢弃。
