# pi-mono

> ⚠️ **注意：本项目当前处于高度活跃的开发迭代中，架构、公开契约与运行时行为可能随时发生变动，不建议直接在生产环境中安装或使用。**
>
> *Warning: This repository is under active development. APIs, internal contracts, and runtime behaviors are subject to rapid change; direct production use is not recommended at this time.*

Node/pnpm monorepo for [Pi Coding Agent](https://github.com/earendil-works/pi) extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

---

## 项目路由 (Package Index)

本仓库采用高内聚、低耦合的模块化设计。各具体扩展独立发布，按需组合：

| Package | 职责与定位 | 核心能力 / 命令 / 工具 | 文档路由 |
|---|---|---|---|
| **[@hheei/pi-ext-core](./packages/pi-ext-core)** | **核心基建**<br>无副作用共享基础库 | 生命周期管理、`ServiceRegistry`、`BackgroundDelivery`、TUI Widget & Surface 调度 | [README](./packages/pi-ext-core/README.md) |
| **[@hheei/pi-settings](./packages/pi-settings)** | **设置宿主**<br>统一设置与 Loadout 策略 | 统一配置界面 `/ext-settings`、多页面设置路由、Tool/Skill/Agent 激活策略（全局 vs 本地） | [README](./packages/pi-settings/README.md) |
| **[@hheei/pi-ext-tools](./packages/pi-ext-tools)** | 文件工具 | `read`, `grep`, `find`, `edit`, `write`, `bash` | [README](./packages/pi-ext-tools/README.md) |
| **[@hheei/pi-bg-bash](./packages/pi-bg-bash)** | 后台 Shell 执行 | `bg_bash_spawn`, `bg_bash_get`, `bg_bash_stop` | [README](./packages/pi-bg-bash/README.md) |
| **[@hheei/pi-apply-patch](./packages/pi-apply-patch)** | V4A 补丁与逐 path 发布 | `apply_patch` | [README](./packages/pi-apply-patch/README.md) |
| **[@hheei/pi-python-eval](./packages/pi-python-eval)** | 持久 Python kernel | `python_eval` | [README](./packages/pi-python-eval/README.md) |
| **[@hheei/pi-todo](./packages/pi-todo)** | 会话任务、提醒与 footer | `todo`, `/todo` | [README](./packages/pi-todo/README.md) |
| **[@hheei/pi-subagents](./packages/pi-subagents)** | **多 Agent 编排**<br>独立子 Agent 会话管理 | `agents_delegate`, `agents_get`, `agents_stop`, `agents_dashboard`、Herdr 工作区亲和调度、沉降后自动批量汇报、Hindsight 隔离 | [README](./packages/pi-subagents/README.md) |
| **[@hheei/pi-goal](./packages/pi-goal)** | **目标与自主授权**<br>会话级目标承诺与归属审查 | `goal`, `/goal start\|status\|pause\|resume\|clear`、原生 settle 续跑额度、owned reviewer 审查（默认关闭） | [README](./packages/pi-goal/README.md) |
| **[@hheei/pi-ext-memory](./packages/pi-ext-memory)** | **会话记忆**<br>分层观测式长效记忆 | 渐进式 Observations & Reflections 提炼、瞬时 Compaction 摘要渲染、证据溯源（`recall`）、活跃记忆修剪 | [README](./packages/pi-ext-memory/README.md) |
| **[@hheei/pi-ext-addon](./packages/pi-ext-addon)** | **增强与守卫**<br>宿主实用工具与韧性保障 | `$skill` 补全、`/auto-title` 自动标题、批处理规则注入、Gemini 批处理守卫、codemode 语法预检、GPT 409 异常自动恢复 | [README](./packages/pi-ext-addon/README.md) |
| **[@hheei/pi-optimizer](./packages/pi-optimizer)** | **输入与提示词**<br>提示词模式与命令优化 | 简繁无感转换、Caveman/Ponytail 提示词模式、RTK 命令行执行优化、`/optimizer` 交互配置 | [README](./packages/pi-optimizer/README.md) |
| **[@hheei/pi-status](./packages/pi-status)** | **状态栏与遥测**<br>高信息密度 TUI 页脚 | 双行紧凑 Footer、Provider/Model 路由展示、上下文窗口水位计量条、Token 消耗与实时成本统计 | [README](./packages/pi-status/README.md) |
| **[@hheei/pi-ext-ui](./packages/pi-ext-ui)** | **UI 视图与渲染**<br>折叠框架与专用视图 | 工具输出多级折叠、多轮工具活动分组（Activity Groups）、专门工具渲染器（`edit`, `read`, `write`, `apply_patch`, `eval`, `codemode`） | [README](./packages/pi-ext-ui/README.md) |
| **[@hheei/pi-loadout](./packages/pi-loadout)** | **原生资源装配**<br>统一资源配置与覆盖 | 交互式 `/ext-loadout` 命令、跨 Global / Project 作用域装配与启用 Skills, Extensions, Prompts, Themes | [README](./packages/pi-loadout/README.md) |
| **[@hheei/pi-web-access](./packages/pi-web-access)** | **网络检索与抓取**<br>多源 Web 访问与内容提取 | 统一 Web 工具契约（`web_search`, `fetch_content`, `source_check`, `get_search_content`）、多引擎聚合与 PDF/GitHub 内容抓取 | [README](./packages/pi-web-access/README.md) |

---

## 文档导航 (Documentation)

- **[完整文档索引 (docs/README.md)](./docs/README.md)**：开发指南、用户手册与架构设计全景。
- **[TUI 设计规范 (DESIGN.md)](./DESIGN.md)**：Pi 交互与视觉设计基线（宽度、颜色、视口保护）。
- **[工程与产品规范 (AGENTS.md)](./AGENTS.md)**：仓库约束、发版安全策略与开发工作流。
- **[TypeScript 规范 (DESIGN_TS.md)](./DESIGN_TS.md)**：TypeScript 类型设计、边界验证与代码精简准则。
- **[领域词汇表 (GLOSSARY.md)](./GLOSSARY.md)**：核心模块与领域术语的规范定义。
- **[共享术语 (CONTEXT.md)](./CONTEXT.md)**：跨包工具契约与用户可见资源的统一用语。
- **[架构设计参考 (docs/architecture/)](./docs/architecture/)**：
  - [Subagents 多 Agent 架构](./docs/architecture/pi-subagents.md)
  - [后台任务与交付契约 (Background Tasks)](./docs/architecture/background-tasks.md)
  - [统一 Grep 架构](./docs/architecture/grep.md)
  - [Loadout 策略架构](./docs/architecture/loadout.md)

---

## 本地安装与开发 (Development)

环境要求：
- Node.js `>= 22.19.0`
- pnpm `>= 12.4.1`
- [Pi Coding Agent](https://github.com/earendil-works/pi) `>= 1.0.0`

### 本地编译与校验

在仓库根目录执行：

```bash
# 安装依赖
pnpm install --frozen-lockfile

# 全仓编译
pnpm run build

# 全量类型检查
pnpm run typecheck

# 运行测试套件
pnpm test

# 代码风格检查
pnpm -w exec biome check packages/

# 预演发布打包验证
pnpm run publish:dry-run
```

### 在 Pi 中加载本地扩展

通过 Pi CLI 的 `--extension` 参数或 `pi install` 加载指定扩展：

```bash
# 加载指定扩展调试
pi --extension ./packages/pi-ext-tools/dist/extension.js

# 或通过软链本地安装至 Pi 全局配置
pi install ./packages/pi-ext-tools
```
