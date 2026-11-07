## 产品约束

- **必须**让重要的读取、命令和编辑可检查。
- **应该**保持基础提示和工具 schema 精简，只在需要时加载技能、参考资料、目录和易变元数据。
- **必须**在 UI 折叠输出时仍保留完整结果，并让敏感、特权、昂贵或需要复杂配置的能力显式 opt-in。
- **应该**用可见、可组合的基础能力构建复杂行为，避免隐藏命令或模式。
- **必须**让 Graphify 的语义提取图完全使用英文：标签、描述、关系名称和社区名称都必须是英文。

**产品原则：**意图清楚，行为可检查，能力可组合。

## 工程约束

- **应该**在检查调用方、持久化、恢复/分叉行为和公共契约后，删除废弃的 API、布局、适配器和兼容层。
- **禁止**为未经确认的需求增加推测性抽象、扩展点、兼容层或配置。
- 先为必要行为建立可运行的端到端路径；package 边界和抽象应根据真实的 ownership、生命周期、并发和公共契约责任来选择。
- **必须**保留验证、取消、清理、并发安全、错误传播、可访问性和数据安全。
- 添加基础设施前，先检查现有实现、依赖、标准/平台 API 和相关上游参考。
- **避免**临时适配器、不必要的依赖、重复的基础设施，以及仅为缩短文件长度而拆分文件。
- **必须**保持与本任务无关的用户修改不变。
- 建立可持续维护的清晰架构；不要为了让本次 diff 最小而牺牲边界、可读性、可测试性或未来演进。代码架构应以长期总复杂度低、责任清楚、符合 repo 既有方向为目标。
- 本次功能先实现必要的可运行路径，但不要因此把本应稳定的公共契约、生命周期、错误处理或数据边界草率地塞进临时代码。
- 修改 TypeScript 前必须阅读 `DESIGN_TS.md`。

## 工具

直接在仓库根目录使用 `pnpm`（系统已安装独立版，无需 `corepack` 或 `npx` 包装）：

```bash
# 自动检查本次改动的文件（自动识别 git 改动并过滤）
pnpm run check:changed

# 自动修复本次改动的文件
pnpm run check:changed:fix

# 按最低足够验证策略自动运行受影响包的检查/构建/测试
pnpm run verify:changed

# 手动指定文件检查或修复
pnpm -w exec biome check <changed-files...>
pnpm -w exec biome check --write <changed-files...>

# 单个或多个测试文件
pnpm exec vitest run <test-paths...>

# 单个 package 的编译检查（该 package 提供 build 脚本时）
pnpm --filter <package-name> run build

# 完整仓库检查：Biome check + typecheck + test
pnpm run check

# 全仓库 typecheck 或 test（仅在 Verification policy 规定的升级条件满足时运行）
pnpm run typecheck
pnpm test

# 可选：需要真实子进程的集成测试（真实 CLI、锁竞争、重启行为）。默认 `pnpm test` 不包含它们
pnpm run test:integration

# 会修改整个仓库的 Biome 修复命令，仅在明确需要全仓格式修复时使用
pnpm run check:fix
```

### Verification policy

- 验证范围必须匹配变更范围。默认执行“最低足够验证”，不要因为任务结束或习惯而自动执行全量 `typecheck` 和 `test`。
- 先识别变更类型，再选择验证级别：
  - 仅 Markdown、配置注释或非代码文档：不跑 TypeScript/test；必要时只检查改动文件的格式。
  - 仅样式、格式或不影响运行时的 TUI 文本：跑改动文件的 Biome；有对应快照/渲染测试时跑该测试文件。
  - 单一 package 的实现或测试：跑改动文件的 Biome、受影响的测试文件，以及该 package 的 `build`（若存在）。
  - 修改共享模块、公共导出、跨 package import、根配置、依赖、脚本、类型声明或测试基础设施：升级到 `pnpm run typecheck`，并运行受影响的测试；只有行为可能跨全仓传播时才加 `pnpm test`。
  - 无法可靠界定影响范围、涉及发布产物/包边界，或用户明确要求完整门禁：才运行 `pnpm run check`。不要用 `check:fix` 代替完整检查。
- 需要真实子进程的用例（`packages/*/test-integration/**`）不在 `pnpm test` 内：改动这些用例本身、它们驱动的 CLI/锁/重启路径，或准备发布时，额外运行 `pnpm run test:integration`。
- 全量命令不能作为局部修改的默认收尾动作。若升级验证范围，必须在进度或最终报告中说明触发原因。
- 测试失败时先修复或报告失败原因；禁止为了让验证通过而跳过测试、放宽类型检查或修改无关代码。
- `check:fix` 会修改整个仓库，只在用户明确要求全仓格式修复或确实需要全局格式迁移时使用；普通局部检查使用指定文件的 Biome 命令。

