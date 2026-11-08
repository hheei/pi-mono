# Pi 插件与 MCP 统一 Agents API Spec

状态：AGENTS-01～07 已实现；AGENTS-08（真实 Codex Desktop 验收）未完成，缺口见 [tickets](unified-api-tickets.md)。本文是统一 API 的行为与验收依据，架构依据见 [plan](unified-api-plan.md)，审查结论见 [review](unified-api-review.md)，当前 MCP 实现见 [mcp.md](mcp.md)。

## 1. 目标与范围

Pi 插件和 MCP 共用 delegate/get/stop/dashboard 的输入、身份与结果语义。建立与继续任务统一为 delegate，减少模型在 spawn/send 之间选择。公共输入移除 title 和 mode；继续已有 agent 仅使用 steer。

不新增执行引擎、全局任务服务、跨 extension API 或可配置交付策略。内部会话标题继续由现有自动规则生成，历史标题不删除。底层 Pi 平台的 follow_up 不在公共工具契约内；实现时检查 package 内实际调用方，再删除无用分支。

## 2. 工具与命名

| 操作 | Pi 插件 | MCP 原始工具名 | 模型可见 |
| --- | --- | --- | --- |
| 建立或继续任务 | agents_delegate | delegate | 是 |
| 状态、进度、指定委派结果 | agents_get | get | 是 |
| 停止 runtime，保留 session | agents_stop | stop | 是 |
| 当前 agents 概览 | agents_dashboard | dashboard | 是 |
| 列表刷新 | 不新增模型工具 | list | 仅 App |
| 分页 session 历史 | 不新增模型工具 | transcript | 仅 App |
| agent 定义目录 | delegate 描述提供可用目录 | catalog | 仅 App |
| 分页委派历史 | 不新增模型工具 | receipts | 仅 App |

MCP server 自报名称和推荐 client 配置键均为 pi_agents。工具只注册 delegate/get/stop/dashboard 等原始名称；client 负责命名空间包装，最终可能显示 pi_agents_delegate 或 mcp__pi_agents__delegate，具体格式由 client 决定。

切换时移除旧 agent_spawn/agent_send/agent_get/agent_stop 和 subagents_* 模型工具，不增加别名。模型端 receipt 工具并入 get(id, revision)。App 的 receipts 仅用于分页历史，也使用 id + revision 标识记录。contact_parent 保持子 agent 专用桥接能力。

## 3. delegate 输入与行为

| 参数 | 规则 |
| --- | --- |
| task: string | 必填，不能是空白文本；沿用任务清洗与边界验证 |
| id?: string | 省略、空字符串或纯空白表示新建；非空值复用已有 agent session |
| agent?: string | 新建时必填，接续时不需要；不新增默认 agent 选择规则 |
| cwd?: string | 新建时指定目录，缺省继承父端工作目录 |
| wait?: boolean | 两端默认 true；false 受理后立即返回 |

不接受 title 或 mode，未知参数报错。提供非空 id 时沿用现有 id 优先规则，忽略创建参数 agent/cwd，不改变已有 agent 的定义或工作目录。

运行中注入 steer；idle/blocked/done/error 且允许恢复时，在同一 session 启动下一轮。stop 后也可再次 delegate。新建应省略 id 或传入 ""，由系统分配 ID，不猜测 ID。未知非空 id 返回错误，不退化为新建。不提供 follow_up 或模拟排队模式。

wait:true 等待该 revision 完成、阻塞、失败或进入不确定状态。等待期间不持有 per-agent mutation queue，保证 settlement、stop 和后续 steer 可以进入。

调用例子：

- 新建：{agent: "scout", task: "检查 README", wait: false}。
- 接续：{id: "agent-3", task: "也检查 package.json", wait: false}。

第二次输入是 steer，可能与当前工作共同产生一个最终答案，不承诺两次输入独立执行或分别生成回答。

## 4. 身份：id + revision

id 标识可复用 agent session；revision 是该 agent 下单调递增的委派序号。公共结果只用 id，不再同时出现 childId/agentId；不再暴露随机 delegationId。

结果示例：{id: "agent-3", revision: 2, status: "running", hasOutput: false}。

(id, revision) 由现有 parent/workspace ownership 隔离，不是跨 workspace 的全局地址。

