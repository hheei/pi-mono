# pi-goal：设计思想、生命周期与实现计划

状态：用户已授权在独立 worktree 中由 subagent 实现。独立审查默认关闭，通过 ext-settings 开启；Session 级持久化与 run-bound 审查已确认。具体 Interface 在实现前记录并复核，按本文 ownership 与生命周期约束落地。

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


… 201 lines / 19KB omitted …
[Full output: /tmp/pi-output/read-60.txt]
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

- **审查强度（已确认）**：独立审查默认关闭，通过 ext-settings 开启；启用后采用机器可验证批准协议，不能静默免审。
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
