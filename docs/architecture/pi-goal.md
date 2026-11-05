# pi-goal：目标承诺、自主授权与归属审查

状态：已批准实现（独立 worktree）。审查默认关闭，通过 ext-settings 的 `goal.review` 开启；Session 级持久化与 run-bound 审查已确认。上游研究见 [pi-goal-research.md](pi-goal-research.md)。

## 1. 用户可见目标与数据流

pi-goal 只管四件事：这次授权完成什么、什么证据可以结束、现在还有没有自主继续的授权、本次运行创建的资源由谁终止。执行仍由父 agent 用原有工具完成。

```text
用户 /goal start → GoalDocument + RunScope(working) → 一条可见 kickoff 消息唤醒模型
                         │
                         ├─ 正常 settle → 原生 boundary 继续（消耗额度）
                         ├─ /goal pause 或 Esc → 立即撤销 run 并 abort 父操作，保留目标（paused）
                         ├─ goal blocked → disposition=blocked，无 run
                         └─ goal complete（有证据）
                                │ review=off → completed
                                └ review=on  → RunScope(reviewing)，每次尝试独立 owned scope
                                     └ 归属审查 child 结论 → completed / working / paused
```

## 2. 三层状态与归属

| 层 | 事实 | 是否持久化 |
| --- | --- | --- |
| GoalDocument | objective、acceptance、definitionRevision、disposition、checkpoint、evidence、reviewMode、budgets、usage、lastReview | 是，随 branch 快照 |
| RunScope | runId、goalId、definitionRevision、AbortController、phase、本次审查 attempt 的 owned scope | 否，仅内存 |
| Ownership | 审查 child 的 owner 关联、停止确认、迟到结果 | provider 持久化 claim；停止确认由 provider 恢复 |

- **目标事实以当前 branch 的已提交 entry 为唯一权威**，控制器不保留乐观副本：boundary draft 未被宿主提交就不是额度消耗，清理/暂停也不会用旧副本覆盖新目标。
- 目标事实跟随当前 session branch。普通 append 不失效；`session_before_tree` 在导航前撤销 run，`session_tree` 只重建事实。成功或取消的 tree 导航都保持 paused。
- 没有活动 run 的 open/blocked 目标一律显示为 paused；持久目标存在不等于自主授权存在。
- 恢复（startup/resume/fork/reload）只重建事实，绝不自动启动 run，也不补满额度。
- 最新 `pi-goal` entry 无法解析时进入 recovery 状态：`status` 显示错误，`start`/`resume`/`clear`/工具全部拒绝，绝不回退到更早的合法快照（那会复活 completed/cleared 目标）。
- 子会话（设置 `PI_SUBAGENTS_CHILD_ID` 的 pi-subagents child）不注册 goal runtime，不能创建或恢复目标，因此不会递归运行 goal。

## 3. 公共契约

### 3.1 命令 `/goal <subcommand>`

| 子命令 | 语义 |
| --- | --- |
| `start [objective]` | 新建目标并启动 run，然后投递一条 run-bound kickoff 唤醒模型。无参数时使用 `ctx.ui.editor`（无 UI 则报错）。已有 open/blocked 目标时必须确认替换；替换先撤销并 abort 旧 run。授权新 run 前通过命令上下文的 `waitForIdle()` 完成旧宿主操作交接，并在交接前后各用实时的 `ctx.model` 校验模型：没有选中模型时拒绝授权、不写快照（否则 void `sendMessage` 的异步失败会让目标停在 working 且无法 resume）。 |
| `status` | 完整展示目标、disposition、run/phase、checkpoint、evidence、额度、lastReview、owned child、清理诊断、recovery 错误与持久化状态。 |
| `pause` | 先撤销 run 并 abort 当前父操作，再持久化 paused，最后请求停止 owned child。close 在第一次 await 之前就登记为 pending，因此 close 悬而未决时 resume/替换/审查都会被拒绝。 |
| `resume` | 为现存 open/blocked 目标创建新 run 并投递 kickoff；不重置 usage。completed/cleared 拒绝。旧宿主操作尚未交接、清理未确认或没有选中模型时拒绝，并在 `waitForIdle()` 之后重新校验 branch、模型与授权。 |
| `clear` | 撤销并 abort 旧 run、停止 owned child、disposition=cleared（保留历史事实，防止旧快照复活）。开始前记下 branch generation 与 goalId；deferred close 结束后重新校验，绝不清理导航后目标 branch 上的另一个 goal。 |

