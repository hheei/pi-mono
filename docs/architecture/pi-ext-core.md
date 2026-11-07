# pi-ext-core 架构提案

## 状态

已全面实现：`@hheei/pi-ext-core` 提供基础会话生命周期、Service Registry、ExtensionPoint、
BackgroundDelivery 后台交付协调、JSON settings 传输、工具展示数据契约（`ToolPresentation`）与
optional-tools 提示段落、全屏 Custom Surface 与 Extension Page Router、挂件（Widgets）与编辑器状态合成器、
模型与思考深度选择器、上下文用量估算器、响应性能遥测底栏，以及无副作用的跨包通用工具函数集。
具体工具的注册、激活与装配由 Pi 原生 `pi.registerTool`（`exposure` / `defaultActive`）与各 tool owner 的 `getActiveTools` / `setActiveTools` 拥有；
工具渲染框架由 `@hheei/pi-ext-ui` 的 ToolView 拥有。

维护者与 consumers 的开发约定见 [pi-ext-core 开发约定](../development/pi-ext-core.md)。

## 目标

`@hheei/pi-ext-core` 是独立 `pi-<name>` extension 的最小协调依赖。它提供：

- 以同一 Pi runtime 为范围的 identity；
- session start/shutdown 生命周期注册和幂等 cleanup；
- 1:1 独占 Service 的注册、查询和可取消等待；
- 1:N ExtensionPoint 的 hook 注册和消费；
- Pi global/project settings JSON 的无 policy 文件 transport；
- 取消、revision 和 async ownership 所需的通用基础能力。

core 本身不是 Pi extension：没有 `pi.extensions`、命令、tool 注册、renderer 注册、timer 或
listener。导入 package 没有副作用。只有 extension 显式调用注册 API 后，core 才创建
对应 runtime state 或订阅 Pi lifecycle。因此未安装或未使用子包时，core 不影响 Pi
runtime 的性能或界面。

## 非目标

已实现 v1 不提供下列行为：

- Settings policy、feature-owned schema/content、UI、Settings host command、model selection；
- 具体 feature 的业务状态、持久化和 UI；
- 通用 event bus、RPC 框架或自动 discovery；
- 对旧 aggregate API 的兼容 adapter。

这些能力只有在能形成有明确价值、feature-neutral 的中间层 API 时，才以单独提案考虑；consumer
数量不是硬门槛。提案必须限定使用范围，不能把某个 extension 的 policy、业务 state、schema 或 UI
下沉到 core。

已批准的限定例外：ext-core 提供 global Extension page router 与 feature-neutral TUI host、JSON settings file
transport 与 provider registry、纯 `ToolPresentation` 展示契约与 optional-tools prompt 段落，以及 slash command
的 subcommand 参数补全匹配 helper。[TUI 宿主架构](tui.md) 与
[ADR 0007](../adr/0007-core-json-settings-substrate.md) 分别限制 UI host 和 settings transport。进程内 subagent
coordinator 已删除；managed tool 与 Loadout resource registration 已删除，工具注册与激活归 Pi host 与各 tool
owner（[Loadout 架构](loadout.md) 记录了这次退役）。ext-core 不接管 tool activation policy、page content、Settings policy、
feature-owned schema/content、agent/config/delivery policy 或 clipboard policy。

## Pi 集成边界

Pi extension 的公共入口是 `ExtensionAPI`。独立 extension 在同一 Pi runtime 中获得不同的
`ExtensionAPI` facade，并通过共享 `pi.events` 协作；跨 extension 的 core registry 因此仍以
runtime identity 存放在延迟创建的 `WeakMap` 中，不长期持有 session 或 extension instance。

Pi 0.87 的 `pi.on()` 返回 disposer，session replacement 与 `/reload` 会使旧 runtime 失效并
移除其 handler。core lifecycle 直接依赖这个宿主契约，不再维护跨 reload generation 或让旧
listener 留在进程中；stable feature key 只用于公开 contract 的身份和诊断。

## 第一阶段公开接口

