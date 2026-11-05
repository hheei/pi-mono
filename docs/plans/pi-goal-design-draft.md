# pi-goal：设计思想、生命周期与实现计划

状态：实施前的历史设计草案；保留原始研究与决策过程。现行设计见 `docs/architecture/pi-goal.md`（`feat/pi-goal` 分支）。

## 0. 已确认方向与设计边界

本轮用户明确：

- **不考虑 pi-todo**：用户已弃用它；不依赖、集成、迁移或复制其模型。
- **必要时允许 pi-subagents 与 pi-ask-user 导出能力**：按长期 ownership 选择 Interface，不以零跨包改动或最少文件为目标。允许讨论导出，不等于任意新公共契约已经获批。
- **Session 级目标**：目标跟随当前 Pi session branch，不建立项目目标池。
- **审查 child 绑定 Goal run**：暂停、替换、分支切换、关闭时请求停止该 run 创建的审查 child；用户另外创建的 agents 不受影响。

首期不做跨会话目标池、共享目标 writer、严格不可跳步的执行引擎、通用工作流框架、独立 dashboard 或第二套计费。

研究依据：上游 `tmonk/pi-goal-x` revision `b0fc15ebb658a1e9ea60ae65496717a780080f37`，本仓库研究起点 `9c9a60cd`，已安装 Pi host 1.5.0 的类型与实现。源码级研究不等于已经验证真实长程运行。

## 1. 设计思想：Goal 管承诺，不管每个动作

### 1.1 目标不是另一份待办，也不是第二个 agent

pi-goal 回答四个问题：

- 这次用户究竟授权完成什么？
- 什么证据足以结束？
- 现在还有没有自主继续的授权？
- 这次运行创建的资源，谁负责终止？

执行仍由父 agent 使用原有工具完成。复杂计划保留为普通计划文件；Goal 只引用必要位置、当前 checkpoint 与验收证据，不接管计划文件格式、步骤 CRUD 或任务百分比。研究型目标不必被强制拆成 checklist。

### 1.2 少防御，不等于少生命周期

删除重复调度、盲目重试、ready/wait 握手、强迫反复证明 blocker 等无实际收益的门禁。保留直接对应真实副作用的约束：用户授权、写入失败、取消、资源属主、迟到回调、审查结果归属。

**授权决定能不能做；取消决定不再做；证据决定能不能结束。** 三件事不能用同一个布尔值代替。

### 1.3 优先深 Module，而不是薄包装

- pi-goal 的价值是把目标、授权和停止语义集中起来；不能只有一层提示词包装。
- pi-subagents 的导出应隐藏派发、receipt、进程/panel、取消与恢复的复杂性，而不是把 Manager、registry 和 bridge 全部暴露给调用方。
- pi-ask-user 的导出应提供完整的结构化提问与取消语义，而不是让消费者分别装配 TUI、dialog、timeout、事件和参数校验。
- ext-core 只保留中性机制；具体 extension 的类型与策略不搬进 ext-core。

Interface 必须包含 ordering、错误、取消、持久化与依赖要求；不只是一组 TypeScript 方法。测试与实际消费者应跨同一个 seam。

### 1.4 自动化不扩大授权

objective、验收要求、审查模式与自主额度归用户所有。模型可以记录进展、提出修改建议、报告阻塞、提交完成；不能自行降低验收要求、关闭必需审查或增加额度。

Goal 启动不是 push/publish 等不可逆操作的通行证；现有权限与批准规则继续生效。不全局拦截普通 read/bash，也不以工具名判断研究是否算进展。

## 2. 用户目标与主数据流

```text
用户确认目标与执行范围
        │
        ▼
GoalDocument ──创建 RunScope──► 父 agent 使用正常工具工作
        ▲                          │
        │                          ├─ 正常停顿 → Pi 原生 boundary → 继续
        │                          ├─ 需要人类决定 → blocked / paused
        │                          └─ 提交完成证据
        │                                   │
        │                         [用户要求独立审查时]
        │                                   ▼
        │                         subagents OwnedScope
        │                                   │
        └────保存完成事实 ◄── 验证归属与结论 ──┘

暂停 / 替换 / tree / shutdown
        → 同步撤销 run 授权
        → 关闭提问、请求停止 owned child
        → 汇总清理结果；不等待它们来撤销授权
```

建议命令采用明确子命令 `/goal start|status|pause|resume|clear`，避免自由文本与子命令混淆。`start` 的目标输入可来自命令参数、用户正常输入或已有计划文件。不是每次都先打开问卷。具体 schema 与 UI 另行定案。

模型侧只需要读取、checkpoint、blocked、complete 四类操作。是否合并到一个 action 工具，按真实参数与展示清晰度决定，不为工具数最少牺牲可读性。

## 3. Ownership 与依赖

