# AirCoding Agent 最小化架构设计

> **版本**: MVP-0.3
> **日期**: 2026-06-12
> **基线**: OpenCode v1.17.4 (commit abda3515)
> **策略**: 基于 OpenCode 最小修改，复用已有架构，植入多 Agent 协作

---

## 1. 核心定位

AirCoding 是基于 OpenCode 改造的 AI Coding Agent，核心 runtime 语言无关，C++ 为首个深度支持的语言 profile。

**与 OpenCode 的关系**：Fork OpenCode 作为内核，保留其 TUI、Provider、Session、Event 系统，在其上植入多 Agent 协作层。

**与 AirPlan V1 的关系**：AirPlan V1 是 Claude Code 上的插件方案，已验证架构方向但暴露大量可靠性问题（详见 `airplanV2-Qwen3.7-Max设计.md`）。AirCoding 将 V1 的经验教训内化为代码级约束，不再依赖自然语言指令控制 LLM 行为。

---

## 2. 设计原则

### 2.1 代码级硬阻断

> 永远不要用自然语言指令去约束 LLM 的行为边界。凡是"不可违反"的规则，必须在代码层面硬阻断。

三道防线：

```
第一道：工具白名单（Agent 注册时限定 tools 列表）
  → Architecture Designer 没有 Write/Edit → 物理上不可能写代码
  → Scheduler 没有 Write/Edit → 物理上不可能越界编码

第二道：状态机（Scheduler 的流程规则是代码，不是 prompt 建议）
  → Executor 完成 → 代码自动触发 Reviewer（Worker 无法跳过）
  → 证据不足 → 代码阻止标记完成（Worker 无法绕过）

第三道：结构化契约（TaskSpec/WorkerResult 是 TypeScript 类型）
  → 缺失必填字段 → 类型校验失败，不接受结果
  → denied_paths 被写入 → Permission 引擎拒绝
```

### 2.2 最小修改原则

- 直接使用 OpenCode 已有的系统，不重写
- 新增功能通过 Plugin 和 Agent 注册实现，不改 OpenCode 核心代码
- 仅在 OpenCode 无法满足需求时才修改核心代码

### 2.3 单进程模型

- 沿用 OpenCode 的单进程模型
- 子代理 = 子 session（通过 TaskTool + BackgroundJob 实现）
- 不引入独立进程 IPC，降低复杂度

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                    OpenCode 内核                      │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐ │
│  │  TUI    │ │ Provider │ │Session │ │  EventV2  │ │
│  │OpenTUI  │ │ Anthropic│ │SQLite  │ │  PubSub   │ │
│  │SolidJS  │ │ OpenAI   │ │Drizzle │ │  Durable  │ │
│  └────┬────┘ └────┬─────┘ └───┬────┘ └─────┬─────┘ │
│       │           │           │             │       │
│  ┌────┴───────────┴───────────┴─────────────┴────┐  │
│  │              AirCoding 多 Agent 层             │  │
│  │                                               │  │
│  │  ┌──────────┐   ┌────────────┐   ┌─────────┐ │  │
│  │  │Main Agent│──▶│ Scheduler  │──▶│ Workers │ │  │
│  │  │(对话入口) │   │ Agent      │   │         │ │  │
│  │  │          │   │ (事件路由)  │   │Executor │ │  │
│  │  │          │   │            │   │Reviewer │ │  │
│  │  └──────────┘   │  ┌──────┐  │   │Debugger │ │  │
│  │                  │  │Arc   │  │   └─────────┘ │  │
│  │  ┌──────────┐   │  │Design│  │               │  │
│  │  │Experience│   │  └──────┘  │   ┌─────────┐ │  │
│  │  │  Miner   │   └────────────┘   │C++ Tool │ │  │
│  │  └──────────┘                    │ Plugin  │ │  │
│  │                                  └─────────┘ │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 4. Agent 层级与职责

### 4.1 Main Agent（用户唯一交互入口）

- **职责**：对话、意图分类、进度汇报、需求变更处理
- **工具**：全部对话类工具 + `task`（派发子代理）
- **核心约束**：不直接操作文件和命令，保持空闲可响应用户介入
- **模式**：
  - 对话模式（默认）：不直接执行
  - 直通模式（`/direct` 触发）：前台直接执行

### 4.2 Architecture Designer（只读）