根入口 `@hheei/pi-ext-core` 只导出实际 consumer 需要的类型与函数，不允许 deep
import。已实现 v1 包含 lifecycle、Service、ExtensionPoint、cleanup、JSON settings/provider registry、
custom surface runtime、Extension page router API、Pi context usage 解析、`ToolPresentation` 展示契约与 optional-tools
prompt 段落，以及 subcommand 参数补全匹配。Loadout 细节见 [Loadout 架构](loadout.md)。进程内 subagent coordinator
已删除，见 [Subagent 执行架构](subagents.md)。

### Subcommand 参数补全

Pi 把 `registerCommand(name, options)` 的 `options.getArgumentCompletions(argumentPrefix)` 直接交给 TUI
补全器：只有 `/cmd <args>` 形态触发，`argumentPrefix` 是第一个空格之后的完整文本，接受建议后整段参数
文本被替换为 `item.value`（宿主实现在 `@earendil-works/pi-tui` 的 `CombinedAutocompleteProvider`）。
`argumentHint` 只有内置命令和 prompt template 有，extension 拿不到，因此命令 description 仍需自带
子命令清单。

`subcommandCompletions(subcommands, options?)` 只负责这一层的**匹配**：按空白切分
`argumentPrefix`，第一个 token 尚未完成时补全 subcommand；已完成时读取 `options.args[verb]` 这张固定
参数表继续补全。匹配忽略大小写（与各 extension 在 handler 里忽略大小写地解析 verb 一致），返回
`null` 表示没有建议，此时 TUI 不做任何替换。

边界：

- 具体有哪些 subcommand、每个 subcommand 的参数、命令策略与执行仍属于 concrete extension。core 不注册
  命令、不持有状态、不读 `ExtensionContext`、不安装 listener，也不提供动态候选（运行时 id、page id
  等由 extension 自己实现该回调）。
- 建议的 `value` 始终是**完整参数文本**（例如 `view full`），因为 host 替换的是整段参数而不是最后一个
  token；`label` 只显示最后的 token。

### Pi context usage

`estimateEntryTokens(entry)` 与 `estimateTextTokens(text)` 是纯估算函数，不读 `ExtensionContext`、
不持有 session state、也不决定 historian / compaction policy。

`estimateEntryTokens` 对 Pi session branch entry 给出 token 数：`message` 走 host 的
`estimateTokens`，`custom_message` 的 string 或 text block 与 `branch_summary` 走
`estimateTextTokens`，其他 type 为 0。`estimateTextTokens` 是 `ceil(length / 4)` 的结构化
fallback，不是模型 tokenizer；需要精度的 consumer 自己接 tokenizer。

live 上下文读数仍由 consumer 从 Pi `getContextUsage()` 读取；core 不解释它，也不提供 prefix
或水位判定。

### Extension JSON Settings

extension 配置与 Pi host 原生配置分离：global 文件固定为 `<agentDir>/ext_settings.json`，project
override 固定为 `<cwd>/.pi/ext_settings.json`。extension 不得把自己的字段写入 Pi 的 `settings.json`。

`defaultExtensionSettingsPaths()` 返回这两个路径。`readMergedJsonSettingsSection()` 一次读取两层的同名
object key，并同时返回未解释的 `global`、`project` 与递归合并后的 `merged`。plain object 按 key
递归合并；scalar、array、`null` 或类型不一致时 project value 覆盖 global value。

文件 root 不是 package namespace map。Settings provider 注册自己的全局唯一 group ID；拥有非 Settings UI
配置的 extension 使用 `SettingsRegistry.registerGroups()` 预留同一个 collision domain 中的顶层 key。group/key 直接
成为 `ext_settings.json` 的顶层属性。不同 package 可以自由选择 ID，但重复 ID 在注册时立即失败，不由 UI
自动改名，也不会以 package 名再包一层。

调用 `sourceOf(["nested", "key"])` 可定位 effective value 的来源：`global`、`project`、`mixed` 或
`undefined`。`mixed` 只表示该 object 的有效 descendants 来自两层；调用者应继续查询具体 leaf path。key path
是 string array，不解析 dotted key，避免配置键名歧义。

底层 JSON API 不验证 key fields，也不决定某个 project override 是否可信。需要 security/trust 限制的
consumer 必须读取 raw layers 并自行应用 policy；例如 project 不得选择 user-paid model 时，consumer
不能直接把 `merged` 当作 active configuration。

### Settings 值与 List Field