| Module | 持有的事实 / 资源 | 不负责 |
| --- | --- | --- |
| Pi host | session、请求/工具循环、权限、消息队列、重试、compaction、原生 abort | Goal 完成策略、Goal 资源归属 |
| ext-core | session lifecycle、resources、service discovery、Surface、presentation、settings、BackgroundDelivery | Goal schema、审查协议、具体 child 管理 |
| pi-goal | 目标事实、run 授权、续跑策略、完成判断、自己持有的资源 scope | 自建 agent runtime、进程/panel 操作、通用任务系统 |
| pi-subagents | child、receipt、派发与结果、停止确认、owned scope 清理与失效恢复 | Goal 的验收结论与自动续跑策略 |
| pi-ask-user | 提问校验、TUI/RPC 呈现、响应、timeout、取消与局部清理 | 决定某个回答是否授权启动 Goal |

建议 pi-goal 明确作为 subagents / ask-user 的集成型消费者。若采用其公共导出，依赖方向是 `pi-goal → 具体 provider → ext-core`，不得反向依赖 pi-goal，不得把具体 provider 类型移入 ext-core。

**安装依赖与运行启用分开：**建议公共入口采用无注册副作用的 subpath。正常声明 package 依赖以取得 Interface；import 不自动注册第二次 extension。subagents 审查仍是可选功能，必须有当前 session 的 provider 才能执行；要求审查而 provider 不可用时，不能静默改成免审。ask-user 的函数式提问不应要求模型工具已激活。确切依赖范围与导出路径在实施前核对。

ext-core 的 getService 只作即时 capability lookup，没有 waitForService 或事件 RPC。provider 暂不可用时显示原因，用户可在启用后重试；不新增轮询或注册顺序协调器。

## 4. 三层状态：事实、授权、资源

### 4.1 GoalDocument：持久化目标事实

建议保存：goalId、objective、验收要求、definitionRevision、目标 disposition、必要 checkpoint、证据引用、用户选择的审查模式与额度，以及必要的 receipt 引用。

额度上限与已记录的自主续跑/审查发起次数是可恢复事实；不等于恢复执行授权。续跑提案的计数随 boundary snapshot 保存，审查发起尝试在派发前记账，失败也明确显示为一次尝试，不冒充精确成功请求计费。这样普通 resume 不必凭内存猜剩余额度；是否允许重置由用户明确决定。

- disposition 表达 open / blocked / completed / cleared。
- definitionRevision 只在目标或验收要求变化时更新；普通 checkpoint 不应无故废弃审查。
- cleared 是明确的历史清除记录，防止恢复时从更早的快照复活旧目标。
- checkpoint 是恢复提示，不是可执行计划，不包含完整工具输出或历史转储。
- 不保存 AbortController、service handle、Promise、TUI 状态或“重启后自动运行”的授权。

### 4.2 RunScope：只在本次运行有效的授权

每次显式 start/resume 生成新 runId，绑定 sessionId、当前 branch 的生命周期、goalId 与 definitionRevision。它持有额度的运行时视图、AbortController 和 phase；计数不成为与 snapshot 独立竞争的事实源。

branch 的当前 leaf 每次 append 都会改变，不能把固定 leafId 当持续有效的 branch 身份。正常追加 entries 不失效；真正的 tree 导航、session 替换或恢复会废弃旧 run。

phase 仅表达 working / reviewing / closing。没有活动 run 的 open goal 对用户显示 paused。持久化目标仍存在，不代表自主授权仍存在。

### 4.3 ResourceScope：Run 创建的外部工作

run 持有自己的提问与 subagents OwnedScope。每次异步操作捕获其创建时的 run，不能只检查全局 `active === true`：旧操作返回时，新 run 也可能已经 active。

结果生效前核对：原 run 尚有效、当前目标身份与定义版本相同、当前完成尝试相同、receipt 对应同一委托。字段在各自真实 seam 验证，不层层传递多个重复 guard。

资源属主不是一份副本：Goal 保存必要关联；child/receipt/停止状态的权威仍在 subagents。

## 5. 生命周期与状态机

```text
无目标 ──用户 start──► open + Run(working)
                        │
                        ├─正常停顿──► 继续 working
                        ├─完成提交──► Run(reviewing) ──通过──► completed
                        │                      └─拒绝──► working / blocked
                        ├─真实障碍──► blocked，无活动 Run
                        └─pause / Esc / 额度耗尽──► open，无活动 Run（paused）

paused / blocked ──用户 resume──► 新 Run(working)
任意有效目标 ──用户 clear──► cleared，无活动 Run
任何旧 Run ──tree / replacement / shutdown──► 失效并清理
```

### 5.1 启动：先建立可负责的属主，再产生副作用

确认目标 → 验证/写入目标事实 → 建立 run 与资源登记 → 检查必需 capability → 提交首个宿主请求。不能先启动 child，最后才把它加入待清理列表。