子命令带 shell 风格补全（固定列表）。参数解析使用 ext-core `splitSubcommand`。

### 3.2 模型工具 `goal`

`defaultActive: false`。`start`/`resume` 时通过 `pi.setActiveTools` 加入活动集合，pause/clear/complete/blocked/teardown 时移除。

```ts
Type.Object({
  action: "read" | "checkpoint" | "blocked" | "complete",
  text?: string, // checkpoint/blocked/complete 必填
})
```

- 每次调用都使用**当前** native tool context 与 signal；控制器不保留 tool context，只把它传给本次 owned review 的 dispatch，让 provider 通过 `executeTool` 走同一套校验、hooks 与权限。
- tool signal abort 立即撤销 run、abort 父操作并清理 owned child，不必等待 `agent_settled`。
- `read`：目标、acceptance、definitionRevision、disposition、phase、checkpoint、剩余额度、lastReview。
- `checkpoint`：记录恢复提示（不含工具输出转储），不更新 definitionRevision。
- `blocked`：真实障碍，disposition=blocked，结束 run，不自动重试。
- `complete`：必须带验证证据。review=off 直接 completed；review=on 进入 reviewing 并由 owned 审查判定。上一次拒绝的反馈尚未真正交付（branch 上没有匹配的可见 entry）时拒绝提交，避免新 attempt 把缺失的 ACK 误判为投递失败；交付后可直接重试。

### 3.3 Settings（`ext_settings.json` 组 `goal`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `review` | boolean | `false` | 完成时要求独立审查。 |
| `continuations` | number | `8` | 每个目标允许的父续跑额度（boundary continuation + 审查拒绝唤醒）。 |
| `reviews` | number | `3` | 每个目标允许发起的审查尝试。 |
| `reviewAgent` | string | `"reviewer"` | 审查使用的 pi-subagents agent 名。 |

设置只在 `start` 时投影进 `GoalDocument.budgets`/`reviewMode`；进行中的修改不扩大额度，resume 也不补满。provider 注册使用 `createJsonSettingsStorage({group:"goal"})`，provider id `pi-goal`。

读取发生在 `/goal start`：文件不存在使用默认值；文件不可读、不是 JSON 对象或字段类型非法时**报错并拒绝 start**，绝不把用户显式开启的 review 静默退回 false。

### 3.4 持久化 entry

`pi.appendEntry("pi-goal", GoalDocument)`，每个事实变化追加一次完整快照；branch 读取取最新的 `pi-goal` entry。

```ts
interface GoalDocument {
  version: 1;
  goalId: string;                 // goal_<hex>
  objective: string;
  acceptance: string;             // v1 等于 objective（用户所有权，模型不可修改）
  definitionRevision: number;     // 仅 objective/acceptance 变化时 +1
  disposition: "open" | "blocked" | "completed" | "cleared";
  checkpoint?: string;
  blockedReason?: string;
  evidence?: string;
  reviewMode: "off" | "on";
  budgets: { continuations: number; reviews: number };
  usage: { continuations: number; reviews: number };
  lastReview?: { attempt: number; childId?: string; revision?: number; verdict: "pending" | "approved" | "rejected" | "inconclusive" | "failed"; feedback: string };
  lastPauseReason?: string;
  updatedAt: string;              // ISO
}
```

入口数据来自 session JSONL，按不可信边界用类型守卫收窄；未知版本、非法字段或最新 entry 损坏都不得被“修复”为旧快照。

**持久化语义**：Pi 在出现第一条 user/assistant 消息时才创建 session 文件。`appendEntry` 在此之前只存在于内存 branch。`start`/`resume` 与 `status` 在文件尚未创建时明确报告 `Durability:` 提示，不宣称已可跨重启保存。

### 3.5 ext-core service 与 provider 契约

pi-subagents 新增无副作用的子路径 `@hheei/pi-subagents/ownership`（`dist/ownership.js`），只含类型、service key 与 provider 侧的 claim/stop 能力：