`SettingValue` 可表示 scalar primitive、`null` 或 `readonly string[]`。`list` 是明确的 string-list field type：storage 保留 JSON array，不以逗号或换行编码到 text field。它不预先泛化为 mixed-value container；numeric、boolean 或 enum collections 只有在出现独立 consumer 后才定义自己的 field type。

core 只验证 settings transport 所需的 JSON value shape，并提供 provider schema 所需的 list type。具体 list 项语义、最大数量、authorization 与 live/reload policy 属于 concrete extension。`pi-settings` 作为 host 为 list 提供 nested multi-row editor；core 不拥有页面、keyboard policy 或 feature list content。

### 共享工具函数

core 还承载一批小而稳定的工具函数。它们进入 core 的唯一理由是消除跨包重复实现：每个都至少有
两个真实 consumer，且不引入状态、生命周期或策略。

- `runCommand()` / `shellQuote()`：一次性进程执行（argv 数组、可选 stdin、timeout、stdout 上限、
  `AbortSignal`）。长驻流式子进程（bash job runner、eval kernel、subagent runner）不走它。
- `errorMessage()` / `abortError()` / `throwIfAborted()`：错误文本与取消语义的唯一来源；取消一律表现为
  name 为 `AbortError` 的 Error。
- `agentResultText()` / `formatDuration()`：tool result 的文本提取与时长格式化（缩短到 1 秒以内用
  `Nms`，否则 `N.Ns`）。
- `isRecord()`：唯一 plain-object narrowing guard。数组不满足它，避免包内自行实现时出现
  “数组也是 record” 的分歧。
- `expandHome()`：展开配置中的 `~` / `~/…`；caller 需要绝对路径时自行 resolve。
- `createRenderThrottle()`：两层渲染窗口的唯一实现。快路径不经过它（交互与离散状态直接调用
  `requestRender()` / `setStatus()`，交给 Pi 的 16ms 帧合并）；只在「一个事件重建整份快照」的
  流式路径上使用，窗口为 100ms。它只决定何时重建，不持有快照：回调读取当前状态。leading 立即
  绘制、窗口内合并、trailing 保底。`dispose()` 幂等且是正确性要求：工具返回的 result 是终态唯一
  来源，迟到的绘制会改写已结算结果。详见 [render-throttling.md](./render-throttling.md)。
- `truncateWithSpill()`：工具输出上限的唯一实现。所有工具共用一个预算：
  `DEFAULT_MAX_TOKENS = 5000`（按 `CHARS_PER_TOKEN = 4` 换算为 20KB）。超限**从不拒绝调用**：
  保留**头部与尾部**（两端都是模型要行动的依据：头部说明输出是什么，尾部带错误或最终状态），
  中间换成 `… N lines / MKB omitted …` 标记，完整文本写到 `pi-output/` 下的单个共享目录，
  路径附在结果里。截断只在字符边界发生，不会切开 UTF-8 序列。
  `limitsForCalls()` 按本次结果背后的工具调用数放大预算（1 / 1.5 / 2 / 3 倍，
  `MAX_BUDGET_MULTIPLIER` 封顶）：一次跑了八个嵌套调用的结果本来就有八件东西要给模型看。
  文件名是短前缀加递增序号（`py-1.txt`），重启后接着编号。
  `fitsOutputBudget()` 让常见路径保持同步，不为一次不会发生的落盘而 `await`。
- `registerToolOutputCap()`：每个工具结果都要经过的共享封顶。它让“某个工具忘了自己的上限”
  不再能淹没 context。已经带 `[Full output:` 标记的结果会被放过：它已按自己能说明的预算
  截断过（如 python_eval 的多调用倍率），再按单调用宽度切一次会抹掉那份依据。含图片的结果也不动，
  因为它的文字是说明而非载荷。
- `setPromptSection()`：写入或删除 `event.systemPromptOptions.sections` 中的一个具名 section。Pi 按
  section diff 每个 request，所以扩展注入 prompt 时不得把文本拼到 `event.systemPrompt` 上：拼接会让
  Pi 每轮重发整段 prompt，也让注入内容无法被单独替换。section 名为小写标识符（可含数字、`-`、`_`），
  传 `undefined` 或全空白即删除。

这些函数保持无副作用：只依赖 node 标准库与 type-only 的 host 类型，不读取 session、settings、
terminal 或 registry。需要 strategy、policy、持久化或渲染的能力仍归 concrete extension。