创建目标、持久化成功和运行已开始是三个不同结果。任何一步失败都给出当前事实；不能让 UI 显示 active，而实际上没有可用 run。

### 5.2 正常推进：宿主 owns 请求，Goal owns 是否继续

使用 Pi 1.5 的 `agent_before_settle`，不在 agent_end 启动下一轮。仅在 run 有效、phase 为 working、outcome 正常、尚有自主额度且没有待处理工作/现成 continuation 时追加目标续跑消息。保留其他 handler 的 boundary entries，不覆盖它们。

不能只返回 continue:true：host 检查 canContinue，通常需要追加能形成下一请求上下文的 custom message draft。消息给出下一步方向，不重复整份目标历史。

正常工具循环、宿主重试、compaction retry 与用户已排队的输入不计作 Goal 新提出的自主续跑。后续 handler 仍可能改变最终 proposal，因此额度应称为“Goal 提出的续跑次数”，不是精确 provider request 或金额预算。

边界 draft 尚未提交时，不把提案当已持久化事实；处理 append 失败及用户在 boundary 内 abort 的情况。不同 extension 的 entry 提交不是跨条目事务，不承诺 exactly-once 请求。

### 5.3 暂停与取消：先失效，再收尾

建议 `/goal pause` 同步撤销 run 授权，随后调用宿主 abort 停止当前父 agent 操作，并关闭本 run 的资源。Esc 复用原生 abort，在 agent_settled 中收敛为 paused，不另设全局键盘处理器。

工具入口必须把本次宿主 tool signal 接入 run 的取消路径，特别是正在等审查结果时；signal abort 先同步失效 run，再启动被跟踪的清理。agent_settled 是最终收敛点，不是第一次通知取消的唯一途径，否则“等待 child 才能 settled、settled 才停止 child”会互相等待。scope 的停止确认不复用已经 aborted 的等待 signal。

统一 close 顺序：

1. 标记原 run 失效，禁止新续跑、新提问、新审查和结果提交。
2. 发出 abort，关闭提问；subagents scope 同步进入 closing，拒绝后续派发。
3. provider 为已登记及启动中的 owned child 记录停止意图并执行停止确认。
4. 等待/汇总清理结果，显示未确认退出的 child；不因一个失败跳过其他清理。
5. 释放监听、Surface、状态等本地资源；幂等重复 close 不重启工作。

**取消请求已发出不等于进程已退出。** stop 失败仍是 paused + cleanup pending，不回到 active，不报告已停止。未完成的自有审查清理不得被 resume 悄悄绕过而启动另一份审查；先核实退出或由用户明确处理。

暂停不能回滚已发生的文件或网络副作用，父 agent 已启动的其他后台工作也不会因归属于同一聊天自动被杀死。首期只绑定 Goal 自动创建的审查 child；不扩大到用户所有 agents 或 bg_bash。

### 5.4 替换与 clear

新目标不能原地改变旧 run 的身份。先关闭旧 run，再保存新目标并在用户授权下创建新 run。清理尚未确认时不并行启动替代审查。

clear 保存 tombstone，但不删除 subagents 的 receipt、停止意图或诊断证据。保存失败也不能恢复已撤销的执行授权：立即停止，明确显示写入失败，保留原持久化事实供后续处理。

### 5.5 完成

没有活动 run 不接受完成提交。提交应带当前目标要求对应的证据，不以“没有更多工具调用”推定完成。

未要求审查时，验证完成声明、保存 completed，再展示成功。要求审查时进入 reviewing，暂停 Goal 自主续跑；绑定一个 completion attempt，等待其 owned child 结果。

只有 approve 且所属 run、目标定义与完成尝试仍有效，才能保存 completed。reject 返回具体缺口；可继续时回到 working，确需人类决定时 blocked。failed/cancelled/uncertain/不可解析均不是 approve，不自动创建无界重审循环。

先完成结果校验与持久化，再释放 run。若资源清理失败，应区分“完成证据已接受”与“审查资源未确认清理”，不能丢掉后者。

### 5.6 session / branch / context 事件表