- **职责**：架构规划、需求探讨、影响评估、全周期审查
- **工具白名单**：`read`, `glob`, `grep`（**代码级只读**，无 Write/Edit/Bash）
- **阶段门控**：
  - `discussing` → 与用户探讨需求，禁止生成计划
  - `proposing` → 呈现架构方案，等待用户确认
  - `confirmed` → 生成 TaskGraph，允许写入 plan/ 目录
- **V1 教训**：P0-5（被 plan mode 劫持）→ 工具白名单硬阻断

### 4.3 Scheduler Agent（事件路由器）

- **职责**：任务拆解、派发、监控、合并、流程规则执行
- **工具白名单**：`task`, `coordinator.listen`, `coordinator.dispatch`, `coordinator.status`, `read`, `glob`, `grep`（**无 Write/Edit**）
- **核心机制**：
  - 通过 `BackgroundJob` 非阻塞派发子代理
  - 通过 `coordinator.listen` 订阅 EventV2，被动等待子代理事件
  - 按流程规则（代码级状态机）决定下一步派发
- **V1 教训**：
  - P0-6（停下来问）→ system prompt 强制自主决策
  - P0-7（遗忘轮询）→ 不依赖 LLM 轮询，用事件驱动
  - P0-10（偏离调度写代码）→ 工具白名单硬阻断

#### 防卡死机制（简化版）

**不活跃定时器**：Scheduler 维护 `last_activity` 时间戳。以下任一动作更新该时间戳：派发新任务、收到子代理进度/完成/失败事件、用户介入操作。如果 `now - last_activity > 10 分钟`，自动触发一轮巡检（调用 `coordinator.status` 查询所有活跃子代理状态），根据结果处理卡死/崩溃的子代理。

**状态实时落盘**：Scheduler 的每次状态变更写入 `.air/local/state/scheduler-state.json`。内容包括：当前图状态快照（每个 task 的 status）、活跃子代理列表 + 最后心跳时间、当前调度阶段/波次、`last_activity` 时间戳。API 挂了 / 进程崩溃 / 用户关闭后，下次启动时读取该文件重建调度上下文继续调度。

#### LLM 调用策略（混合模式）

正常流程走确定性代码，异常/边界/用户输出时才调 LLM：

| 决策点 | 确定性（不调 LLM） | LLM 介入 |
|--------|-------------------|---------|
| 下一波任务选择 | DAG 遍历，入度为 0 自动 ready | 资源不足时决定优先级 |
| Executor 完成 → 派发 Reviewer | 自动 | — |
| build/test 失败 → 派发 Debugger | 自动 | — |
| Debugger 修复后重试 | retry_budget 未耗尽时自动 | 预算耗尽时评估是否继续 |
| Reviewer 不通过 → 重新派发 | 自动（前 2 次） | 连续 2 次不通过 → LLM 分析 |
| 任务失败（非 build 原因） | — | LLM 分析原因 |
| 需求变更 | — | LLM 变更分类 + 影响评估 |
| 所有任务完成 → 汇总 | — | LLM 生成汇总报告 |

**防卡死兜底**：确定性代码遇到未匹配的状态转换时，不阻塞，直接调 LLM 分析。LLM 也失败则进入降级模式（只做基本调度），持续失败则暂停并上报用户。

### 4.4 Worker Agents

#### Executor

- **职责**：写代码、编译、测试、验证
- **工具**：`read`, `write`, `edit`, `shell`, `glob`, `grep` + C++ 工具链 Plugin 工具
- **内部循环**：TORI（Task → Observation → Reasoning → Iteration）
- **出口**：TaskCompleted / TaskBlocked / TaskFailed
- **约束**：TaskSpec 中的 `acceptance_criteria` + `scope.denied_paths`

#### Reviewer（只读）

- **职责**：代码审查、需求一致性验证、高风险审计
- **工具白名单**：`read`, `glob`, `grep`（**只读**）
- **触发**：Scheduler 在 Executor 完成后自动派发（代码级规则，Worker 无法跳过）
- **上下文**：ContextAssembler 按需抽取当前任务模块的 plan 段落 + 需求条目（局部视野，~4K-6K tokens）
- **审查范围**：任务验收（acceptance_criteria）+ 模块内 Code-to-Design + 代码质量 + 高风险审计
- **V1 教训**：P0-8（AirDo 跳过专家）→ Scheduler 强制派发，不由 Worker 决定

**两层审查模型**：