### Lifecycle

extension 通过 stable key 注册 session-scoped feature。core 串行 start/shutdown，启动
失败时清理已创建资源；Pi runtime replacement 负责淘汰旧 handler。

stable key 必须是 extension 的 package name，例如 `@hheei/pi-example`。不得使用
临时字符串或自动生成值；key 用于身份校验和诊断。

```ts
registerExtensionLifecycle(pi, {
	key: "pi-example",
	start(context) {
		context.resources.add("example", () => {});
	},
});
```

`start()` 使用 `context.resources` 注册 cleanup。cleanup 必须幂等；它负责该 feature
创建的 timer、listener、process、subscription 和 async operation 的取消。

### Service

Service 是 1:1 的核心资源，例如资料库连接、全局路由或唯一的弹出视窗管理器。一个
runtime 中每个 service ID 保留第一个 provider；后续 provider 不替换它。

consumer 可以同步查询，也可以在自己的 start lifecycle 建立非阻塞 continuation 等待
provider：

```ts
void waitForService(context.pi, databaseService, { signal: context.signal })
	.then((database) => startConsumer(database))
	.catch((error: unknown) => handleConsumerStartupError(error));
```

`signal` 是必填参数。若 service 已存在，`waitForService()` 立即 resolve；若 `signal`
abort，它必须 reject 并移除 waiter；session shutdown 时未完成的 waiter 也必须停止。
Pi 会串行 await `session_start` handler，因此 `start()` 不得直接 await 此 Promise，否则
可能阻塞排在后面的 provider。consumer 自己决定 deadline、等待失败后的降级或后续初始化，
不允许 core 无限等待。core 为该 Promise 附加 no-op rejection observer，防止 caller 尚未
处理时触发 host-level unhandled rejection；公开 Promise 的 reject 语义不变。

Service key 只提供 TypeScript generic 标记，没有 runtime schema 或跨 package validation。
独立 package 用相同 ID 时，类型与语义兼容由单一开发者的约定负责。

公开 API 以本地声明的 generic key 为参数：

```ts
const databaseService = createServiceKey<Database>("@hheei/pi-database/service");

const provided = provideService(context, databaseService, connection);
getService(pi, databaseService);
await waitForService(pi, databaseService, { signal });
```

provider 和 consumer 可以各自用同一 ID 建立 key。`provideService()` 接收 lifecycle
context，不返回手动 disposer；当前 provider 的 resource registry 在 failed startup cleanup
或 session shutdown 时移除 service。Service 在 session-ready 后不得中途移除。若已有
provider，函数返回 `false`，保留 first provider，后注册者自行 no-op。

### ExtensionPoint

ExtensionPoint 用于可扩充的 1:N 行为。point owner 只能有一个，用来声明该 point 的
语义和消费 hook 的方式；其他 extension 可为同一 point 注册多个 hook。一个 hook 的
disposer 只移除自己的 registration generation。

典型场景是工具、路由或 UI surface 的可选 feature。ExtensionPoint 不等同于通用 event
bus：hook 只在 point owner 明确定义的调用位置运行，不能广播任意事件、读写其他
extension 的状态或提供同步 RPC。

owner 的 subscription 先接收已有 hook，再动态接收 add/remove。subscription 接受
必填的 `AbortSignal`，并在 session shutdown 时自动清理。abort 后 core 立即解绑，不能再
调用 owner callback。hook payload 使用 generic key 的 TypeScript 类型约束；独立 package
间的兼容性由约定负责。

hook add 先注册再调用 `onAdd`；hook remove 先移除再调用 `onRemove`。callback 的同步或
async 异常不做 rollback、failure state 或自动重试。hook registration 立即返回 handle；
其 `ready` Promise 反映 `onAdd` 的成功或失败，使 caller 可自行 catch，同时仍持有
`dispose`。core 创建 `ready` 时会附加内部 no-op rejection observer，避免 caller 尚未
await/catch 时触发 host-level unhandled rejection；该 observer 不改变公开 `ready` 的 reject
结果。hook 注册不应包含容易失败的复杂安装逻辑；需要该逻辑的 owner 自行 catch 并处理。

公开 API 将是：