## TypeScript 规范

TypeScript 的目标是让设计更清楚，不是把每个值都包成类型、guard、helper 和 fallback。保持 strict，但优先保持实现短、直接、符合现有代码库的风格。

- 编写或修改 TypeScript 前先读 `DESIGN_TS.md`。不要放宽 strict、`noUncheckedIndexedAccess` 或 `exactOptionalPropertyTypes` 来掩盖问题。
- 先找现有的 API、schema、类型、类型守卫和相邻模块的写法。能直接使用就不要重新包一层；标准库或 Pi/runtime 已经提供的能力，不要手写替代品。
- 先问“这个不变量真的可能被破坏吗？”只在真实边界验证不可信数据：文件、JSON、环境变量、网络、第三方数据和 `catch` 的错误值。不要为理论上不可能的状态增加检查、空值分支、fallback 或新 helper。
- `unknown` 应优先停留在不可信边界，完成必要的验证后立即收窄。只有函数本身就是通用边界，或确实需要由调用方负责收窄时，才让它继续传递；不要为了消除 `unknown` 而加入没有实际收益的 wrapper 或 assertion，也不要把它传遍业务层。
- `undefined`、`null` 和 optional property 只在产品语义确实代表“没有值”时使用。不要为了通过编译，把字段改成 optional 或加上 `| undefined`。
- 不用显式 `any`、`@ts-ignore`、`@ts-nocheck`、`as unknown as T` 或无依据的非空断言来消除错误。真正的互操作缺口可以用窄范围 `as`，并让依据靠近该行；测试 fixture 可在明确不变量下使用非空断言。
- 导出函数、公共数据结构和跨 package 契约要有清楚的类型；内部变量让 TypeScript 推断即可，不要逐行补上没有信息量的类型注解。
- Promise 必须被 `await`、返回、处理 rejection，或用 `void` 明确表示有意丢弃。不要用类型断言掩盖取消、清理、错误传播或资源生命周期。

### 简化与抽象判断

- 没有第二个调用方、第二种实现或清楚的边界时，不要抽一次性函数、wrapper、interface、config 或 adapter。先把直接实现写清楚。
- 不要因为“未来可能重用”而抽象。只有当抽象现在就能消除重复、固定重要不变量、隔离稳定的公共契约，或让多个调用方明显更简单时，才提出“可以抽成 API”的选项，并说明收益、成本和影响范围。
- 如果抽象会改变公共 API、跨 package 边界，或增加持久化/生命周期，就先询问用户再扩大实现。
- 不要为了“更严格”堆 checking、guard、helper、重试或 fallback。每增加一层，都要能指出它防止的真实错误或降低的总复杂度。这不是禁止良好抽象；如果一个抽象能让架构更稳定、更一致、更容易演进，应优先采用它。
- 实现范围可以先聚焦于必要功能，但架构判断应选择最聪明且可持续的方案，而不是一味追求最少文件、最少函数或最小 diff。
- 需要在正确性和简洁性之间取舍时，保留一个清楚的边界验证，删除沿途重复的防御代码。

### 与用户沟通

- 先给简单的整体图景：改了什么、为什么、风险在哪里、验证到哪里。除非用户追问，不要用大量类型、调用链或实现细节淹没结论。
- 如果可行性不足、需求互相冲突、需要大范围重构，或抽 API 会影响公共契约，先明确告知用户，再提出可持续的方案和清楚取舍；不要默默把小需求扩大成大型工程，也不要为了保留“最小改动”而留下临时架构。
- 对可选的抽象或较大改动，先列出简短选项和取舍，询问用户是否要升级范围；局部修正则直接完成，不要为小事反复请示。

- 本地日常改动优先对变更文件执行 Biome 和对应测试；不要自动执行全量验证。
- 每次完成修改后，在最终报告列出实际执行的验证命令及结果；没有执行的全量检查要明确写出，不得暗示已通过。
## Package 边界

