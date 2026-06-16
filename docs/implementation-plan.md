# AirCoding 实现计划

> **版本**: 2.0
> **日期**: 2026-06-12
> **基线**: OpenCode v1.17.4 (commit abda3515)
> **参考**: aircoding-architecture-mvp.md (完整架构设计)、reference/airplan-v2 (可复用 prompt)

---

## 1. 最终方案：4 Agent + 4 文件

```
Main Agent（对话 + 意图分类 + 架构规划）
  │
  ├── Scheduler Agent（任务拆解 + 派发 + 监控 + 状态落盘）
  │     └── Worker Agent（EXECUTE / DEBUG 双模式，通过 shell 调用 cmake/ctest/cppcheck 等）
  │
  └── Architecture Designer（架构规划 + 里程碑审查 fork）
```

C++ 工具链不单独封装为 Plugin——Worker 直接通过 OpenCode 已有的 `shell` 工具调用命令行。
取证工具（截图/抓包）同理，Worker 直接通过 `shell` 调用 ffmpeg/tcpdump。

---

## 2. 文件清单

| # | 文件 | 内容 | 类型 |
|---|------|------|------|
| 1 | `agents/scheduler.json` | Scheduler agent 配置 + system prompt | JSON + prompt |
| 2 | `agents/worker.json` | Worker agent 配置 + 双模式 system prompt | JSON + prompt |
| 3 | `agents/architect.json` | Arc agent 配置 + system prompt（含审查 fork） | JSON + prompt |
| 4 | `.opencode/tool/coordinator.ts` | listen / dispatch / status 三个调度工具 | TypeScript |

运行时自动生成：`.air/local/state/scheduler-state.json`（调度器状态落盘）

---

## 3. 可复用的 AirPlan V2 资源

| AirCoding Agent | V2 对应 | 可复用文件 |
|----------------|---------|-----------|
| Scheduler | AirEng | `reference/airplan-v2/commands/eng.md` — 调度逻辑、轮询规则、自主决策指令 |
| Worker (EXECUTE) | AirDo | `reference/airplan-v2/commands/do.md` — 执行行为、验收标准 |
| Worker (DEBUG) | AirDbg | `reference/airplan-v2/commands/dbg.md` — 调试工作流、先取证后修复规则 |
| Architecture Designer | AirArc | `reference/airplan-v2/commands/arc.md` — 架构规划、需求探讨、审查指令 |
| 审查 fork | AirRvr | `reference/airplan-v2/commands/rvr.md` — Code-to-Design 审查、高风险审计 |

**复用方式**：将 V2 命令文件中的关键指令提取、适配后写入对应 Agent 的 system prompt。不是原封不动复制，而是提取核心约束规则，去掉 V2 特有的 Python runtime 部分。

---

## 4. 各文件实现细节

### 4.1 `agents/scheduler.json`

```json
{
  "id": "scheduler",
  "name": "Scheduler",
  "description": "任务调度引擎，负责任务拆解、派发、监控和结果汇总",
  "mode": "subagent",
  "model": { "primary": "claude-sonnet-4-20250514" },
  "tools": [
    "read", "glob", "grep",
    "coordinator.listen", "coordinator.dispatch", "coordinator.status",
    "task"
  ],
  "steps": 200,
  "system_prompt_file": "agents/prompts/scheduler.md"
}
```

**system prompt 核心指令**（从 `eng.md` 提取）：
- 语言锁定中文
- 自主决策原则（不询问用户，除非修复预算耗尽/需求歧义/资源耗尽）
- 不写代码（工具白名单已硬阻断）
- 任务拆解策略（按模块拆分、按依赖排序）
- 流程规则（Worker 完成 → 下一个任务 / 失败 → 重新派发调试）
- 状态落盘要求（每次状态变更写 scheduler-state.json）
- 10 分钟不活跃自动巡检

### 4.2 `agents/worker.json`

```json
{
  "id": "worker",
  "name": "Worker",
  "description": "执行器/调试器双模式 Worker",
  "mode": "subagent",
  "model": { "primary": "claude-sonnet-4-20250514" },
  "tools": [
    "read", "write", "edit", "shell", "glob", "grep"
  ],
  "steps": 100,
  "system_prompt_file": "agents/prompts/worker.md"
}
```

**system prompt 核心指令**（从 `do.md` + `dbg.md` 提取）：

```markdown
## EXECUTE 模式（task.type = "execute"）
- 按 acceptance_criteria 实现功能
- 先读后改，小步编辑
- 通过 shell 执行 cmake --build 和 ctest 验证
- **每次任务完成前必须通过 shell 运行 cppcheck --enable=all（不可跳过）**
- 编译通过 + 测试通过 + cppcheck 无严重问题 = 完成
- 不修改 scope.denied_paths 中的文件
- 完成后输出结构化结果（必须包含 cppcheck 输出）
- **Scheduler 校验：WorkerResult 中无 cppcheck 输出则拒绝，要求补跑**

## DEBUG 模式（task.type = "debug"）
- 先取证后修改（不可违反）
- 必须至少通过 shell 执行一种取证命令：
  · GUI 问题 → ffmpeg -f kmsgrab 截图
  · 网络问题 → tcpdump 抓包
  · C++ 问题 → cppcheck 静态分析
  · 通用 → 代码追踪 + 日志分析
- 取证结果记录后才能开始修改代码
- 修复后必须重新编译 + 测试验证
- 修复失败不超过 retry_budget 次
```