| | 逐任务审查 (Reviewer) | 里程碑审查 (Architecture Designer) |
|---|---|---|
| 触发时机 | 每个 Executor 完成后 | 每个阶段/波次完成后 |
| 上下文范围 | 局部（当前任务 + 模块段落） | 全局（完整 plan + 所有审查报告） |
| 检查重点 | 任务验收 + 模块内 Code-to-Design | 跨模块架构一致性 |
| 上下文大小 | ~4K-6K tokens | ~8K-15K tokens |
| 频率 | 高（每个任务一次） | 低（每个阶段一次） |

里程碑审查由 Scheduler 在阶段内所有任务完成后自动派发 Architecture Designer，Arc 持有完整 plan.md + 本阶段所有 Reviewer 报告，重点检查跨模块依赖方向、公共接口一致性、模块职责边界。

#### Debugger

- **职责**：证据收集、问题定位、修复、验证
- **工具**：分两阶段
  - `GATHERING` 阶段：只读工具（`read`, `glob`, `grep`, `shell` 仅用于运行诊断命令）
  - `FIXING` 阶段：开放写工具（`write`, `edit`）
  - 阶段转换由代码检查证据列表，无证据不允许进入 FIXING
- **V1 教训**：P1-17（未取证就改代码）→ 阶段门控硬阻断

#### ExperienceMiner（后台）

- **职责**：从会话中提取经验、生成 SKILL.md、去重归档
- **触发**：会话结束时 / DebugRecord 产生时 / 定期触发
- **不阻塞 Main Agent**

#### Compactor（后台）

- **职责**：上下文压缩（Copy-on-Write）
- **触发**：Context window 占比达 70%
- **直接复用 OpenCode 的 `compaction.ts`**

---

## 5. 子代理通信机制

### 5.1 通信模型

OpenCode 的 TaskTool 是父子树状通信。AirCoding 通过 **EventV2 + Scheduler 路由** 实现兄弟 agent 之间的松耦合通信。

```
子 Agent 完成 → EventV2 广播事件 → Scheduler 收到事件 → Scheduler 按规则派发下一个子 Agent
```

不是 agent 之间直接对话，而是通过事件 + Scheduler 路由。

### 5.2 流程规则（Scheduler 的状态机）

```
Executor 完成 → 自动触发 Reviewer（逐任务审查）
Reviewer 通过 → 标记任务完成
build/test 失败 → 自动触发 Debugger
Reviewer 发现问题 → 重新派发 Executor 修复
阶段内所有任务完成 → 自动触发 Architecture Designer（里程碑审查）
里程碑审查通过 → 进入下一阶段
里程碑审查发现问题 → Arc 生成修复任务 → Scheduler 派发
需求变更 → 触发动态 DAG 调度算法（§14）
Scheduler 异常无法决策 → 派发 Architecture Designer（咨询）
所有任务完成 → 汇总结果返回 Main Agent
```

这些规则在 Scheduler 的 system prompt 中定义，但执行由 `coordinator.listen` 工具驱动——Scheduler 被动接收事件，按规则响应。

### 5.3 需要新增的工具

#### `coordinator.listen`

让 Scheduler 在 TORI 循环中等待子代理事件：

```typescript
// .opencode/tool/coordinator.ts
Tool.define("coordinator.listen", {
  description: "等待并返回下一个子代理事件",
  parameters: Schema.Struct({
    event_types: Schema.Array(Schema.String),
    timeout_ms: Schema.optional(Schema.Number),
  }),
  execute: async ({ event_types, timeout_ms }) => {
    // 订阅 EventV2，等待匹配的事件到达
    // 返回事件内容
  }
})
```

#### `coordinator.dispatch`

让 Scheduler 批量派发子代理：

```typescript
Tool.define("coordinator.dispatch", {
  description: "批量派发子代理任务",
  parameters: Schema.Struct({
    tasks: Schema.Array(Schema.Struct({
      agent_type: Schema.Literal("executor", "reviewer", "debugger"),
      task_spec: TaskSpecSchema,
      background: Schema.optional(Schema.Boolean),
    })),
  }),
  execute: async ({ tasks }) => {
    // 为每个任务创建 BackgroundJob 或前台子 session
    // 返回 job IDs
  }
})
```

#### `coordinator.status`

让 Scheduler 查询当前所有子代理的状态：