| 事件 | 目标事实 | 授权与资源处理 |
| --- | --- | --- |
| session_start / resume | 读取当前 branch 最新有效 snapshot | 恢复为 paused；不继承旧 run，不发模型请求 |
| 用户显式 resume | 保留目标与 checkpoint | 新 runId，重新检查 capability 与未清理资源；额度恢复策略明确告知 |
| 人类新输入（非 Goal 控制命令） | 不猜测它是否修改目标定义 | 建议暂停旧自主推进、废弃旧完成尝试；按宿主原有队列语义处理输入，不劫持或丢弃消息；是否恢复由用户明确决定 |
| 普通 appendEntry | 目标随当前 branch 历史推进 | 不误判为切分支 |
| compaction | 从原始 branch entries 恢复；不依赖 LLM 摘要 | 不重启 run；不重置额度，不重复审查或重发已提议 continuation |
| tree 导航 | 按目的 branch 重建目标 | 导航开始即撤销旧 run；导航取消也保持 paused，避免暗中再授权 |
| fork | 继承路径上可见的目标事实 | 原 session 关闭旧 run；新 session 无运行授权 |
| new / 切换 session | 恢复目的 session 自己的目标 | 旧 session 资源清理，不能把旧 context 用于新 session |
| reload / quit | 目标事实仍在 session | 停止 owned 审查后释放 provider；reload 不自动续跑 |
| 进程 crash | 仅已落盘事实可信 | 下次启动核实旧 owned child；不能凭旧 active 字段复活执行 |
| subagent child session | 不激活父 Goal 运行时 | 不继承目标自主循环，避免审查 agent 递归启动 Goal |

并非所有动作都由 ext-core lifecycle 自动覆盖：其 session_start/session_shutdown 管 session；tree 需要显式处理。拦在 before_tree 是为了先撤销授权，而不是强迫导航必须成功；最终 tree 事件才切换事实视图。

## 6. 持久化、写入顺序与恢复

### 6.1 单一事实源

通过 namespaced custom entry 保存 GoalDocument 完整快照。恢复取当前 branch 最近的有效版本，不扫描无关分支。工具结果、status 与 entry renderer 都是投影，不是另一份可恢复状态。

初版需有简单可辨识的 schema version。畸形或不支持版本显示恢复错误，不当成“没有目标”后自动覆盖；不为尚不存在的旧格式预建迁移框架。

不建立项目共享 JSON、focus 文件、目标 ledger 或全局文件锁。支持范围是一个 session 的正常单写父会话；不承诺多个独立 Pi 进程同时写同一 session 的一致性，也不引入分布式执行属主。

### 6.2 事实与执行授权的写入顺序不同

- start / 修改定义 / completed：先成功保存事实，再报告对应成功；保存失败不启动后续工作。
- pause / abort / shutdown：先撤销运行授权，再尝试记录原因。写盘失败不能阻止取消。
- clear：保存 tombstone 才称“已清除”；保存失败也保持执行已暂停。
- 更新 checkpoint 不重复保存完整 transcript；仅记录恢复有价值的信息。

新 session 尚无 user/assistant 对话时，Pi `session-manager.js:792–810` 会缓冲 custom entries。appendEntry 成功不是立即落盘的证明。命令首次启动应走宿主正常的用户输入/对话路径后再确认持久化，不能用第二份 Goal 文件补偿。非持久化 session 仅承诺进程内状态。

### 6.3 Crash 后的 child 归属不能靠内存猜

Goal 授权不持久化，不代表外部副作用的归属也可以不记录。owned child 的 parent session、消费者 scope/run 标识与 receipt 关联应由 subagents 在接受派发前持久化；不复制 Goal 正文。

这样即使进程在“child 启动成功、Goal 尚未写下 receipt 引用”之间崩溃，provider 仍知道该 child 属于失效的 owned run。恢复先依据已有 lease/进程事实核实属主，再清理，不能先自动重开旧审查 panel 再等 Goal 来停止。

provider 不得仅因本进程没有内存 scope 就杀死可能仍由另一个活进程持有的 child。**现有 child-writer lock 只能证明 child 在运行，不能证明创建它的 parent/run 仍活着。** owned scope 需要单独的 owner incarnation 证据：

- 每次 subagents provider lifecycle 生成唯一 incarnationId，先持有该 incarnation 专用的进程锁，再允许写入 owned 委托；owner 引用包含 parentSessionId、incarnationId、consumer scope/run 标识。不能仅用 pid，避免 PID 复用及同进程 reload 混淆。
- 复用现有 process-lock.ts 的 SQLite 内核锁机制，但使用与 child-writer 分离的 owner 命名空间。它是具体 provider 资源属主的生存证明，不是项目目标 writer 锁、设置锁或全局协调服务；无需 heartbeat、过期时间或漏一次轮询就判死亡。
- 恢复时 owner 锁仍被持有，说明对应 incarnation 或其清理者仍在处理：不抢占、不重新开审查；明确显示另一属主仍活跃。只有确认 owner 锁可取得后，恢复方才认领孤儿清理，写停止意图并核实 child 退出；清理期间保持认领，避免两次恢复同时操作。
- 正常 provider shutdown 先失效 scopes、执行/汇总清理，再释放自己的 owner 锁。crash 时内核释放锁；清理失败仍保留持久化 owner/停止记录，让下一次恢复能继续。锁不可访问或证据损坏属于明确恢复错误，不退回 pid 猜测或无限 uncertain。