```ts
const point = createExtensionPointKey<FormatterHook>("@hheei/pi-tools/formatter");

const owner = openExtensionPoint(pi, point, { signal, onAdd, onRemove });
await owner.ready;

const hookRegistration = registerExtensionHook(pi, point, hook);
await hookRegistration.ready;
await hookRegistration.dispose();
```

`openExtensionPoint()` 是唯一 owner registration，并先安装已存在的 hook；
`registerExtensionHook()` 在 owner 已打开时建立 `ready`。两者都返回 handle；handle 的
async `dispose()` 只清理自己的 registration generation。

### 高吞吐执行点

零拷贝 context 是业务 ExtensionPoint owner 的职责，而不是 `pi-ext-core` 的通用状态。
例如工具 extension 可以建立一个 context object，并把同一 object reference 传给已筛选的
hook；core 不 deep clone、spread 或合并该 object。

context 在建立时必须一次定义所有固定字段。核心资料在 TypeScript 层标为 `readonly`；
二进制 buffer 的实际写入权仍由 owner 的接口约定控制，不能把 `readonly` 误当作 runtime
immutable security boundary。extension 专属中间状态放在注册期建立的私有 mount registry，
不得动态新增或删除 context property，也不得使用 `any`。输出使用 owner 建立的稳定 array
buffer，并由 hook append；owner 负责定义结果类型和 flush 时机。

为了避免每次执行逐个调用 `canHandle()`，hook 在 registration 时声明稳定的 `topics`。
owner 以 topic 索引 hook；执行时只取得匹配 topic 的 hook。必要时，匹配后的 hook
可以有第二层 `canHandle(meta)`，但它不用于取代 topic index。hook 的 `execute(context)`
接收同一 context reference，并不得新增、删除或替换其顶层字段。

该机制保持 hot-path object shape 稳定、避免无关 hook 调用，并允许 owner 以常数额外状态
传递多个 extension 的结果。具体工具 context、topic 名称、mount state、输出格式和 topic
index 都留在该工具 package，不能提升为 core 产品语义。首个工具实现只需遵守本节规则；
有实际重复后才经用户确认抽取 generic `ExecutionPoint`。

Service 和 ExtensionPoint 的 key 均使用稳定、namespaced string ID。双方从各自 generic
key 获取 TypeScript type，独立 package 不建立互相 import。

### Reload 边界

Pi `/reload` 会先发出 `session_shutdown`，重建 extension runner，再发出
`session_start`。Service provider 必须只依赖这个完整 lifecycle 边界完成清理与重新注册；
v1 不提供单一 Service 的 HMR 覆盖、replace 或强制后门。reload 后第一个 provider 再次
获胜，符合 first-provider-wins 规则。

### Cleanup Ownership

lifecycle context 提供一个小型 disposer registry，供 feature 把资源 cleanup 集中在
自己的 session owner 下。registry 以逆序 cleanup，继续尝试其余 disposer，并将失败
汇总给调用者。它不创建后台工作或全局 timer。

## 并发与错误规则

- 每个 lifecycle transition 串行；不得并行 start 与 shutdown。
- async operation 接受 `AbortSignal` 时必须传入；session replacement 后的 late result
  必须用 runtime revision 拒绝。
- Service duplicate provider 保留 first provider 并返回 `false`；ExtensionPoint 重复 owner
  仍立即抛错。
- Service waiter abort、shutdown 或 resolve 后必须从 registry 移除，不能遗留 listener。
- lifecycle `start()` 不得 await `waitForService()`；consumer 以 non-blocking continuation
  等待晚到 provider。
- Service 只允许 provider lifecycle 的 failed-start cleanup 或 shutdown 移除；已 ready 的
  provider 不得中途 dispose。
- ExtensionPoint subscription 交付已有 hook 与动态 add/remove；其 `AbortSignal` 必须
  解绑 subscription。
- core 不保存 `ExtensionContext`、component 或 session object 到 process-global state。

## 跨包兼容策略

独立 package 不直接 import。Service 与 ExtensionPoint 是 core 提供的高层兼容模型，
不是 feature-specific contract package。出现无法由这两种模型表达的真实兼容需求时，先
由更低层 package 提供兼容实现；该形态在多个 package 中被证明通用后，才向用户提出
提升 core API。不确定时，先向用户说明并研究可行架构。