```typescript
Tool.define("coordinator.status", {
  description: "查询所有活跃子代理的状态",
  parameters: Schema.Struct({}),
  execute: async () => {
    // 查询所有活跃 BackgroundJob 的状态
    // 返回 [{ jobId, agentType, taskId, status, progress }]
  }
})
```

---

## 6. TaskSpec 与 WorkerResult 结构化契约

### 6.1 TaskSpec

```typescript
interface TaskSpec {
  id: string
  type: "execute" | "review" | "debug" | "compact" | "mine_experience"
  title: string
  description: string
  
  // 验收标准（结构化，非自由文本）
  acceptance_criteria: string[]
  
  // 作用域约束
  scope: {
    expected_files?: string[]       // 预期修改的文件
    denied_paths?: string[]         // 禁止触碰的路径
    preserved_paths?: string[]      // 必须保留不动的路径
    write_area?: string             // 写区域标识（用于冲突检测）
  }
  
  // 接口契约（用于影响传播算法）
  contracts: {
    provides?: InterfaceContract[]  // 本任务对外暴露的接口
    requires?: InterfaceContract[]  // 本任务依赖的接口
  }
  
  // 依赖关系
  dependencies: Array<{
    task_id: string
    type: "hard" | "soft" | "conflict" | "serialization"
  }>
  
  // 验证要求
  verification: {
    commands?: string[]             // 验证命令
    required: boolean               // 是否必须通过验证才能标记完成
    evidence_types?: string[]       // 需要的证据类型（screenshot, pcap, static_analysis 等）
  }
  
  // 约束
  constraints: {
    max_turns: number
    soft_timeout_ms: number
    hard_timeout_ms: number
    retry_budget: number
  }
}

interface InterfaceContract {
  module: string                                          // "auth", "database", "ui/login"
  kind: "api" | "schema" | "file" | "config" | "protocol"
  spec: string                                            // 人类可读的描述，不要求形式化
  stability: "stable" | "volatile" | "frozen"             // stable: 大概率不变; volatile: 可能随需求调整; frozen: 已有下游依赖不应改
}
```

### 6.2 WorkerResult

```typescript
interface WorkerResult {
  task_id: string
  agent_type: "executor" | "reviewer" | "debugger"
  status: "completed" | "failed" | "blocked" | "cancelled"
  
  // 结构化摘要（3-6 句话）
  summary: string
  
  // 变更清单
  changed_files: string[]
  diff_ref?: string
  
  // 验证结果（结构化）
  verification: Array<{
    name: string
    status: "passed" | "failed" | "skipped"
    evidence_ref?: string
    notes?: string
  }>
  
  // 收集的证据
  evidence: Array<{
    type: "screenshot" | "pcap" | "static_analysis" | "test_output" | "build_log" | "code_trace"
    ref: string
    summary: string
  }>
  
  // 风险评估
  risks: Array<{
    severity: "low" | "medium" | "high"
    summary: string
  }>
  
  // 后续建议
  follow_up_tasks?: Array<{
    title: string
    type: "execute" | "review" | "debug"
  }>
}
```

---

## 7. AirPlan V1 痛点 → AirCoding 对策清单

### 7.1 P0 级（已造成实际损失）

| ID | V1 痛点 | AirCoding 对策 | 防线 |
|----|---------|---------------|------|
| P0-1 | 证据门控假阳性 | Scheduler 按 TaskSpec.verification.evidence_types 决定需要什么证据 | 状态机 |
| P0-2 | 部署验证缺口 | verification.required=true 时，Scheduler 检查 VerificationResult 才允许完成 | 状态机 |
| P0-3 | 非原子写入 | OpenCode SQLite 事务 | 内核 |
| P0-4 | 零并发控制 | OpenCode EventV2 + session 隔离 | 内核 |
| P0-5 | Arc 被 plan mode 劫持 | Architecture Designer 工具白名单只含只读工具 | 工具白名单 |
| P0-6 | Eng 停下来问不自主推进 | Scheduler system prompt 强制自主决策，仅三种情况询问用户 | prompt + 工具 |
| P0-7 | Eng 遗忘轮询 | 不依赖 LLM 轮询，用 `coordinator.listen` 事件驱动 | 工具 |
| P0-8 | AirDo 跳过专家插件 | Scheduler 代码级规则自动派发 Reviewer/Debugger，Worker 无权跳过 | 状态机 |
| P0-9 | 安装器路径错误 | OpenCode Plugin SDK 标准注册 | 内核 |
| P0-10 | Eng 偏离调度写代码 | Scheduler 工具白名单无 Write/Edit | 工具白名单 |

