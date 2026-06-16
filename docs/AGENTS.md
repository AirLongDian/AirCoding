# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## 项目概述

AirCoding 是基于 OpenCode v1.17.4 fork 的多 Agent 协作 AI 编程系统，以 C++ 为首个深度支持语言。核心策略：**最小修改 OpenCode，通过 Plugin + Agent 配置植入多 Agent 调度层**。

- 完整架构设计：@aircoding-architecture-mvp.md
- 实现计划：@implementation-plan.md
- V1 痛点教训：@airplanV2-Qwen3.7-Max设计.md
- OpenCode 参考代码：@reference/opencode/

## 构建与测试

```bash
bun install              # 安装依赖
bun lint                 # oxlint 检查
bun typecheck            # turbo typecheck 全包
bun test                 # ⚠️ 禁止从根目录运行，必须进入 packages/<pkg> 执行
bun typecheck            # ⚠️ 同上，从包目录执行，禁止直接运行 tsc
```

## 代码风格

沿用 OpenCode 规范（Prettier: `semi: false`, `printWidth: 120`，oxlint）：

- `const` 优先，禁止 `let` + 重赋值
- 禁止 `else`，用 early return
- 禁止不必要的解构，用 dot notation
- 禁止 `import { x as y }` 和 `import * as Foo`
- 禁止 `try/catch`（能用 `.catch()` 的场景）
- 内联单次使用的值，不提前抽取 helper
- 模块底部加 `export * as Foo from "./foo"` 自导出
- Drizzle schema 字段用 snake_case
- Effect v4 beta：`Effect.fork` 不存在，用 `Effect.forkIn(scope)`

## 分支与提交

- 默认分支：`dev`（不是 `main`）
- 分支名：短名（最多三个词），短横线分隔，无前缀（如 `session-recovery`，不是 `feat/session-recovery`）
- 提交：`type(scope): summary`，type: `feat|fix|docs|chore|refactor|test`

## Agent 架构约束

**核心原则：工具白名单是硬阻断，不是建议。**

| Agent | 可用工具 | 禁止工具 |
|-------|---------|---------|
| Architecture Designer | read, glob, grep, task | Write, Edit, Bash（代码级只读） |
| Scheduler | read, glob, grep, task, coordinator.* | Write, Edit（不可写代码） |
| Worker (EXECUTE) | read, write, edit, shell, glob, grep | — |
| Worker (DEBUG) | 同上，但必须先通过 shell 取证才能修改代码 | — |

- Worker 是 EXECUTE + DEBUG 双模式合一，由 TaskSpec.type 切换
- Worker 直接通过 `shell` 调用 cmake/ctest/cppcheck/ffmpeg/tcpdump，不封装 Plugin
- EXECUTE 模式：**每次完成前必须运行 `cppcheck --enable=all`（不可跳过）**
- DEBUG 模式：先取证（shell 调用截图/抓包/静态分析）→ 记录 → 才能改代码
- Scheduler 通过 EventV2 事件驱动，不依赖 LLM 轮询
- 10 分钟不活跃自动巡检 + scheduler-state.json 实时落盘

## 关键设计约束

- **单进程模型**：子代理 = OpenCode 子 session（TaskTool + BackgroundJob），不是独立进程
- **LLM 混合策略**：正常调度走确定性代码（DAG 遍历），异常/边界才调 LLM
- **证据门控**：按任务类型决定必需证据（GUI→截图，网络→抓包，C++→静态分析）
- **两层审查**：Worker 自验（逐任务）+ Arc 里程碑审查 fork（全局 Code-to-Design）
- **接口契约**：中等粒度（module + kind + spec + stability），作为概率信号而非确定性判断

## C++ 工具链

- Worker 直接通过 `shell` 调用命令行工具，不封装 Plugin
- 构建：CMake 优先，Ninja 优先，失败回退 Make
- 测试：CTest + GoogleTest
- **cppcheck 强制：每次任务完成前必须运行 `cppcheck --enable=all`，无输出不允许标记完成**
- Scheduler 校验 WorkerResult 中必须包含 cppcheck 输出
- 编译错误解析：LLM 自行分析（不用正则）
- compile_commands.json：按需生成，不持久化

## 目录约定

```
.air/shared/         # 可提交 git（plan, rules, project.json）
.air/local/          # gitignore（sessions, state, debug-records）
.air/local/state/scheduler-state.json  # 调度器实时状态
```

## 测试策略

- 单元测试：`bun test`，无 LLM 调用，<30s
- 集成测试：录制 LLM fixture 回放，<1min
- E2E 测试：真实 LLM，release gate

## 强制规则
- 不得以兜底方案、先这样做、以后再删、先跳过、后面再补或类似原因进行与方案不同的降级实现
- 执行必须先读取相关需求设计与架构，先读后写，不得违背架构独自实现
- 代码审查不能只看代码是否存在，不能只跑代码是否通过门禁，必须先读取相关设计和约束然后code to review逐条审查+功能测试用例全过才能pass

## 多 Agent 调度规则（Main Agent 必读）

你是 Main Agent（用户交互入口）。你不直接写代码或执行复杂任务，而是**派发给专门的子代理**。

### 何时派发 Architect（架构师）

- 新项目或新功能开始时 → 派发 `architect` 子代理做需求分析和架构设计
- 用户讨论架构、需求变更时 → 派发 `architect`
- 提示词示例：`请用 architect 子代理分析这个需求并设计架构方案：{用户需求}`

### 何时派发 Scheduler（调度器）

- 用户提出需要多步骤实现的开发任务时 → 派发 `scheduler` 子代理
- Architect 完成架构设计后，需要执行时 → 派发 `scheduler`
- 提示词示例：`请用 scheduler 子代理执行以下任务：{任务描述}`

### 派发规则

1. **使用 `task` 工具**，设置 `subagent_type` 为 `scheduler`、`worker` 或 `architect`
2. **始终设置 `background: true`**，让子代理在后台运行，你保持与用户的对话
3. 子代理完成后会自动通知你，你负责向用户汇报结果
4. 不要同时承担多个角色——你是协调者，不是执行者

### 对话流程

```
用户提需求
  → 如果是新领域/复杂需求 → 派发 architect 做架构设计
  → architect 完成后 → 派发 scheduler 执行
  → scheduler 完成 → 向用户汇报结果
  → 如果用户追问细节 → 派发对应子代理处理
```

### 简单任务例外

以下情况你可以直接处理，不需要派发子代理：
- 回答用户关于项目/代码的问题（用 read/grep/glob）
- 单文件的小修改（直接用 edit）
- 解释已有代码的行为