## Package 解析策略

Pi 的 managed npm install 会把 extension 及其 production dependencies 安装到同一 scope
root；因此建议每个 `pi-<name>` 把 `@hheei/pi-ext-core` 声明为 direct `dependencies`，
并在 bundle 时 externalize。core 不声明 `pi.extensions`，不会被 Pi 当作 extension 加载。

不同 package version 或 local development 仍可能让多个 core module instance 同时存在。
runtime registry 因此必须通过 `globalThis` 的稳定 symbol name 共享，不能仅依赖 ESM module
singleton。

## 完整公开 API 目录

`@hheei/pi-ext-core` 根入口为所有公开能力的单一收敛点。所有 API 按以下功能域正交组织：

### 1. 生命周期与错误处理 (Lifecycle & Errors)
- `registerExtensionLifecycle(pi, options)`: 注册以 package name 为稳定 key 的扩展生命周期，提供幂等清理与 `context.signal`。可选 `end(reason)` 在信号中止与 disposer 运行之前收到 Pi 的 `session_shutdown` reason，用于让 scope 自己决定是否把某个资源交给下一次 `start` 接管（当前唯一使用者是 pi-bg-bash 的 reload 保留）。
- `getGlobalState(name, create)`: 以 `Symbol.for` 在进程级共享一个 registry；extension reload 会重新求值模块，需要跨 reload 存活的状态放这里，而不是模块级变量。
- `DisposerRegistry`: 逆序安全清理闭包容器。
- `errorMessage(error)`: 安全字符串化未知异常。
- `abortError(message?)`: 构造规范 `AbortError`。
- `throwIfAborted(signal)`: 检查中止信号并快速抛出。

### 2. 跨扩展服务协作 (Service Registry)
- `createServiceKey<T>(id)`: 声明强类型服务 Key。
- `provideService(context, key, value)`: 注册 1:1 服务实例（first-provider-wins，生命周期结束自动清理）。
- `getService(pi, key)`: 同步读取当前可用服务实例。
- `waitForService(pi, key, options?)`: 异步等待服务就绪（支持非阻塞 continuation 与超时/中止）。
- `MEMORY_COMPACTOR_SERVICE_KEY`: 预置会话即时内存压缩服务 Key。

### 3. 后台交付协调 (BackgroundDelivery)
- `createBackgroundDelivery()` / `getBackgroundDelivery(pi)`：协调 producer 拥有的交付通道，不拥有执行状态或内容。
- `BackgroundDeliveryChannel`：提供 `isIdle`、`hasPending`、`flush(triggerTurn)`；注册返回 `request()` 与 `dispose()`。
- 每个 microtask 批次中，busy parent 的消息通过 steer 进入下一步，idle parent 只由最后一个有效通道请求新回合。不等待其他执行结束，重入时检查通道是否仍有效。
- BashJobs 与 SubagentManager 各自管理执行，不通过任务服务、通用队列或状态镜像耦合。

### 4. 扩展点与动态钩子 (Extension Points)
- `createExtensionPointKey(id)`: 声明扩展点 Key。
- `registerExtensionHook(context, key, hook)`: 注册 1:N 动态钩子。
- `openExtensionPoint(pi, key, options?)`: 开放并消费挂载的钩子集。

### 5. 工具展示与提示段落 (Tool Presentation & Prompt Sections)
- `ToolPresentation` / `TextToolPresentation` / `DiffToolPresentation`: 工具拥有的纯数据展示契约（`summary`、`request`、`output`、`collapsedRows`、`copy`、diff 字段）。它不含 ANSI、Component 或闭包。
- `createToolPresentationRenderers(pi, title, provider)`: 生成 Pi 原生 `ToolRenderers`，把 provider 与 `renderCall` 用 WeakMap 关联；未加载 `pi-ext-ui` 时这条路径自己就是可用的 Text 渲染。
- `getToolPresentationProvider(renderers)` / `getRegisteredToolPresentationProvider(pi, name)`: 解析已登记的 provider（含嵌套 codemode 调用），只持有 WeakRef，不保留 tool definition。
- `setOptionalToolBullet(sections, key, bullet)` / `setSectionBullet` / `setPromptSection`: 维护结构化 system prompt 的 `optional_tools` 段落与固定 preamble，供 deferred 工具族介绍自己。
- 工具注册、激活与 inventory 属于 Pi host 与各 tool owner：`pi.registerTool({ exposure: "deferred", defaultActive: false })` 是唯一注册入口，`getActiveTools` / `setActiveTools` 是唯一的 active 集合，ext-core 不再提供 managed tool 或 loadout resource 注册层。