### 7.2 P1 级（限制可靠性）

| ID | V1 痛点 | AirCoding 对策 | 防线 |
|----|---------|---------------|------|
| P1-14 | 需求变更后调度恢复慢 | TaskGraph + PlanDelta 增量更新 + 影响传播算法（待设计） | 调度算法 |
| P1-15 | 同文件无冲突被迫串行 | 区域级冲突检测 + worktree 隔离 | 调度算法 |
| P1-16 | Arc 跳过需求探讨 | Architecture Designer 阶段门控（discussing → proposing → confirmed） | 状态机 |
| P1-17 | AirDbg 未取证就改代码 | Debugger 分阶段工具权限（GATHERING 只读 → FIXING 写） | 工具白名单 |
| P1-21 | ADR 变更级联失效 | Scheduler 订阅 ADR 变更事件 → 影响传播 → 选择性失效 | 调度算法 |
| P1-22 | Dispatch→Worker 断链 | OpenCode TaskTool 代码级派发，无 JSON 中间文件 | 内核 |
| P1-24 | 任务描述歧义导致破坏 | TaskSpec 结构化：scope.expected_files + denied_paths + acceptance_criteria | 结构化契约 |
| P1-25 | Merge 后状态不同步 | OpenCode domain tables 事务更新 | 内核 |

---

## 8. C++ 工具链（Plugin 方式）

C++ 工具链作为 OpenCode Plugin 注册，放在 `.opencode/tool/` 目录或通过 Plugin SDK 注册。

### 8.1 工具列表

| 工具名 | 功能 | 对应 V1 |
|--------|------|---------|
| `cpp.build` | CMake/Ninja 构建 | AirSDB 扩展 |
| `cpp.test` | CTest + GoogleTest 运行 | AirTst |
| `cpp.analyze` | cppcheck + clang-tidy 静态分析 | AirSDB |
| `cpp.diagnose` | 编译错误解析（LLM 驱动） | Debugger 内置 |
| `cpp.intelligence` | clangd CLI 模式代码智能 | 新增 |
| `cpp.screenshot` | GUI 截图采集 | AirXDB |
| `cpp.packet_capture` | 网络抓包 | AirNDB |
| `cpp.deploy` | SSH 远程部署 + 验证 | AirDep |

### 8.2 证据门控策略

#### 任务类型分类

```typescript
enum TaskCategory {
  CPP_LOGIC     = "cpp_logic",       // C++ 业务逻辑、算法、状态机
  CPP_BUILD     = "cpp_build",       // CMake/构建配置
  CPP_GUI       = "cpp_gui",         // Qt/GTK UI 组件
  CPP_NETWORK   = "cpp_network",     // 网络协议、通信模块
  CPP_DEPLOY    = "cpp_deploy",      // 部署、打包、安装
  CONFIG        = "config",          // 配置文件修改
  DOCS          = "docs",            // 文档编写
  TEST          = "test",            // 测试用例编写/运行
  REFACTOR      = "refactor",        // 重构（不改功能）
  BUGFIX        = "bugfix",          // Bug 修复
}
```

#### 证据策略表

| 任务类型 | 必需证据 | 可选证据 |
|---------|---------|---------|
| `cpp_logic` | build_pass, test_pass | static_analysis |
| `cpp_build` | build_pass | — |
| `cpp_gui` | build_pass, screenshot | test_pass |
| `cpp_network` | build_pass, pcap | test_pass |
| `cpp_deploy` | build_pass, deploy_verify | smoke_test |
| `config` | build_pass | — |
| `docs` | — | — |
| `test` | build_pass, test_output | — |
| `refactor` | build_pass, test_pass, diff_review | static_analysis |
| `bugfix` | build_pass, test_pass, reproduction | screenshot, pcap |

Architecture Designer 生成 TaskSpec 时根据任务描述和文件范围自动推断 `verification.evidence_types`。用户可在 plan 中用 `[no-screenshot]` 等标记显式跳过。

#### 全局强制规则

```typescript
// 1. blocked/failed 状态必须附 debugger 分析
if (result.status === "blocked" || result.status === "failed") {
  required_evidence.push("debugger_analysis")
}

// 2. 无文件变更的 done 必须有解释
if (result.status === "completed" && result.changed_files.length === 0) {
  required_evidence.push("explanation")
}

// 3. C++ 文件变更强制静态分析
if (result.changed_files.some(f => f.match(/\.(cpp|h|hpp|cc|cxx)$/))) {
  required_evidence.push("static_analysis")
}
```