该机制只复用本地现有 state/锁语义，不承诺跨机器共享目录的一致性。启动前登记、owner 证据、receipt 绑定与停止意图的具体字段/事务顺序属于 M0 的必要契约，不作为可跳过的实现细节。

这项持久化属于 subagents 的资源生命周期契约，不是新的 Goal 状态数据库，也不改变普通独立 agents 的恢复规则。

## 7. pi-subagents：必要的深 Interface

### 7.1 当前实现与缺口

当前 `delegate(..., signal)` 的 signal 只结束等待，child 仍可能继续，结果回到自动交付。`stop(id)` 停止整个 child，不支持只停止某个 revision。扩展退出调用 closeLocalConnections，特意不按 Goal 要求停止全部 child。

所以不能靠 executeTool + 传 signal 就宣称实现了已确认的 run-bound 生命周期。也不能裸导出 Manager 让 pi-goal 自行补 #waiters、bridge、receipt 和 panel 清理。

### 7.2 建议的能力形状，而非已存在 API

由 subagents 导出类型、service key 与无副作用的 runtime 入口；provider 保留在具体 extension 中，通过 ext-core 注册当前 session capability。Interface 收敛为：

- **创建 OwnedScope**：绑定当前 parent session、消费者与 run；scope 在任何异步启动前已可关闭。
- **在 scope 内委托并等待结果**：返回具体 delegation/child/revision 的身份与结果；复用现有 receipt 和执行路径，不返回内部 registry 或 Manager。
- **关闭 scope 并返回清理报告**：幂等；停止启动中与已启动的自有 child，区分退出已确认、未确认、操作失败。

scope 不接受任意现有 childId 的“认领”。首期只创建全新专用审查 child，不复用用户 agent；**但新建本身不构成独占**，还必须在所有共享 send/delegate seam 拒绝非 owner 对该 child 的重用、steer 或追加 revision，覆盖工具、命令与 MCP 路径。只读检查与用户显式停止仍允许。

独占持续至 scope 清理确认并释放归属，cleanup pending 也不能放开。之后若允许用户明确恢复该历史 child，旧 scope 必须已经终结，重复 close 只能返回既有结果，不能停止后来工作。普通无 owner 的 agents 行为不变。不预加按名称前缀过滤或允许任意 ownerTag 认领。

provider 实例与 scope 固定绑定创建它们的 session/lifecycle；过期调用返回明确失效结果，不能通过一个全局“当前 Manager”把旧 handle 重定向到新 session。

### 7.3 派发、权限与可检查性

模型发起的审查必须保留 Pi tool pipeline：校验、权限 hooks、nested-call 记录和可见结果。建议 scope 的模型委托入口接收当前 tool context，仍通过 executeTool 派发；scope 身份需在 subagents 接受委托时绑定，而不是完成后才按返回的 childId 补登记。

command/lifecycle 使用已取得的 scope 进行关闭与状态确认，不保存旧 tool context，也不伪造 executeTool。若要让 command 直接发起工作，必须单独说明其用户授权与权限执行路径，不能把直接调用 Manager 当成与 tool pipeline 等价。首期没有这个需求。

scope 身份编码、tool 参数与 receipt 元数据字段需在实施前完成契约评审；不使用跨请求的 ambient 标记、全局“下一次调用属于 Goal”状态或事件 RPC。停止操作沿用已有显式 stop 路径，并提供相同的可检查诊断。

### 7.4 必须解决的竞态

| 竞态 | Interface 承诺 |
| --- | --- |
| close 先于派发 | 拒绝新工作，不预留后再偷跑 |
| 启动过程中 close | 记住停止意图；迟到创建的 child 也归本 scope 清理 |
| 接受后结果立即到达 | 使用同一 receipt，不能丢结果或自动投递两次 |
| 取消等待后迟到结果转入自动投递 | owned scope 已失效时只能保留可检查历史，不再 steering 或发送会自主启动父请求的消息；普通独立委托保持原策略 |
| 旧 scope 在新 run 开始后 close | 只能影响自己的专用 child，不按通用 childId 停止后来工作 |
| child 已完成但 panel 仍存在 | 完成结果与资源关闭分别确认 |
| provider 先于 Goal shutdown | provider 自己关闭全部 owned scopes，再 closeLocalConnections；消费者顺序不是正确性前提 |
| 停止失败 / panel 观测失败 | 保留 metadata、停止意图与可重试诊断；不假报成功或盲目重派 |

provider 退出必须主动处理其 scopes；仅用 AbortSignal event listener 发出未 await 的异步停止不算完成清理。使用现有子进程/host 超时与结果机制，收集失败，不用裸 Promise.race 掩盖仍在进行的启动副作用。

普通 agents_delegate 的独立运行语义保持不变；run-bound 是显式 capability，不把所有 subagents 的 Esc/reload 行为一起改掉。

## 8. pi-ask-user：复用完整提问，而非工具结果包装

### 8.1 建议导出的 Interface