### 6. TUI 视图路由与自定义界面 (Page Router & Surfaces)
- `openExtensionPageRouter(ctx, options)`: 打开设置多页面路由宿主。
- `registerExtensionPage(registration)`: 注册设置子页面。
- `openTuiSurface(ctx, options)`: 打开全屏独立 TUI Surface。
- `TuiSurfaceQueueFullError`: 并发排队异常。

### 7. 挂件 (Widgets)
- `registerWidget(pi, placement, widget)`: 在编辑器上下方挂载展示组件。
- `suspendWidgets(pi)`: 临时挂起所有活动挂件。

### 8. 配置持久化与存储 (JSON Settings Transport)
- `readJsonSettingsRoot(path)` / `updateJsonSettingsRoot(path, updater)`: JSON 配置根对象原子读写。
- `readJsonSettingsSection(path, sectionKey)`: 单 section 读取。
- `readMergedJsonSettingsSection(paths, sectionKey)`: 全局与项目两层合并读取与来源标注。
- `defaultExtensionSettingsPaths(env?, cwd?)`: 默认路径解析。
- `createJsonSettingsStorage(options)`: 强类型配置存储适配器。
- `registerSettings(pi, provider)` / `getRuntimeSettingsRegistry`: 配置注册与查询。

### 9. 模型选择与思考深度 (Model Selection & Thinking)
- `modelSelectionOptions(models)`: 生成下拉选择列表。
- `authenticatedModelSelectionOptions(models, authRegistry)`: 过滤具备鉴权的模型。
- `createModelSelectionField(options)`: 创建交互式模型选择字段。
- `clampThinkingLevel(level)`: 收敛思考级别。
- `thinkingGlyph(level)`: 获取级别指示符号。

### 10. 上下文用量与 Token 估算 (Context Usage & Token Estimation)
- `estimateEntryTokens(entry)`: 估算一个 Pi session branch entry 的 token 数。
- `estimateTextTokens(text)`: 纯文本字符 token 估算（`ceil(length / 4)`）。

### 11. 进程内子代理协调器（已移除）

`startSubagent`、`lookupSubagent`、`redeliverTask`、`configureSubagentCoordinator`、`ensureSubagentCoordinator` 已删除。一次性补全由调用方使用 `completeSimple`。可重连 child 属于 `pi-subagents`。

### 12. 响应遥测与编辑器底轨 (Response Telemetry & Editor Rail)
- `createResponseStatusFeature(pi, options)`: 模型性能遥测组件。
- `formatTelemetryStatus(metrics)`: 遥测文本格式化。
- `formatCompactNumber(value)` / `formatRate(value)` / `formatDurationColor(durationMs, theme)`: 遥测数值、速率与耗时着色格式化。
- `TELEMETRY_DISMISS_DELAY_MS`: 遥测状态自动消失的延迟。

### 13. 通用辅助工具 (Utilities)
- `runCommand(command, args, options?)`: 一次性安全进程执行。
- `shellQuote(str)`: POSIX shell 转义。
- `isSubagentProcess(env?)`: 子进程环境探针。
- `expandHome(filepath, env?)`: 家目录展开。
- `splitSubcommand(text)` / `subcommandCompletions(subcommands, options?)`: 斜杠命令双层子命令自动补全。
- `fitRow(text, width)`: ANSI 彩色单行文本等宽截断或填充。
- `extractShellCommands(command)` / `isSearchOnlyCommand(command)` / `SEARCH_TIMEOUT_MS` / `SEARCH_BASH_TIMEOUT_SECONDS`: 从 bash 调用中识别只读搜索命令并给出其超时。
- `BashOutputSink` / `DEFAULT_VISIBLE_TAIL_BYTES`: 流式 bash 输出的尾部缓冲。
- `defaultShellPath(env?)`: 解析默认 shell 可执行文件。
- `panelScrollbar(total, top, rows)`: 视口行到滚动轨单元格的共享几何。
- `pad` / `WIDE_COLUMNS` / `PANEL_ROWS` / `STACKED_LIST_ROWS` / `LIST_HINT_ROWS` / `calculateScrollTop(...)`: 双栏与堆叠面板的共享布局常量与计算。
- `isRecord(value)`: 非空 Plain Object 严格守卫。
- `escapeXml(str)`: XML 字符转义。
- `textToolResult(text, isError?)` / `agentResultText(result)` / `formatDuration(ms)`: 工具结果与耗时格式化。
- `capToolResult(pi, result)` / `outputPrefixFor(...)`: 工具结果的共享封顶与 Output 前缀。
- `createOptionalToolRenderers(...)` / `getRegisteredToolRenderers(pi, name)` / `hasOptionalToolRenderers(...)` / `toolRendererPoint`: 可选专用 renderer 的注册与解析点。
- `messageViewPoint` / `readMessageView(...)`: transcript notice 的 MessageView 挂载点。