```ts
const SUBAGENT_OWNERSHIP_SERVICE = createServiceKey<SubagentOwnershipService>("@hheei/pi-subagents:ownership");

interface SubagentOwnershipService {
  openScope(ownerId: string): OwnedScope;
}
interface OwnedScope {
  readonly ownerId: string;
  delegate(
    request: { agent: string; task: string },
    ctx: ExtensionToolContext,
    signal?: AbortSignal,
  ): Promise<OwnedChildHandle>;
  close(reason: string): Promise<{ closed: boolean; failures: readonly string[] }>;
}
interface OwnedChildHandle {
  readonly childId: string;
  readonly revision: number;
  readonly settlement: Promise<OwnedChildSettlement>;  // completed | blocked | failed | stopped
}
```

- 每次审查 attempt 使用独立 owner id（`<runId>:review:<attempt>`），避免拒绝后再次 complete 复用已关闭 scope；同一 run 的多次尝试互不影响。
- ownership 在 spawn 的持久化/启动副作用之前登记（manager `submitDelegation` 的 onTarget 之前调用 guard）。
- 非 owner（模型工具、用户命令）对 owned child 的 delegate/send/stop 被 manager 拒绝；只有确认停止或 scope 关闭后才释放。
- owned child 的 report 由 provider 路由到 owner，不进入父对话、不触发父 turn。
- `close()` 幂等：停止所有已登记 child，确认失败时保留 ownership 并返回诊断；provider 崩溃后由下一 incarnation 依据持久化 claim 停止该 child，不会把它当作普通 subagent 留存。
- 依赖方向：pi-goal → pi-subagents → ext-core。ext-core 不含具体 extension 类型；pi-subagents 不反向依赖 pi-goal。
- 安装依赖为必需（service key 与类型），运行时审查能力可选：未提供 provider 时 `complete` 必须报错，不能静默免审。

### 3.6 审查协议

审查 child 的最终报告首个非空行必须是 `VERDICT: APPROVED` 或 `VERDICT: REJECTED`；其余内容作为理由。解析不区分大小写但要求整行匹配；无法解析视为 inconclusive（不通过）。

- APPROVED：证据写入 GoalDocument，disposition=completed，run 结束。
- REJECTED：记录反馈，回到 working；若剩余 continuations 额度允许，把反馈登记为 pending，由下一次 native `agent_before_settle` 作为可见 `pi-goal-review` custom message draft 提交并继续一次请求；这次提交不额外消耗 continuation。提交后下一次 settle 预算耗尽则 pause。
- blocked/failed/stopped/inconclusive：pause 并保留原因，不自动重试、不判通过。
- 只有 `runId + goalId + definitionRevision + attempt + childId/revision` 全部匹配当前 run 的结果才生效；旧 run 的迟到结果只记录诊断。
- dispatch 的失败与身份写入同样在 await 之后重新校验 captured run；run 已结束或目标已替换时不写入当前目标，也不暂停新目标。
- 拒绝处理在 `await close()` 之后重新读取 branch 与 run：目标被替换、暂停或 attempt 不再匹配时丢弃反馈，绝不覆盖新 objective 或发送陈旧反馈。

### 3.7 异步投递

- kickoff 通过 ext-core `BackgroundDelivery` 通道投递，注册与 dispose 归 lifecycle 所有；通道只在父会话 idle 时 flush 且每次只发一条，kickoff 不进入 Pi 原生 follow-up 队列。
- `hasPending()` 在协调器选择最终唤醒者之前先剪除已过期的 kickoff，flush 时仍再次校验 run/revision。
- flush 仍可能被宿主延迟：Pi 1.5.0 在 `agent_settled` 发射期间把 `sendMessage` 放进 deferred actions，先 pause/clear/tree 撤销 run 也无法取消该 send。kickoff 因此携带 runId/goalId/definitionRevision；控制器在 `before_agent_start` 记录这次 operation 的 kickoff token，在 `agent_start`（宿主在首个 provider 请求前 await）比对当前 run，不匹配就 `ctx.abort()` 取消这次请求，且不把该 operation 绑定到替代 run，因此不会暂停新 run。
- 审查拒绝反馈不走 `pi.sendMessage`：Pi 1.5.0 的扩展 `sendMessage` 是 void wrapper（`sendCustomMessage(...).catch(emitError)`），调用方无法等待真实 send/start；在 settle 发射期间它还会进入 deferred actions，可能在后续 handler pause 后仍启动陈旧请求。反馈因此由 native `agent_before_settle` 的 custom_message draft 提交，宿主在同一操作提交 entry 并继续请求；没有可被猜测的异步成功。不能依赖从 `before_agent_start` 抛错来取消：host runner 会捕获 handler 错误并继续。pause/abort 在 boundary 期间则会取消后续请求（真实 AgentSession 测试覆盖）。
- pending 反馈在 branch 已包含匹配 run/goal/attempt 的可见 entry 时才算真正交付；否则下一次 settle 再提交。若 boundary 提交失败或最终 settle 仍无该 entry，控制器显式 pause 并报告无法交付，不会静默 ACK。用户 pause/clear/tree 撤销 run 会清除 pending，预算不再被额外消耗。
- 如果 reviewer 在父操作最后一次 settle boundary 之后才拒绝，已经没有可用的 native boundary 或可等待的扩展 send 来安全唤醒；控制器不调用 void `sendMessage`，而是记录 `lastReview` 并显式 pause。`/goal resume` 的 kickoff 会带上最近一次拒绝的 findings，用户明确恢复后才继续。
- kickoff 与拒绝反馈都 `display: true`，用户能看到模型收到了什么；只有 boundary 续跑是 `display: false`。