- 每个 `packages/pi-<name>/` workspace 负责一个独立功能或内聚的功能族，并且只能有一个 `pi.extensions` 条目。
- 具体 extension **应该**使用 `@hheei/pi-ext-core` 的共享基础能力。具体 extension **可以**直接依赖另一个具体 extension，但必须明确它是集成/附加功能，且依赖关系反映真实的安装和运行时 ownership；必须记录该依赖是必需还是可选，明确生命周期和回退行为，并避免依赖循环。除此之外，可选的跨 extension 协作应优先使用 ext-core 提供的运行时能力。
- `@hheei/pi-ext-core` 是无副作用的基础 package，**绝不能**导入具体 extension。
- 工具链已解耦为独立专注的 packages：
  - `@hheei/pi-ext-tools`（核心内置工具：read, bash, edit, write）
  - `@hheei/pi-bg-bash`（后台 bash 任务生命周期与交付）
  - `@hheei/pi-apply-patch`（V4A 补丁执行器与 worker diff）
  - `@hheei/pi-python-eval`（Python 交互内核与事实账本）
  - `@hheei/pi-todo`（待办事项状态管理）
  - `@hheei/pi-web-access`（Web 搜索与多源内容抓取）
  各工具独立拥有状态与生命周期，UI 展示通过 `@hheei/pi-ext-core` 的 presentation 扩展点解耦接入，禁止重新引入单体化依赖。
- 已废弃基础设施禁止重新引入：
  - 任务与通知：统一使用 ext-core 的 `BackgroundDelivery` 通道，禁止重新引入集中式 `TaskRegistry`。
  - 设置持久化：采用直接原子写盘与最后写入胜出（last-write-wins），禁止重新引入 `proper-lockfile` 或全局文件锁。
  - 编辑状态：UI 工作状态由原生 UI 驱动，禁止重新引入 `mutationLock` 或 `editor-working-status`。
- 除非持久化明确属于契约，否则运行时状态应限定在 session 内，清理操作必须幂等。
- 避免在 `packages/` 下 vendoring 外部仓库；如果无法避免，只 vendor 最小必要范围，并记录上游 URL 和 revision。
- 事件是通知，不是共享状态或 RPC。

## 架构术语

统一使用以下名称：

- **Pi host**：`@earendil-works/pi-coding-agent`；负责 session、extension runner、editor、terminal 和原生 UI。
- **ext-core**：`@hheei/pi-ext-core`；负责可复用的生命周期、取消、清理、surface、widget 和协作基础能力。
- **具体 extension**：可独立安装的 `packages/pi-<name>/`；负责功能状态、命令/工具、schema、策略和渲染。
- **Surface**：由 ext-core 管理的自定义 TUI 生命周期。
- **Widget**：贴近 editor 的展示组件，由 ext-core 管理。

Herdr 相关的三个 CLI 属于两套彼此无关的软件，**禁止**互换或含糊指代：

- **`herdr` CLI**（现 0.9.5）= 旧版 Herdr 终端工作区工具，独立产品。仓库：<https://github.com/herdrdev/herdr>
- **herdr-core** = 一套新版内核，提供 `hc` CLI，是 herdr-app 的服务端：它负责真正跑 terminal，自己不画任何东西。仓库：<https://github.com/herdrdev/herdr-core>
- **herdr-app** = 新版桌面程序（GUI 客户端），其内核就是 herdr-core；两者属于同一套东西。仓库：<https://github.com/herdrdev/herdr-app>

`herdr` CLI 与 herdr-core/herdr-app **没有任何关系**；`herdr-core` + `herdr-app` 才是一套。描述 pi-subagents 的 host 时，`herdr` 指旧 CLI 的 pane/tab 模型，`hc` 指 herdr-core 的 terminal 模型。

**禁止**使用不带限定词的 “core” 作为 ownership 名称。

架构方案应按以下顺序说明：

1. 用户可见的目标，以及主要的数据/控制流变化；
2. ownership、消费者、清理、取消、回退和并发（如适用）；
3. 必要时提供简短的 ASCII 流程/状态机；
4. 根据长期 ownership 定义合适的公共契约和聚焦测试，再说明文件级细节；契约范围不要超出实际责任。

## 文档

- `docs/` 保持高层次；实现细节和 TypeScript API 契约放在代码附近。
- **必须**在实现前记录公共契约、架构、持久化和重要 UI/UX 变更；小型 bug 修复和局部重构可以不新增设计文档。
- 高层设计文档应使用简体中文。
- 记录持久化、迁移、取消、并发、验证、回退和关键 UI 行为中不明显的不变量。
- 新 extension 遵循 [`docs/architecture/extension-reference.md`](docs/architecture/extension-reference.md)。
- [`DESIGN.md`](DESIGN.md) 是 UI/UX 规范；达成一致的 UI/UX 契约发生变化时，**必须**更新它。
- 将 `docs/plans/` 视为历史背景，不视为当前行为的来源。

## 工作流

对于重要功能、架构、持久化、生命周期/并发、公共契约或 UI/UX 变更：