## 包和测试布局

```text
packages/pi-ext-core/
  package.json
  src/
    background-delivery.ts
    command-completions.ts
    context-usage.ts
    custom-surface.ts
    disposer-registry.ts
    errors.ts
    extension-point.ts
    global-state.ts
    index.ts
    json-settings.ts
    lifecycle.ts
    message-view-point.ts
    model-selection.ts
    output-tail.ts
    page-router.ts
    panel-layout.ts
    panel-scrollbar.ts
    paths.ts
    process.ts
    prompt-section.ts
    record.ts
    render-throttle.ts
    response-status.ts
    row-fit.ts
    runtime-identity.ts
    search-command.ts
    service.ts
    settings.ts
    shell.ts
    text.ts
    tool-output-cap.ts
    tool-output.ts
    tool-presentation.ts
    tool-renderer-point.ts
    tool-result.ts
    widgets.ts
```

已实现 API 先建立公开类型与函数签名，再写 focused tests，最后实现。不为尚未存在的 UI 或 settings
behavior 预建测试。

## 已确认决策

1. v1 实现 runtime identity、lifecycle、Service、ExtensionPoint 和 disposer registry；
   不迁移任何旧 aggregate 专属 API。
2. Service duplicate provider 保留 first provider 并返回 `false`；ExtensionPoint owner
   保持 1:1 fail-fast，hook 是 1:N registration。
3. Service consumer 可以用带 `AbortSignal` 的 Promise 等待 provider，避免加载顺序
   导致的启动脆弱性。
4. lifecycle stable key 使用 extension 的 package name。
5. ExtensionPoint owner 动态接收已有与晚注册的 hook；subscription 使用
   必填的 `AbortSignal` 清理。
6. Service value 与 ExtensionPoint hook payload 只使用 TypeScript generic key 约束；
   不做 runtime validation，兼容性由单一开发者约定负责。
7. hook add/remove 不做事务或 rollback；registration handle 的 `ready` 反映 callback
   error，caller 仍可 `dispose`。
8. feature package 将 core 声明为 direct production dependency 并 externalize；runtime
   registry 使用 stable `globalThis` symbol 跨重复 module instance 共享。
9. breaking contract 不做 semver negotiation，由单一开发者依 TypeScript 约定维护兼容。
11. 高吞吐工具以 registration-time topic index 筛选 hook；context 由业务 owner
    零拷贝建立，使用固定 shape 和私有 mount registry。v1 不抽取 generic
    `ExecutionPoint`；有实际重复后才重新提案。
12. ExtensionPoint owner subscription 的 `AbortSignal` 必填；abort 后不得再交付 hook。
13. Service provider 只可在 failed-start cleanup 或 session shutdown 移除；
    `provideService()` 由 lifecycle context 代管 cleanup，不暴露手动 disposer。
14. core 为每个 `ready` 附加 no-op rejection observer；公开 Promise 的成功或失败语义不变。
15. v1 只支持 Pi 完整 reload lifecycle，不提供单一 Service HMR replace 后门。
16. Pi 串行 session start 下，consumer 不得 await `waitForService()`；改以自行处理的
    non-blocking continuation 等待 provider。
17. `estimateEntryTokens()` 只估算单个 branch entry；不读取 Pi live usage，也不解释 consumer 自己持久化的 context pressure 或阈值。