## 4. 生命周期与取消

- pause/clear/替换/shutdown：先撤销授权并 `context.abort()`（不等待子进程），再持久化事实（写盘失败仍保持 paused），最后请求停止 owned child。
- `clear` 与 start/resume 使用同一 branch generation 守卫：suspend 的 deferred close 结束前若发生 tree 导航或 restore，clear 失败且不写入目标 branch。
- 撤销后的旧宿主操作可能晚于新授权到达 `agent_settled(aborted: true)`。控制器在 `agent_start` 时把宿主操作绑定到当时的 run，只暂停同一 run 的 aborted settlement；旧 run 的迟到 settlement 不会暂停替代 run。绑定以 `before_agent_start` 记录的 kickoff token 为准：token 与当前 run 的 runId/goalId/revision 不匹配的 operation 直接被 abort，不绑定。start/resume 还会先等待 `waitForIdle()` 完成交接，因此 kickoff 不会在旧操作仍 streaming 时进入原生队列。
- `session_before_tree` 在导航前撤销 run 并写入 paused；导航失败（取消）时当前 branch 保留 paused；`session_tree` 之后只重建事实并重试清理。
- 清理未确认时保留 scope 引用与失败诊断：`status` 持续展示，`start`/`resume`/替换/新审查一律拒绝，`restore`/`session_tree` 不清除；`retryCleanup` 在 session start 与 tree 后重试，确认后才恢复授权。close 从调用开始就计入未确认，不等待失败结果才登记。
- start/resume 在任何 await（替换暂停、`waitForIdle`、close）之后重新校验 lifecycle generation、branch 可读性与清理状态；期间发生 tree 导航或 reload 时不会把新目标写入新 branch。
- Esc/abort：`agent_settled.aborted` 时暂停（目标保留，run 撤销）。
- 正常 settle：仅当 phase=working、disposition=open、outcome=completed、`event.continue=false` 且没有 pending message 时提议一次续跑。宿主在提交 draft **之后**才计算 `canContinue`，assistant-final context 的 `canContinue=false` 是正常情况，不能作为前置条件；draft 里的隐藏 custom message 才是可继续的上下文。有排队的人类输入时不覆盖。
- boundary 只返回 draft，不提前修改内存事实；draft 未提交时额度不变，提交后的下一次读取自然看到新计数。
- 宿主请求错误（outcome=error）：暂停，保留 checkpoint，不叠加网络重试。
- compaction 不重置额度，也不失效 run。
- 不新增 timer、scheduler、轮询或重试引擎。

## 5. UI

- 工具执行使用 ext-core presentation（`goal` 工具行：状态 + 摘要）。
- 目标状态变化追加 `pi-goal` custom entry，由 `registerEntryRenderer` 渲染为一行信息（窄/宽都单行折行安全，ANSI 安全）。
- `/goal status` 用 `ctx.ui.notify` 输出完整事实；不建设 dashboard、不修改 pi-status 排序、不进入模型上下文。
- `/goal start`/`resume` 投递一条可见 `pi-goal-kickoff` 消息；审查拒绝投递一条可见 `pi-goal-review` 消息；续跑使用 `display: false` 的 custom message。
- 启动确认、替换确认、objective 输入使用宿主原生 dialog（confirm/editor）。