提供单次结构化 prompt 操作，接受单问题或现有独立问题 batch、当前 ExtensionContext、signal 与 deadline；返回带标签的 answered / cancelled / timed-out / unavailable 结果。字段名称实施前定案。

- 参数错误在输入 seam 明确失败；不要把校验失败也说成用户取消。
- answered 需要已经验证的响应；batch 不完整不得自动视为授权通过。
- cancelled、timed-out、unavailable 都不能授权 Goal 启动。
- 请求超时是整次交互的 deadline，不能每打开下一页就重新计时。
- abort 先于迟到响应时，返回取消；清理 timer、listener 和 Surface。

模型工具与程序化入口共享校验、交互和清理实现。AgentToolResult、onUpdate 与工具 presentation 留在工具层；不能简单导出 executeSingle，让所有消费者解析工具文案。无需导出 AskComponent、BatchAskComponent、原始 surface factory 或通用问卷 builder。

### 8.2 当前实现需要调整的地方

runCustomPrompt 当前返回 `T | null`，混合用户取消、timeout 与 abort；作为稳定 Interface 前需在真实发生点保留原因，不在返回 null 后靠时间差猜测。

工具目前是 model-only，这是模型 exposure 规则，不妨碍函数式 Interface 接收 command context。TUI 复用 Surface，RPC 在 hasUI 时使用宿主 dialogs；真正无交互能力返回 unavailable，不把 headless 当成有 UI 的 fallback。

当前存在无 request 关联的全局 pi-ask-user:answer 事件与直接 response assertion。程序化授权 prompt 不能默认消费这种广播；调用方只通过 Promise 收到本请求的已验证结果。若保留外部回答机制，必须显式 opt-in、请求关联和响应校验，不能把广播事件升级成 Goal 控制 RPC。

answered/blocked 等事件只作通知；不广播用户的完整答案与上下文。模型工具既有事件和展示需要回归测试，不能因导出 Interface 重复发射。

### 8.3 消费者生命周期

Goal 从 RunScope 或启动命令的短期 interaction scope 传入 signal；不能依赖可能不存在的 streaming ctx.signal。session 切换、Goal 替换或关闭都要关闭该交互，返回后再次确认调用 scope 仍有效。

不在长期 boundary handler 中悬挂问卷：需要用户输入时结束自主推进，进入 blocked；由用户交互或后续正常输入解锁。也不为 Goal 增加通用 prompt queue。冲突沿用现有 Surface/dialog 限制，明确返回 busy/失败，不能覆盖另一问题。

## 9. 完成审查的语义

独立检查、强制验收和 OS 只读沙箱是不同能力。审查是否必需由用户选择；关闭时可凭证据完成，开启时不允许模型自行绕过。带 bash 的 reviewer 不能被标为只读沙箱。

审查任务携带 objective、验收要求、证据位置与明确范围；输出使用小型可验证 verdict 协议，绑定目标定义和本次 completion attempt。不要搜索任意正文中的 approved，也不要增加一个模型来猜前一个模型的 verdict。

使用现有 reviewer 或用户选择的角色；角色可被用户覆盖，因此实际能力要可见。测试可能写工作区，沿用正常权限。

审查期间不续跑 Goal 新工作；收到新要求或已知产物变化时废弃当前完成尝试，再提交新审查。不开全工作区文件锁，也不声称审查保证期间无人修改；结论只对应它检查的证据时点。

审查额度属于用户自主授权的一部分，不能以“父续跑次数还有余额”为由无限创建 child。默认次数与耗时策略待确认，必须在 UI 中说明限制对象；不把次数伪装成精确金额预算。

## 10. 并发、失败与清理原则

一个 run 最多一个有效 completion attempt，不并发创建多个审查再挑通过的那个。重复 complete 返回当前尝试，不重复派发。

状态变更通过小型、同步、无 await 的提交点判断当前 run；必要异步工作在其外执行，回到提交点时校验捕获的 run。不要在全局串行队列里 await 人类输入、child 结果或进程退出，否则 pause 无法进入。没有真实竞争的纯读取不加锁。

| 失败 | 对外结果与后续 |
| --- | --- |
| 目标写入失败 | 不称已保存/已完成，不启动后续工作；取消仍生效 |
| provider 缺席或不兼容 | 当前要求的能力 unavailable；不静默降级安全/验收策略 |
| 宿主最终请求错误 | 暂停并保留 checkpoint，不叠加 Goal 网络重试器 |
| child blocked / failed / uncertain | 保留 receipt 与原因，不判通过，不无限重试 |
| 提问关闭 / 超时 | 不授权、不自动选择默认答案 |
| 旧回调 / 迟到报告 | 可作为历史证据展示，不改变当前 run 或完成新目标 |
| cleanup 失败 | paused/终态 + 明确资源诊断；继续尝试其他清理 |