1. 检查仓库和相关上游实现。
2. 编写或更新高层设计文档，并说明建议的边界/接口。
3. 对非平凡设计决策使用 `grill-me` 或 `grill-with-docs`，并达成一致。
4. 为必要行为建立可运行的端到端路径，并定义与 ownership 相称的公共契约；不要为了减少初始改动而留下临时架构。
5. 增加聚焦测试，实现细节，并运行聚焦验证。
6. 分别提交内聚的变更，**绝不能**包含与任务无关的用户修改。

对于小型修复/重构：检查调用方，进行合理范围的修改；行为发生变化时更新聚焦测试，并运行聚焦的格式、类型和测试验证。

对于 UI 工作：遵循 [`DESIGN.md`](DESIGN.md)，适当复用 ext-core 基础能力，确保输出 ANSI/单元格宽度安全，在状态变化后请求重新渲染，并测试受影响的窄/宽布局。

## 发布

本项目已接入 npm Trusted Publisher (OIDC) 与 GitHub Actions 自动化发布：

```bash
pnpm run publish:dry-run                  # 本地打包校验与预演
git tag vX.Y.Z && git push origin vX.Y.Z  # 推送 tag 触发 GitHub Actions Release 工作流自动发布
# 或在 GitHub 仓库 Actions 页面手动运行 Release 工作流 (workflow_dispatch)
```

各 `packages/pi-<name>/package.json` 自带 `version`，彼此独立；root 的 `version` 只是私有 root package 自身的版本。发布时只会上传 npm 中尚不存在的 package 版本，未改动的 package 保持原版本并被跳过。tag 不需要等于任何 package 版本，它只触发 `release.yml`。因 npm 2FA 与 OIDC 限制，本地直发（如 `npm publish`）会被拒绝，必须通过 GitHub Actions 流程完成发布。发布仍属于高风险且不可逆的操作，必须遵守下面的发布安全规则并取得明确授权。

## 发布安全

- **必须**通过完整的仓库发布门禁，并核对目标版本和依赖范围后才能发布。
- **必须**获得针对确切的外部 push/tag/publish/release 操作的明确批准，除非用户已经授权该确切操作。
- 在可用时先运行 dry-run，并在发布前报告确切的 package 和版本。
- **绝不能**把 push、tag、工作流触发成功或命令退出成功当作发布成功的证明；必须核实实际的 CI/CD 发布结果。CI 正常运行并通过后即可回报；npm registry 边缘缓存至少需要 10 分钟刷新，无需等待本地 npm view 完全同步。
- 失败时停止并报告证据。**绝不能**为了让发布通过而削弱测试、类型、验证或兼容性约束。

## 关键规则

- **必须**保持修改聚焦、类型严格、运行时边界经过验证，并确保具体 extension 的依赖关系有明确意图且无循环。
- **必须**在每次提交前做数据脱敏：仓库公开，不得提交本机绝对路径、用户名、内网主机名、凭据、token 或个人身份信息；文档与测试中的路径用仓库相对形式或占位符（如 `<node_modules>/`、`dcu-cluster`），fixture 用通用假值。
- **绝不能**无必要地保留废弃的旧命名兼容逻辑，或修改与任务无关的用户工作。
- **应该**优先选择简单、可见、可组合且幂等的机制。
- 共享 TypeScript 基线是 `tsconfig.base.json`；各 package 应继承它。

## graphify

本项目在 `graphify-out/` 中维护知识图谱，包含核心节点、社区结构和跨文件关系。

当用户输入 `/graphify` 时，必须先使用已安装的 Graphify skill 或相关指令，再执行其他操作。

规则：

- 当 `graphify-out/graph.json` 存在时，对于代码库问题应先运行 `graphify query "<question>"`。查询关系时使用 `graphify path "<A>" "<B>"`，查询单个概念时使用 `graphify explain "<concept>"`。这些命令返回范围受控的子图，通常比 `GRAPH_REPORT.md` 或原始 grep 输出小得多。
- hook 或增量更新产生未提交的 `graphify-out/` 文件是正常的，不应因此跳过 Graphify。只有任务本身是排查过期或错误的 Graphify 输出，或用户明确要求不要使用 Graphify 时，才跳过它。
- 如果存在 `graphify-out/wiki/index.md`，进行广泛导航时优先使用它，不要直接浏览原始源代码。
- 只有进行广泛架构审查，或 query/path/explain 没有提供足够上下文时，才读取 `graphify-out/GRAPH_REPORT.md`。
- 修改代码后运行 `pnpm run verify:changed`（会自动检查格式、运行受影响验证并更新图谱）或单独运行 `graphify update .`，保持图谱最新。该操作只进行 AST 更新，不产生 API 成本。