- 每次 delegate 分配独立 revision；分配和 receipt 预留在现有 SQLite 事务内完成，设置唯一约束，重启后不重置序号。
- revision 可有空缺，不复用已分配序号。派发失败或不确定也保留可核对记录，避免重试覆盖副作用证据。
- 新建时持久分配 agent identity 和首个 revision 先于启动子进程；启动失败返回已知身份与失败记录。
- revision 与 manager 的 workVersion/runBoundary 分开。多次 steer 可映射到同一工作轮次，该轮答案可同时结算多个 revision；不能假装它们有独立产出。
- 自动推送按实际 settlement 去重，不能为每个 revision 重复推送同一答案。复用现有 runBoundary 关联，不为此新增事件服务。
- /compact 是控制操作，不会触发 agent_start，不能通过“预订下一 workVersion”绑定。manager 在派发前把 revision 绑定到该次 compact 操作；复用现有 mailbox command identity，并由 child 控制完成/失败报告回传关联，不能收到报告后读取最新可变 workVersion 来猜归属。重复 compact 若加入当前同一操作，其多个 revision 共用该操作结算；下一次 compact 使用独立关联。普通 steer 与 compact 的结算分开，后续工作启动不能让迟到的 compact 报告结算错误 revision。关联只在现有 child bridge 内使用，不增加公共 ID 或通用控制服务。
- 内部随机 receipt 主键可保留；公共 id + revision 映射必须唯一，无需为改名重写所有数据。
- 不实现旧数据迁移、revision 回填、双读或旧 API 兼容。新契约以新格式状态开始；仅保证新格式自身的重启恢复。
- 检测到不兼容的旧状态时，在派发前明确报错并给出状态路径。不要自动删库、清理历史、重编号或静默创建另一套 workspace ownership。部署切换时由用户显式选择新的状态环境；本设计不执行清理。

## 5. get 与结果投影

输入：id 必填；revision 可选正整数，缺省选最新委派；includeOutput 可选布尔值，默认 false。

成功的新格式受理结果必有 id、revision、status、hasOutput。按实际数据附带 task、agent、cwd、progress 和 error，不默认返回内部 session identity、数据库主键或完整 registry。新格式要求每个 agent 首次派发前已有委派记录，不为旧 agent 增加无 revision 的兼容结果。

- 指定 revision 时，status/task/resultText 属于该次委派。当前 runtime 活动单独放入 progress，不将新一轮活动冒充旧委派进度。
- 新任务运行时，不把上次完成结果当成本次结果。
- hasOutput 始终表示所选委派是否已有结果，与 includeOutput 无关。includeOutput:true 且已有结果时才返回 resultText；没有结果时 hasOutput:false，不读取旧结果填空。
- 空字符串也是存在的结果；hasOutput 按结果是否存在计算，不按字符串真值计算。空结果执行语义沿用现有结算规则。
- 不存在的 revision 明确报错，不退回最新结果。
- 委派 status 统一采用现有 reserved/dispatching/accepted/running/completed/blocked/failed/uncertain。runtime 状态放在 progress，不混用 done/error 与 completed/failed。
- transcript 继续独立分页读取，不默认塞入 get。

stop 输入只有 id；返回当前 agent 身份、最新 revision/委派状态和 progress.runtimeState。停止已完成 agent 不改写已完成委派结果；未结算委派改为 failed 并附停止原因。

dashboard 输入为空对象；返回 total/running/blocked/completed/failed 统计与 children 摘要列表，统计按 agent 当前 runtime 状态计算，条目同时明确最新委派 status。两端共享列表投影，不把当前 runtime 与历史委派状态混在同一字段。

受理前验证/解析失败返回明确错误，带可用的 id、safeToRetry、sideEffects，不伪造 revision。已持久受理后失败必须带 id + revision。error 描述失败原因；resultText 只承载真实 child 输出或 blocker 正文，不把 controller 错误堆栈伪装输出。

## 6. 交付与上下文去重

| 场景 | 模型收到的内容 | 交付责任 |
| --- | --- | --- |
| delegate(wait:true) 等到结算 | 身份、状态与一次完整 resultText | 原工具结果 |
| Pi delegate(wait:false) | 先返回身份与状态，结算后推送一次完整结果 | Pi BackgroundDelivery |
| MCP delegate(wait:false) | 先返回身份与状态，之后显式 get(includeOutput:true) | MCP 调用方 |
| 普通 get | 状态、进度、hasOutput | 查询，不展开正文 |
| dashboard | 统计与有界状态/活动摘要 | 不枚举完整输出 |
| MCP App 展开 Output | 所选 id + revision 的完整结果 | App 本地展示 |

wait:true 工具结果与 Pi 自动推送不能同时交付同一 settlement；多个 waiter 可分别取得其请求结果，但不增加自动推送次数。App 刷新不消费或标记模型已读，也不触发父端消息。