没有 active Goal 时不加目标系统提示、不触发模型请求、不创建轮询。真正异步 producer 才用 ext-core BackgroundDelivery；同步 boundary continuation 不绕交付通道。

## 11. UI、可检查性与上下文成本

使用现有 presentation 呈现工具执行，使用短状态表示 working / reviewing / paused / blocked / cleanup pending。完整目标、证据、receipt 与清理原因由 status/info 命令查看，不用任务百分比伪装确定性。

Goal custom entry 可通过 registerEntryRenderer 直接展示状态变更；无需再持久化一份展示状态，也不把每个状态通知重新送入模型触发回合。

续跑消息可不占常规聊天正文，但检查入口要能看到目标身份、原因和计数。prompt 只投影当前目标与必要 checkpoint；长证据保留完整获取路径，不靠截断后的摘要决定完成。

简单启动确认用宿主 UI；确有结构化选择时才调用 ask-user Interface。不建设第二个 dashboard、模态 UI 或状态容器。不硬编码修改 pi-status 的排序。确定 UI/UX 后同步 DESIGN.md；本草案尚未批准新展示契约。

## 12. 实施里程碑：按完整责任交付

### M0：设计门禁与 Interface 定案

确认本草案的状态、取消和恢复规则；敲定审查强度、额度恢复语义、必要的公共 Interface。按消费者需要设计测试，不先裸导出内部对象。更新相关高层设计、provider 附近的契约文档与必要的 DESIGN.md，再开始实现。

### M1：pi-subagents owned lifecycle

实现专用 scope 的提交归属、启动中取消、停止确认、provider teardown 和 crash 恢复；保留普通独立 agents 的行为。先用可运行契约测试证明这条生命周期路径，不建立新 TaskRegistry 或通用 orchestration 框架。

交付标准：相同 seam 能被工具消费者使用和测试；pause/关闭不依赖 extension teardown 顺序；启动与停止失败均不留下无归属 child。

### M2：Goal 纵向闭环

新增独立 pi-goal workspace、一个 extension 入口。实现目标快照、命令、原生续跑、授权/额度、blocked、完成与 owned 审查、统一 close、branch 恢复、简洁状态。由用户要求审查与否走同一完成流程。

交付标准：从用户 start 到实际工作、完成/暂停、退出重开能跑通；不能只有 schema 和状态类而没有端到端路径。先覆盖 session、run、child 三个真实 ownership，不按文件长度拆分。

### M3：ask-user 程序化复用

在需要结构化启动/恢复选择的真实入口上提炼 prompt Interface，同时让模型工具走共享实现。若没有这样的交互调用方，先不为了“允许导出”新增 API；宿主简单确认已足够。

交付标准：TUI 与 RPC 同一响应语义；无 UI、取消、deadline、迟到答案、事件隔离均经过测试，既有工具呈现不退化。

### M4：对抗性恢复与集成验证

组合验证真实 parent/child、panel/background、reload、quit、crash 后恢复与旧结果交付。只在这些路径验证后声明生命周期实现完成；不能以纯状态 reducer 测试替代进程退出证据。

不预承诺实现文件数或缩减百分比。架构的检验是：删除这个 Module 后，相关生命周期复杂性是否重新散落到每个调用方。

## 13. 必须留下的测试矩阵

| 范围 | 必测场景 |
| --- | --- |
| Goal 事实与授权 | 保存失败不启动；取消写盘失败仍暂停；completed/clear 不被早期快照复活；新 run 不接旧结果 |
| host continuation | 正常停顿仅提议一次；工具循环不重复；已有队列/其他 handler proposal 不覆盖；boundary 内 abort；draft 提交失败；错误不重试 |
| branch/context | 普通 leaf 推进不失效；tree 成功/取消均无旧 run；compaction 不重置额度；fork/resume/reload 不静默启动；child 不递归 goal |
| subagents OwnedScope | dispatch 前/中/后 close；快速 settlement；重复 close；旧 scope 不停新工作；用户 agent 不受影响；provider 先退出；stop 不确认 |
| crash 窗口 | owner 已记录但未启动；启动后 Goal 尚未关联 receipt；Goal 已 completed 但 panel 未关；旧 owner 仍活时不抢占 |
| ask-user Interface | answered/cancelled/timeout/unavailable；无效参数；RPC dialogs；无 UI；迟到答案；外部广播不能授权；timer/listener/Surface 清理 |
| UI | 窄/宽布局、长目标与完整证据、无 pi-ext-ui、缺少 provider、cleanup pending 可检查 |

单元测试控制可等待的派发与退出事件，稳定复现竞态，不用任意 sleep。真实 CLI/锁/重启路径另加 test-integration；既有独立 agents 的 wait-abort 与恢复用例必须继续通过。

