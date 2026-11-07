# Bash 执行记录恢复（方案 A）

状态：用户已批准。恢复记录与通知，不恢复执行。当前行为由本文与 `background-tasks.md` 共同定义。

## 目标与边界

Shell 命令默认不是 rerun-safe，文件修改、网络请求等副作用无法由账本撤销。extension reload 不停止执行：registry、输出收集、timeout 与账本锁被保留，下一次 `session_start` 接管同一 registry（reload 会重新求值模块，所以这份状态放在进程级 carried 表中）。resume、切换 session 或父进程崩溃后，只恢复同一 session 的执行事实、日志位置与未记录的报告。没有可靠终态时报告 `unknown`，说明命令可能未启动、已经部分执行、仍在运行或已结束，交给 agent 检查副作用并决定下一步。恢复路径绝不 spawn、接管旧 PID、发送信号或自动重跑；重新执行只能来自新的显式工具调用，生成新 ID。

不引入独立 runner、跨崩溃继续执行保证、通用任务注册表或跨 extension 依赖。前台 Bash 继续遵循原 tool call 的取消契约，不登记恢复记录。

## Ownership 与控制流

pi-bg-bash 的 BashJobRegistry 继续拥有当前进程、timeout、清理、输出和执行记录。内部 BashExecutionLedger 保存后台执行快照；调用方不操作 PID 或修补状态。BackgroundDelivery 只协调父会话唤醒；Pi host 的 session JSONL 证明报告已记录，不能证明模型已读。

```text
bg_bash_spawn → durable intent → shell / log → durable result
                                              ↓
session start → restore records → branch receipts → bg-bash-report → agent decides
```

每个 session 在既有日志目录 `tasks/<sessionId>/` 保存 `bash.sqlite`。独立 `bash.sqlite.lock` 使用 SQLite 独占内核锁阻止两个 registry 同时管理同一账本；锁随进程死亡释放。该锁只保护账本 writer，不代表 shell 存活。SQLite 同步提交关键转移，权限为私有；不保存 PID、完整环境或凭据，不按 stdout chunk、模型事件或 heartbeat 写盘。完整输出继续流式写日志。

启动外部 shell 前同步写入意图；停止前记录 stop-intent；退出、输出收集和清理结束后才保存可靠结果。账本写入失败必须可见；启动意图无法保存则禁止启动后台命令。终态无法保存时，当前调度器仍保留已观察到的退出结果并报告持久化失败；后续恢复只能依据磁盘上的证据投影不确定性。写盘失败不等于命令执行失败，也不能以未持久化结果宣称可靠恢复。

恢复时读取全部本 session 执行事实，独立于当前历史分支。已完成记录恢复原结果；未 settled 的记录仅在调度器内投影为 `unknown`，保留命令、cwd、ID、anchor、已有输出与日志路径，标明日志可能不完整。恢复与 tree 核对均只读，不将该判断写回账本。每次恢复重新读取可用日志，避免第一次恢复的暂时错误或输出尾部成为永久结果。没有观察到退出时不虚构 exit code 或真实结束时间。未知记录不可通过 stop 声称已停止，恢复不向旧进程发信号。

## 事实与调度判断

账本保存最后一次同步提交的启动意图、停止意图，以及当前 owner 收集结束时的结果与诊断。`running` 在启动前落盘，只证明准备执行；`stopping` 证明请求过停止，均不证明当前 shell 存活。`settled` 只表示 owner 已结束收集，不等于成功、进程树一定消失或模型已经消费结果。

调度器拥有进程句柄、timeout、清理和内存状态；没有当前 owner 时，将缺少终态的事实投影为 `unknown`。执行结果、资源收集阶段、报告交付彼此独立。资源阶段只在内存中沿 `collecting → draining → released` 前进，避免“已释放但仍在收集”的布尔组合；日志关闭与进程树清理完成后才释放结果。交付状态不写执行账本，以当前 Pi 分支中的真实报告收据为依据。重跑、探测副作用、放弃结果等决策留给调用方，账本不猜测。

## 生命周期与分支

| 事件 | 执行与恢复 |
| --- | --- |
| 父 agent abort / Esc | 后台命令继续，前台依其取消信号停止 |
| bg_bash_stop | 先保存 stop-intent，再清理当前拥有的进程树；取消等待不撤销 stop |
| extension reload | 不停止进程：registry、输出收集、timeout 和账本锁原样保留在进程级 carried 表中，下一次 `session_start` 按 sessionId 接管。carried 表只在 reload 与随后的 start 之间持有这一个 registry |
| 切换 session / 显式 quit | 保留现有清理策略，停止当前拥有的进程并保存结果；清理无法确认则 unknown |
| resume 原 session | 只恢复记录，补交当前分支尚未记录的报告 |
| new / fork | Pi 先关闭原 session，停止其当前拥有的命令并保存结果；新 session 使用独立账本，复制的历史工具 ID 不获得查询或控制权，需 resume 原 session 查证 |
| tree | 不撤销副作用；按启动 anchor 暂停或恢复报告 |
| compaction | 不改变执行归属；从原始分支祖先消息核对交付凭据 |
| 父进程崩溃 / 系统重启 | 缺少可靠终态则 unknown，不探测或接管旧 PID，不自动重跑 |

通知状态为 `pending → submitted → recorded`。`message_end` 只表示报告追加到 session；恢复与切换分支时，依据当前 `getBranch()` 中 `bg-bash-report` 的 job ID 核对凭据。A 分支已记录但 B 未记录时，B 仍需包含原启动 anchor 才能接收；返回 A 不重复报告。compaction 不删除原始祖先消息，不能仅根据模型上下文判断结果未交付。异步 host 拒收可能无法通过 sendMessage 的同步返回观察；tree 是一次明确的重新核对点，无收据的 submitted 报告重新排交，不让旧批次永久占住结果。普通 agent 事件保留 submitted，避免对仍在排队的消息持续重送。无法取消的旧批次若迟到，报告可能重复；跨 SQLite 与 JSONL 不宣称 exactly-once，恢复时以实际消息为准，绝不因此重跑命令。

内存只保留有限的已确认终态；持久账本保留历史执行事实供 get 查询及分支核对，不因内存淘汰而删除恢复依据。活动和未确认结果受准入上限约束。旧版本只有日志、没有可靠执行记录：保留日志，不猜测命令、退出状态或 PID。

## 验证

聚焦覆盖意图落盘后崩溃、退出前后恢复、stop-intent、可靠结果保留、日志缺失、持久化失败阻止启动、并发 writer 拒绝、未知结果不重跑或发信号、分支切换、已记录消息恢复、fork 隔离与清理幂等。真实子进程用例验证进程崩溃释放锁与记录恢复。
