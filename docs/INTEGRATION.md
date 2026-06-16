# AirCoding 集成指南

本文档说明如何将 AirCoding 的自定义组件集成到 OpenCode v1.17.4 fork 中。

## 需要集成的文件

| 源文件 | 目标位置 | 说明 |
|--------|---------|------|
| `src/tool/coordinator.ts` | `packages/opencode/src/tool/coordinator.ts` | 调度工具（4 个子工具） |
| `src/agents/prompts/scheduler.md` | `packages/opencode/src/agent/prompt/scheduler.txt` | Scheduler system prompt |
| `src/agents/prompts/worker.md` | `packages/opencode/src/agent/prompt/worker.txt` | Worker system prompt |
| `src/agents/prompts/architect.md` | `packages/opencode/src/agent/prompt/architect.txt` | Architect system prompt |
| `opencode.json` | 项目根目录 `.opencode/opencode.json` 或用户配置 | Agent 定义 |

## 步骤 1：复制 coordinator.ts

```bash
cp src/tool/coordinator.ts packages/opencode/src/tool/coordinator.ts
```

## 步骤 2：修改 registry.ts

在 `packages/opencode/src/tool/registry.ts` 中做以下修改：

### 2a. 添加 import（文件顶部）

```typescript
import * as coordinator from "./coordinator"
```

### 2b. 注册工具（约 198 行，tool init block 中）

在 `const tool = yield* Effect.all({` 块中添加：

```typescript
coordinator_listen: Tool.init(coordinator.listen),
coordinator_status: Tool.init(coordinator.status),
coordinator_save_state: Tool.init(coordinator.saveState),
coordinator_load_state: Tool.init(coordinator.loadState),
```

### 2c. 添加到 builtin 列表（约 219 行）

在 `builtin: [` 数组中添加：

```typescript
tool.coordinator_listen,
tool.coordinator_status,
tool.coordinator_save_state,
tool.coordinator_load_state,
```

## 步骤 3：复制 prompt 文件

```bash
cp src/agents/prompts/scheduler.md packages/opencode/src/agent/prompt/scheduler.txt
cp src/agents/prompts/worker.md packages/opencode/src/agent/prompt/worker.txt
cp src/agents/prompts/architect.md packages/opencode/src/agent/prompt/architect.txt
```

## 步骤 4：注册 Agent（可选）

可以选择以下两种方式之一注册自定义 Agent：

### 方式 A：通过 opencode.json 配置（推荐）

将 `opencode.json` 放到项目的 `.opencode/` 目录或用户全局配置目录中。OpenCode 会自动加载其中的 agent 定义。

### 方式 B：修改 agent.ts 源码

在 `packages/opencode/src/agent/agent.ts` 的 `agents` 对象中添加自定义 agent 定义（约 138 行）：

```typescript
scheduler: {
  name: "scheduler",
  description: "任务调度引擎",
  mode: "subagent",
  native: true,
  steps: 200,
  prompt: PROMPT_SCHEDULER,
  permission: Permission.merge(defaults, Permission.fromConfig({
    edit: "deny",
    write: "deny",
    todowrite: "deny",
  }), user),
  options: {},
},
worker: {
  name: "worker",
  description: "执行器/调试器双模式 Worker",
  mode: "subagent",
  native: true,
  steps: 100,
  prompt: PROMPT_WORKER,
  permission: Permission.merge(defaults, user),
  options: {},
},
architect: {
  name: "architect",
  description: "架构规划器",
  mode: "subagent",
  native: true,
  steps: 100,
  prompt: PROMPT_ARCHITECT,
  permission: Permission.merge(defaults, Permission.fromConfig({
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    task: "allow",
  }), user),
  options: {},
},
```

并在文件顶部添加 prompt import：

```typescript
import PROMPT_SCHEDULER from "./prompt/scheduler.txt"
import PROMPT_WORKER from "./prompt/worker.txt"
import PROMPT_ARCHITECT from "./prompt/architect.txt"
```

## 步骤 5：启用后台子代理

设置环境变量以启用 OpenCode 的后台子代理功能：

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

## 步骤 6：验证

1. 构建 OpenCode：`bun run build`（或 `bun dev` 开发模式）
2. 在项目目录中创建 `.opencode/opencode.json`（包含 agent 配置）
3. 创建 `.air/local/state/` 目录
4. 启动 OpenCode，尝试使用 `task` 工具派发 scheduler/worker/architect 子代理
5. 验证 coordinator_listen / coordinator_status 工具可用