## 6. 已记录的可逆默认决策

1. acceptance 在 v1 等于 objective（显式验收编辑留待真实需求）；模型没有修改入口。
2. 审查设置只在 `start` 时固化；resume 不补满额度，也不重新读取 review 开关。
3. 人类新输入不自动暂停 run；续跑只在 settle 且无 pending message 时发生（不劫持用户回合）。
4. 审查 child 固定后台运行，不使用 panel；审查结果不进入父对话（拒绝反馈除外）。
5. 新 session 的第一条消息之前目标只存在于内存 branch；这是 Pi 的 session 文件语义，goal 以 `Durability:` 明示，不伪造持久化。
6. 清理使用 provider 的既有 bounded stop，不新增全局锁；close 一开始就视为未确认，失败或进行中都会阻塞新授权，直到重试确认。
7. child 会话检测使用 pi-subagents 的 `PI_SUBAGENTS_CHILD_ID` 环境契约；provider 若改名需同步本常量（已在 provider 侧记录为公共环境契约）。

## 7. 测试范围

- 快照：非法数据拒绝、最新 entry 损坏进入 recovery 且不回退、branch 以已提交 entry 为权威。
- run：start 写盘失败不启动；pause/clear/替换先 abort；迟到 boundary 不再续跑；resume 不补满；额度耗尽暂停；工具无 run 报错；tool signal abort 立即撤销。
- boundary：assistant-final（`canContinue=false`）仍提议一次、已有 continue/pending message 不覆盖、draft 未提交不改变事实。
- 审查：approve/reject/inconclusive/stale/late、反馈交付前拒绝新的 complete、交付后第二次尝试使用新 scope、dispatch 失败在 run 结束后不污染新目标、拒绝在 await 后重查、provider 缺席报错。
- ownership：spawn 前登记、非 owner send/stop/delegate 被拒、report 路由、close 幂等、停止失败保留并阻塞、重试确认后恢复。
- 清理：失败在 `restore` 后仍可见并阻塞 start/resume，`retryCleanup` 确认后恢复；close 悬而未决时 resume 被拒，释放并确认后才授权。
- clear：review child close 悬而未决时进入 tree 导航并 restore 另一 goal，释放 close 后 clear 被拒绝，目标 branch 未写入 cleared。
- 审查反馈：真实 AgentSession streaming 中 reviewer 拒绝，pending 不消耗额外 continuation；boundary 提交恰好一条可见 `pi-goal-review` 并继续请求，预算停在 1/1，随后因预算耗尽暂停。
- later boundary handler 在反馈 draft 之后 pause：可见反馈已提交，但不再开始第三次 provider 请求。
- boundary 提交失败（invalid entry）：不提交反馈、不静默 ACK，显式 pause 并报告 `review feedback could not be delivered`。
- 显式 pause 会丢弃 pending feedback 且不增加 continuation。
- late rejection：父操作 settle 后才拒绝时，goal 显式 pause，零 `pi-goal-review` 消息、零额外 provider 请求；resume kickoff 包含 findings。
- 宿主交接：真实 AgentSession + 停滞 provider 的 streaming 下 pause→resume，旧 aborted settlement 不暂停替代 run；deferred replacement 在 `restore` 后不写入目标 branch。
- 陈旧 kickoff：真实 AgentSession 中，pause/clear/tree 导航在 deferred kickoff 执行前撤销 run 时，`agent_start` 取消该 operation（产生一条被中止的 assistant 记录），provider 调用次数不增加；替代 run 不被暂停。
- 无模型：真实 AgentSession 没有选中模型时 `/goal start` 不写快照、`/goal resume` 保持 paused；交接后模型消失时同样拒绝。
- 投递：另一 channel 先注册时，过期的 Goal 投递在 `hasPending` 被剪除，最终 `triggerTurn` 交给有效的生产者。
- 集成（真实 SessionManager + 真实 hook 注册）：start→kickoff、boundary 续跑、tree 导航前撤销、首条消息前后的持久化差异、child 会话不注册 runtime。
- 设置：缺失文件用默认；非法 JSON/字段报错，不静默 review=false。
- UI：状态文本窄/宽渲染与 ANSI 安全（沿用现有 Text 组件）。