验证按范围升级：文档只做 diff/空白检查；单 package 实现做 Biome、聚焦测试与 build；公共导出、receipt 持久化、跨 package import 与新 workspace 升级全仓 typecheck，并跑受影响测试。涉及真实 CLI、锁、重启时额外运行 test:integration。只有影响可跨全仓传播或准备发布才升级完整检查，不默认跑全量。

## 14. 下一轮设计评审的前沿问题

已经确定 Session 存储与 run-bound 审查，不再反复询问。实现前仍需逐项收敛：

- **审查强度**：可选功能默认关闭，还是默认启用独立审查？启用后应采用机器可验证批准协议。
- **自主额度**：限制父续跑与审查创建的默认值，resume 是否续用剩余额度；建议不因普通 resume 隐式补满，增加额度必须明确。
- **暂停范围**：本草案建议 pause 同时 abort 当前父操作；Esc 等价撤销 run，不仅停止等候。是否接受该用户行为？
- **新输入优先**：建议人类新输入暂停旧自主推进，不通过语义分类猜它是否属于 Goal；普通补充之后也需显式 resume。是否接受该交互取舍？

scope 方法名、工具参数、receipt owner 字段与提示结果类型属于后续 Interface 定案；不能把本草案的能力描述误标成已存在或已批准的 API。

## 附录 A：上游研究与事实修正

保留 objective、验收要求、主动续跑、真实 blocker 和可选独立检查。不上多目标池、Oracle、计费账本、层级 task 引擎、严格步骤门禁和第二套 auditor runtime。

当前上游 drafting profile 只替换 Goal 自己的工具，没有删除普通 read/bash。三轮 blocker 是 prompt policy，不是三轮 runtime 计数门禁。goal-lock 是单目标短锁，不是全局锁。历史 agentic-runtime-prd 已 superseded，不能据它描述当前实现。auditor 带 bash，不具备 OS 只读保证。

上游复杂性来自多目标共同写入、ledger/focus/checkpoint 多事实源、独立 scheduler 与重试、问卷和 auditor 自有 runtime。新 package 不具备这些首期需求时，删除对应需求比照搬后再包 ext-core 更有效。

固定 revision 证据：

- [goal-state.ts](https://github.com/tmonk/pi-goal-x/blob/b0fc15ebb658a1e9ea60ae65496717a780080f37/extensions/goal-state.ts#L334)：profile 行为。
- [goal-events.ts](https://github.com/tmonk/pi-goal-x/blob/b0fc15ebb658a1e9ea60ae65496717a780080f37/extensions/goal-events.ts#L133)：stale/post-stop 拦截；L558 起为结束调度。
- [goal-core-tools.ts](https://github.com/tmonk/pi-goal-x/blob/b0fc15ebb658a1e9ea60ae65496717a780080f37/extensions/goal-core-tools.ts#L243)：blocker policy。
- [goal-lock.ts](https://github.com/tmonk/pi-goal-x/blob/b0fc15ebb658a1e9ea60ae65496717a780080f37/extensions/storage/goal-lock.ts)：锁的实际范围。
- [goal-auditor.ts](https://github.com/tmonk/pi-goal-x/blob/b0fc15ebb658a1e9ea60ae65496717a780080f37/extensions/goal-auditor.ts#L324)：独立 session 与工具。

## 附录 B：本仓库 seam 与当前事实

- `packages/pi-ext-core/src/lifecycle.ts`：session_start/shutdown 串行，先 abort 再 resources 清理；不覆盖 tree。
- `packages/pi-ext-core/src/disposer-registry.ts`：逆序、幂等、收集所有清理失败。
- `packages/pi-ext-core/src/service.ts`：createServiceKey / provideService / getService；具体类型应由 provider 导出。
- `packages/pi-subagents/src/manager.ts:450,1414,1464,1994`：本地连接关闭、派发、等待、停止的不同语义。
- `packages/pi-subagents/src/extension.ts:243,494`：provider lifecycle 与当前 closeLocalConnections。
- `packages/pi-subagents/src/receipts.ts`：权威 delegation/revision/结果；现无本草案的 owned scope 契约。
- `packages/pi-ask-user/src/execute.ts`、`custom-prompt.ts`、`events.ts`：交互、null 结果、广播回答与事件隐私。
- `packages/pi-ask-user/src/index.ts`：当前只公开默认入口与 reconcileAskUserTool，不存在本草案的 prompt Interface。
- `packages/pi-python-eval/src/bridge.ts:46`：现有 executeTool 复用路径。
- Pi host 1.5.0：`<node_modules>/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` 的 tool context、BoundaryResult、SessionShutdownEvent；`dist/core/agent-session.js` 的 boundary 提交/canContinue；`dist/core/session-manager.js:792` 的首次落盘条件。

本草案所有新增名称均是建议，不是现有 API 清单。实现前需对当前 checkout 再核对实际调用方、持久化与公共契约。