Scheduler 按此策略检查 WorkerResult 中的 evidence 是否齐全，不齐全则阻止标记完成。

---

## 9. 上下文共享模型

### 共享数据源

所有 Agent 通过共享文件访问架构上下文，Scheduler 作为通信中枢派发时通过 ContextPack 传递引用：

```
.air/shared/                          ← 所有 Agent 可读
  ├── plan/
  │   ├── plan.md                     ← 架构方案
  │   ├── task-graph.json             ← 任务图（source of truth）
  │   ├── requirements.md             ← 原始需求
  │   └── docs/
  │       └── ADR-*.md                ← 架构决策记录
  └── rules/
      ├── project-rules.md
      └── toolchain-rules.md
```

### 三条通信路径

```
路径 1: Scheduler → Architecture Designer（重规划/异常咨询）
  Scheduler 发现问题 → 派发 Arc 子 session
  → ContextPack 携带问题描述 + 当前图引用
  → Arc 读图 → 输出 PlanDelta 或建议
  → 结果通过 WorkerResult 返回 Scheduler

路径 2: Reviewer 对照审查（Code-to-Design）
  Scheduler 派发 Reviewer 时，ContextPack 包含 plan 段落 + 需求条目
  → Reviewer 读文件做 Code-to-Design 对照
  → 审查报告写入 WorkerResult
  → 里程碑审查时 Arc 持有完整 plan + 所有审查报告（全局视野）

路径 3: Scheduler 异常咨询 Architecture Designer
  Scheduler 确定性代码 + LLM 都无法决策
  → 派发 Arc 子 session，task type = "consult"
  → 传入当前困境 + 图状态
  → Arc 返回建议 → Scheduler 按建议执行
```

### ContextAssembler 按需组装

Agent 不直接读完整文件。ContextAssembler 根据当前任务只抽取相关片段：

| 完整文件 | 抽取策略 | 预估大小 |
|---------|---------|---------|
| plan.md (500 行) | 按 TaskSpec 涉及的 module 抽取相关段落 | ~30 行 |
| task-graph.json (200 节点) | 仅当前任务 + 直接上下游邻居 | ~5-10 节点 |
| requirements.md (100 行) | 按 module 过滤相关需求条目 | ~5-10 条 |
| ADR 目录 (20 份) | 仅加载 TaskSpec.contracts 引用的 ADR | ~1-3 份 |
| project-rules.md | 按 scope.expected_files 过滤相关规则 | ~10-20 条 |

各 Agent 典型上下文大小：

| Agent | 上下文组成 | 预估 token |
|-------|----------|-----------|
| Executor | TaskSpec + plan 段落 + 邻居节点 + 相关规则 + ADR | ~3K-5K |
| Reviewer | TaskSpec + plan 段落 + 需求条目 + 相关规则 + diff | ~4K-6K |
| Scheduler | 图状态摘要（ID + status 列表）+ 事件 | ~2K-4K |
| Arc (里程碑审查) | 完整 plan + 本阶段所有 Reviewer 报告 | ~8K-15K |
| Arc (重规划) | 变更描述 + 受影响任务上下文 + frozen 接口 | ~5K-8K |

---

## 10. 上下文与记忆

### 10.1 直接复用 OpenCode

- **上下文压缩**：`compaction.ts`（已有，70% 阈值触发）
- **会话持久化**：SQLite per-session（已有）
- **消息存储**：Anthropic 原生 content blocks（已有）

### 10.2 新增

- **Project Rules**：`.air/shared/rules/project-rules.md`（Claude Code 风格 Markdown + frontmatter）
- **Learned Experience**：`~/.air/skills/<skill-name>/SKILL.md`（YAML frontmatter + Markdown body）
- **Debug Knowledge**：SQLite 本地知识库，DebugRecord 结构化存储
- **ExperienceMiner**：独立后台 Agent，会话结束时提取经验

---

## 11. 目录结构

### 11.1 全局

```
~/.air/
  ├── config.yaml           # AirCoding 配置（扩展 OpenCode config）
  ├── models.yaml           # 模型配置
  ├── permissions.yaml      # 权限规则
  ├── compaction-rules.md   # 压缩规则
  ├── skills/               # 跨项目复用技能（SKILL.md）
  └── logs/
```