### 4.3 `agents/architect.json`

```json
{
  "id": "architect",
  "name": "Architecture Designer",
  "description": "架构规划器，负责需求分析、架构设计和里程碑审查",
  "mode": "subagent",
  "model": { "primary": "claude-sonnet-4-20250514" },
  "tools": ["read", "glob", "grep", "task"],
  "steps": 100,
  "system_prompt_file": "agents/prompts/architect.md"
}
```

**system prompt 核心指令**（从 `arc.md` + `rvr.md` 提取）：
- 纯规划器，禁止写代码（工具白名单硬阻断）
- 三阶段流程：探讨 → 确认 → 生成计划
- 任务描述规范（避免歧义词、包含保留约束）
- 里程碑审查：fork 只读子 session 做 Code-to-Design 审查
- 审查结果精简后返回 Scheduler

### 4.4 `.opencode/tool/coordinator.ts`

三个工具的实现要点：

**coordinator.listen**：
- 订阅 OpenCode EventV2 事件总线
- 等待匹配的子代理事件（task.completed / task.failed / task.progress）
- 超时返回 timeout 状态（触发 Scheduler 巡检）
- 每次调用时检查 last_activity → 超过 10 分钟自动巡检

**coordinator.dispatch**：
- 接收任务列表
- 为每个任务创建 OpenCode BackgroundJob（非阻塞子 session）
- 返回 jobId 列表
- 更新 scheduler-state.json

**coordinator.status**：
- 查询所有活跃 BackgroundJob 的状态
- 返回 [{ jobId, taskId, agentType, status, lastHeartbeat }]
- 检测卡死任务（心跳超时 / 硬超时）

**关键技术点**：需要研究 OpenCode 的以下 API：
- `packages/opencode/src/background/job.ts` — BackgroundJob 的 start/wait/cancel
- `packages/core/src/event.ts` — EventV2 的 subscribe/listen
- `packages/opencode/src/tool/task.ts` — TaskTool 的子 session 创建

---

## 5. 实现顺序

### Step 1: 环境搭建 + 读 API（0.5 天）

- 确认 Bun 环境可用
- 读懂 OpenCode Plugin 工具注册机制（`registry.ts` + `.opencode/tool/`）
- 读懂 BackgroundJob API（`packages/opencode/src/background/job.ts`）
- 读懂 EventV2 API（`packages/core/src/event.ts`）

### Step 2: 调度工具（1-2 天）

- 实现 `coordinator.ts`（listen + dispatch + status）
- 这是唯一的自定义代码，需要吃透 OpenCode 内部 API
- 验证子 session 创建和事件订阅可用

### Step 3: Agent 配置 + Prompt（1 天）

- 写 `scheduler.json` + system prompt（从 eng.md 提取）
- 写 `worker.json` + system prompt（从 do.md + dbg.md 提取）
- 写 `architect.json` + system prompt（从 arc.md + rvr.md 提取）

### Step 4: 端到端测试（0.5-1 天）

- 准备一个简单 C++ 项目
- 测试完整流程：用户提需求 → Main Agent → Scheduler 拆解 → Worker 执行 → 结果汇总
- 修复发现的问题

**总计：3-5 天**

---

## 6. 已知风险和对策

| 风险 | 对策 |
|------|------|
| OpenCode Plugin API 不够用 | 读源码确认，必要时做最小修改 |
| BackgroundJob 不支持非阻塞派发 | 用 OpenCode 的 `task` 工具 + `background: true` 参数 |
| EventV2 事件格式不符合预期 | 在 coordinator.listen 中做适配层 |
| System prompt 不够稳定 | 从 V2 提取已验证的指令，反复测试调优 |
| 上下文窗口不够 | 简化 prompt，Worker 只传必要上下文 |

---

## 7. 后续迭代路线（当前不做）

1. C++ 工具链 Plugin（cpp.build/test/analyze/diagnose）— Worker 目前直接用 shell
2. 取证工具 Plugin（evidence.screenshot/pcap）— Worker 目前直接用 shell
3. 独立 Reviewer Agent
4. 证据门控策略（10 种任务类型 × 证据表）
5. 动态 DAG 调度算法（增量重规划）
6. ContextAssembler（按需抽取上下文）
7. 上下文压缩（Copy-on-Write）
8. ExperienceMiner + Debug Knowledge
9. HUD / Status Layer
10. 多语言 toolchain（Python/Rust/JS）
11. 二进制分发

---

## 8. 核心设计决策速查

| 决策 | 结论 |
|------|------|
| 基线 | OpenCode v1.17.4 |
| 进程模型 | 单进程（子代理 = 子 session） |
| C++ 工具链 | Worker 直接用 shell 调用（不封装 Plugin） |
| Scheduler | 独立 Agent，事件驱动 |
| 防卡死 | 10 分钟不活跃定时器 + 状态落盘 |
| LLM 策略 | 混合：正常流程确定性代码，异常走 LLM |
| 接口契约 | 中等粒度 + stability 标记 |
| 审查 | 两层：Worker 自验 + Arc 里程碑审查 fork |
| 上下文共享 | 共享文件 + ContextPack + WorkerResult |
| Worker 模式 | EXECUTE + DEBUG 双模式合一 |