交付协调由 pi-subagents 的 settlement/receipt 与 ParentChannel 负责；ext-core BackgroundDelivery 只提供通道。get 不修改交付归属，不增加隐藏的“模型已读”状态或全局文本哈希。用户显式重读仍返回完整结果。

文本和结构化结果避免打印重复 JSON 或附加完整历史。MCP client 是否同时将 content 和 structuredContent 注入模型上下文由 client 决定，服务端不能保证所有 client 零重复。UI 专用额外数据使用 MCP Apps 支持的 metadata；必要身份、状态与显式请求的结果仍通过标准工具结果提供。

“完整结果”表示显式请求正文，不取消现有输出与 IPC 大小上限。Pi 与 MCP 的模型输出共用现有 truncateWithSpill 策略（5000 tokens / 20KB），超限保留头尾和完整文本文件路径。不要在 structuredContent 再附未经限制的同一正文绕过上限。App 也不得把超限全文塞入单帧 IPC；沿用有界结果及文件引用，全文读取另走已有文件读取能力，不增加新分页协议。

## 7. 等待、取消、并发与恢复

- 同 agent 的受理、revision 分配和状态修改串行；不同 agent 独立并发。
- 保留每个 agent 同时最多一个等待中的 delegate 限制。额外 wait:true 在派发前明确冲突，不能先 steer 再报冲突；wait:false 可继续 steer。
- waiter 等待指定 revision 关联的实际结算；后续 steer 可能改变同轮答案。独立任务需新建 agent。
- AbortSignal、超时或 client 断线只结束等待，不隐式 stop 已受理工作，不撤回已注入 steer。
- Pi 等待取消后，将尚未确认交付的结果交回自动推送路径；完成与取消竞争只能由一个分支取得交付归属。MCP 重连后通过 get 恢复。
- 等待占用与历史 receipt 的 delivery 字段分开：请求结束时在 finally 释放占用、监听器和 waiter；不能因旧记录仍为 pending 永久阻止后续 wait:true。扩展 dispose/session 切换取消本 session 的等待，按现有 ownership 处理尚未交付结果，不把消息发往新 session。重启时不存在的旧 waiter 不视为活跃占用。
- wait:true 在现有工具进度/展示通道尽早公开已受理身份。若 client 不保留进度，可用 dashboard 找到 agent 再 get，不依赖只在最终响应中出现的随机票据。
- 崩溃时不能跨外部响应保证 exactly-once；保留持久结果和不确定状态，允许显式重读，禁止盲目自动重派 task。
- stop 停止整个 runtime，所有未结算 revision 有限结束并记录失败原因；保留 session 和已完成结果，重复 stop 幂等。
- fork/new session 保持现有 ownership 隔离，不直接继承其他 parent 的 receipt 或交付标记。
- IPC 信号传播、连接/帧/并发上限、权限边界和幂等清理继续保留。

## 8. 实现边界与验收

共享契约、输入验证、revision/receipt、结算与结果投影归 pi-subagents。Pi 注册/渲染/后台交付与 MCP 注册/stdio/Apps 消费同一契约，不新增 package 或通用 adapter 框架。

实施顺序：持久 revision 与查询 → 共用 delegate 与交付协调 → App/描述/文档/client 配置。工具改名后需重连 MCP client 刷新 tools/list；本设计阶段不部署。

聚焦验收：

1. 两端同输入输出；title/mode 被拒绝；新建、复用、steer、stop 后继续均可运行。
2. 并发受理、共享轮次结算、wait 冲突、快速结算与取消竞争，不串 revision、不丢结果、不重复自动推送。
   /compact 另验证 idle、运行中、重复并发、连续两次、失败和 compact 期间 steer；每个已受理 revision 都能收到正确操作结算，或明确失败/取消，不能无限等待。
3. 默认 get/dashboard 不带完整输出；显式读取历史 revision，区分空结果与不存在记录。
4. 新格式初始化、旧格式改名留档后从空库开始、controller 重启、派发前后 crash、fork ownership、uncertain 恢复，不复用身份或重复执行。
5. MCP 原始工具名、App-only visibility、Apps 卡片绑定；Pi deferred tool discovery 与工具描述同步。

本轮只检查 Markdown 和 diff。实现后按仓库策略运行聚焦测试、package build、必要的根 typecheck 及真实 controller/CLI 集成验证。

实施任务、依赖与逐项验收见 [统一 Agents API Tickets](unified-api-tickets.md)。每项 ticket 引用本文对应条款，不另行定义行为。