### 11.2 项目内

```
<project>/.air/
  ├── shared/               # 可提交 git
  │   ├── project.json      # 项目元数据
  │   ├── rules/
  │   │   ├── project-rules.md
  │   │   └── toolchain-rules.md
  │   └── plan/
  │       ├── AGENTS.md
  │       ├── plan.md
  │       ├── task-graph.json
  │       └── docs/
  └── local/                # gitignore
      ├── sessions/         # OpenCode session DB
      ├── state/
      │   └── scheduler-state.json  # 调度器实时状态（防卡死 + 崩溃恢复）
      ├── debug-records.db
      ├── learned-memory.db
      └── workspaces/       # git worktree 隔离区
```

---

## 12. MVP 范围

### 12.1 包含

1. **Main Agent 对话 + 意图分类**（复用 OpenCode）
2. **Architecture Designer Agent**（只读，阶段门控）
3. **Scheduler Agent**（事件驱动调度，coordinator 工具）
4. **Executor Worker**（TORI 循环，C++ 工具链 Plugin）
5. **Reviewer Worker**（只读，自动触发）
6. **Debugger Worker**（分阶段权限，证据门控）
7. **C++ 工具链 Plugin**（build, test, analyze, diagnose）
8. **TaskSpec / WorkerResult 结构化契约**
9. **Session 持久化**（复用 OpenCode）
10. **上下文压缩**（复用 OpenCode）
11. **Project Rules**（Markdown + frontmatter）

### 12.2 不包含（后续迭代）

- ExperienceMiner / Curator Daemon
- Debug Knowledge Network
- 多语言 toolchain（Python/Rust/JS）
- HUD / Status Layer
- 二进制分发
- 动态 DAG 调度算法的完整实现（MVP 阶段先用简单的全量重规划，§14 的增量算法后续迭代）

---

## 13. OpenCode 改造点清单

### 13.1 不改（直接复用）

| 模块 | 路径 | 说明 |
|------|------|------|
| TUI | `packages/tui/` | OpenTUI/Solid，直接复用 |
| Provider | `packages/opencode/src/provider/` | Anthropic + OpenAI 抽象 |
| Session DB | `packages/core/src/session/sql.ts` | SQLite + Drizzle |
| Event System | `packages/core/src/event.ts` | EventV2 PubSub |
| Context Compaction | `packages/opencode/src/session/compaction.ts` | 自动压缩 |
| Tool Registry | `packages/opencode/src/tool/registry.ts` | 工具注册框架 |
| Permission | OpenCode 权限系统 | 权限检查 |
| BackgroundJob | `packages/opencode/src/background/job.ts` | 异步子代理 |

### 13.2 新增文件

| 文件 | 说明 |
|------|------|
| `.opencode/tool/coordinator.ts` | coordinator.listen / dispatch / status 工具 |
| `.opencode/tool/cpp-*.ts` | C++ 工具链 Plugin |
| `agents/main.ts` | Main Agent 配置（system prompt + 工具列表） |
| `agents/architecture-designer.ts` | Arc Agent 配置（只读工具 + 阶段门控） |
| `agents/scheduler.ts` | Scheduler Agent 配置（事件路由 + 流程规则） |
| `agents/executor.ts` | Executor Worker 配置 |
| `agents/reviewer.ts` | Reviewer Worker 配置（只读） |
| `agents/debugger.ts` | Debugger Worker 配置（分阶段权限） |
| `contracts/task-spec.ts` | TaskSpec 类型定义 |
| `contracts/worker-result.ts` | WorkerResult 类型定义 |
| `contracts/interface-contract.ts` | InterfaceContract 类型定义 |

### 13.3 需要修改的 OpenCode 代码（最小改动）

| 改动 | 位置 | 说明 |
|------|------|------|
| Agent 注册扩展 | `packages/opencode/src/agent/agent.ts` | 注册自定义 Agent 类型 |
| TaskTool 扩展 | `packages/opencode/src/tool/task.ts` | 支持 BackgroundJob 批量派发 |
| EventV2 事件类型 | `packages/core/src/event.ts` | 新增 agent 协调事件类型 |

---

## 14. 动态 DAG 调度算法

核心场景：需求中途变更，任务图部分失效，部分任务还在跑，需要智能判断哪些保留、哪些重做。

### 算法总流程

```
需求变更发生
  ↓
Phase 1: 变更分类（LLM）→ ChangeScope + 涉及模块列表
  ↓
Phase 2: 影响传播（确定性代码 + LLM 辅助）→ 每个任务标记 SAFE / BOUNDARY / IMPACTED
  ↓
Phase 3: 飞行中任务调和（确定性代码）→ cancel / wait_and_assess / let_finish
  ↓
Phase 4: 图重建（LLM）→ 仅重规划 IMPACTED 区域，SAFE 区域不动
  ↓
恢复调度
```

### Phase 1: 变更分类

Architecture Designer (LLM) 输出结构化结果：

```typescript
interface ChangeDescription {
  scope: "implementation" | "internal_interface" | "external_interface"
       | "module_replacement" | "global_constraint"
  affected_modules: string[]
  summary: string
}
```

分类规则：`implementation`（仅实现细节变，接口不变）→ `internal_interface`（模块内部接口变）→ `external_interface`（公开接口变）→ `module_replacement`（整个模块替换）→ `global_constraint`（全局约束变更）。影响范围逐级扩大。

### Phase 2: 影响传播

BFS 遍历依赖图，基于 InterfaceContract 判断影响范围：

```typescript
function propagateImpact(graph, change): Map<string, ImpactZone> {
  // 1. 种子节点：直接涉及变更模块的任务 → IMPACTED
  // 2. BFS 向前传播：检查 provides/requires 契约匹配
  //    - 契约 broken (volatile 接口) → IMPACTED，继续传播
  //    - 契约 partial (stable 接口) → BOUNDARY，继续传播
  //    - 契约 intact (frozen 接口) → SAFE，停止传播
  // 3. 未触及的节点 → SAFE
}
```

**关键**：契约匹配是概率信号，不是确定性判断。BOUNDARY 任务需要后续二次确认。

### Phase 3: 飞行中任务调和

根据任务状态 + 影响区域决定处理方式：

| 任务状态 | IMPACTED | BOUNDARY | SAFE |
|---------|----------|----------|------|
| completed | 回滚 (rollback) | 验证 (verify) | 保留 |
| running/dispatched | 取消 (cancel) | 等完成后评估 (wait_and_assess) | 继续 |
| pending | 冻结 (freeze) | 冻结 (freeze) | 正常调度 |

### Phase 4: 图重建

1. 移除取消和回滚的任务
2. 冻结调度（`dispatchFrozen = true`）
3. 提取 SAFE 已完成任务的接口作为 frozen 约束
4. 调用 Architecture Designer 局部重规划（传入变更描述 + frozen 接口 + 受影响任务上下文）
5. 插入新任务，重建依赖边
6. 为 BOUNDARY 已完成任务生成验证任务
7. 解冻调度

### 环检测

入库前和动态添加依赖边时做拓扑排序检查（Kahn 算法）。发现环时反馈给 Architecture Designer 修正，不阻塞调度。

### 触发方式

- 用户显式说"需求变了" → Main Agent 识别 → 通知 Scheduler
- Architecture Designer 里程碑审查时发现偏离 → 主动触发
- ADR 文件变更 → 文件监控检测

---

## 15. 已确定事项

| # | 议题 | 结论 |
|---|------|------|
| 1 | 接口契约精度 | 中等粒度：module + kind + 人类可读描述 + stability 标记。LLM 生成可靠，影响传播算法作为概率信号使用 |
| 2 | Scheduler LLM 调用策略 | 混合模式：正常流程走确定性代码（DAG 遍历 + 状态机），异常/边界/用户输出时调 LLM。防卡死兜底：未匹配转换不阻塞，直接走 LLM |
| 3 | 证据门控策略 | 10 种任务类型 × 必需/可选证据表 + 3 条全局强制规则。Arc 自动推断，用户可显式覆盖 |
| 4 | 防卡死机制 | 简化方案：10 分钟不活跃定时器自动巡检 + scheduler-state.json 实时落盘（崩溃恢复） |
| 5 | 动态 DAG 调度算法 | 四阶段算法（变更分类 → 影响传播 → 飞行调和 → 图重建）+ 环检测 + 三种触发方式 |
| 6 | 上下文共享模型 | 共享文件 + ContextPack + WorkerResult 三通道。ContextAssembler 按需抽取，不全量加载 |
| 7 | 审查分层 | 两层审查：Reviewer 逐任务局部审查 + Architecture Designer 阶段性里程碑审查（全局视野） |

---

## 16. 待讨论

（暂无）
