# AirCoding 会议记录与当前状态

> 日期：2026-06-13
> 状态：架构已确定，实现进行中，需要补全各层代码级保证和协作 prompt

---

## 一、核心架构决策（已确定）

### 1.1 总体架构

```
用户 ↔ Main Agent（客服/乙方代表，用户唯一交互入口）
         └── Scheduler（核心枢纽，事件路由器）
               ├── Architect（按需咨询/里程碑审查）
               │     └── fork → Reviewer（审查时临时创建，审查完销毁）
               ├── Executor Worker（写代码、编译、测试）
               ├── Debugger Worker（证据收集、问题定位、修复）
               └── 读写 .air/shared/ 共享文件
```

- **Main Agent = 客服角色**：面向用户，理解意图，传达需求，汇报进度，处理变更，不做技术活
- **Scheduler = 项目经理**：拆解任务，派发 Worker，监控进度，协调资源，不写代码
- **Architect = 技术总监**：需求分析，架构设计，里程碑审查，常驻提供咨询
- **Worker = 工程师**：EXECUTE + DEBUG 双模式，写代码/编译/测试/调试

### 1.2 通信模型

- **EventV2 事件总线** + **coordinator 工具**（listen/dispatch/status）
- 子 agent 完成 → EventV2 广播 → Scheduler 收到 → 按规则派发下一个
- **共享文件**（`.air/shared/`）+ **ContextPack**（派发时传递上下文引用）
- **不是 agent 之间直接对话**，而是通过事件 + Scheduler 路由

### 1.3 三条通信路径

1. **Scheduler → Architect**：重规划/异常咨询，Arc 读图 → 输出 PlanDelta
2. **Scheduler → Reviewer**：Code-to-Design 对照审查，审查报告写入 WorkerResult
3. **Scheduler → Architect（consult）**：Scheduler 无法决策时求助

### 1.4 流程规则（Scheduler 状态机）

```
Executor 完成 → 自动触发 Reviewer（逐任务审查）
Reviewer 通过 → 标记任务完成
build/test 失败 → 自动触发 Debugger
Reviewer 发现问题 → 重新派发 Executor 修复
阶段内所有任务完成 → 自动触发 Architect（里程碑审查）
里程碑审查通过 → 进入下一阶段
里程碑审查发现问题 → Architect 生成修复任务 → Scheduler 派发
需求变更 → 触发动态 DAG 调度算法
Scheduler 异常无法决策 → 派发 Architect（咨询）
所有任务完成 → 汇总结果返回 Main Agent
```

### 1.5 核心设计约束

- **单进程模型**：子代理 = OpenCode 子 session（TaskTool + BackgroundJob）
- **代码级硬阻断**：工具白名单是硬阻断不是建议
- **LLM 混合策略**：正常调度走确定性代码，异常/边界才调 LLM
- **防卡死**：10 分钟不活跃定时器 + scheduler-state.json 实时落盘
- **cppcheck 强制**：每次任务完成前必须运行，无输出不允许标记完成
- **证据门控**：按任务类型决定必需证据
- **两层审查**：Worker 自验 + Architect 里程碑审查 fork

### 1.6 基线

- **Fork OpenCode v1.17.4**（commit abda3515）
- TypeScript + Bun，单进程，Effect v4 beta
- 不封装 C++ 工具链 Plugin，Worker 直接用 shell 调用 cmake/ctest/cppcheck

---

## 二、当前实现状态

### 2.1 已完成的文件

| 文件 | 位置 | 状态 |
|------|------|------|
| coordinator.ts | workspace/.../src/tool/coordinator.ts | ✅ 已写入，类型检查通过 |
| registry.ts | workspace/.../src/tool/registry.ts | ✅ 已修改（+4 工具注册） |
| agent.ts | workspace/.../src/agent/agent.ts | ⚠️ 已回退，需要重新修改 |
| scheduler.txt | workspace/.../src/agent/prompt/scheduler.txt | ✅ 已写入，但缺少协作指令 |
| worker.txt | workspace/.../src/agent/prompt/worker.txt | ✅ 已写入，但缺少协作指令 |
| architect.txt | workspace/.../src/agent/prompt/architect.txt | ✅ 已写入，但缺少协作指令 |
| AGENTS.md | E:\WorkSpace\AirCodingCli\AGENTS.md | ✅ 已写入 |
| opencode.json | E:\WorkSpace\AirCodingCli\opencode.json | ✅ 已创建 |
| bun install | workspace | ✅ 成功（需要设置 WindowsSdkDir 环境变量） |
| bun typecheck | workspace | ✅ 通过 |

### 2.2 启动方式

```bash
cd E:\WorkSpace\AirCodingCli\workspace
export WindowsSdkDir="D:/Dev/IDE/VS/VSIDE/Windows Kits/10/"
export VCToolsInstallDir="D:/Dev/IDE/VS/VSIDE/VC/Tools/MSVC/14.50.35717/"
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
bun dev
```

或运行 `workspace\start.bat` / `workspace\start.sh`。

### 2.3 测试结果

- TUI 正常渲染 ✅
- 只能看到 build 和 plan 两个 agent ❌（scheduler/worker/architect 未注册）
- Main Agent 不会自动派发 Scheduler ❌
- 各 Agent 之间无法协作 ❌

---

## 三、待解决的问题（按优先级）

### 3.1 每层都需要 A（代码级保证）+ B（协作 Prompt）

**这是用户反复强调的核心要求。不能只靠 prompt，也不能只有代码没有 prompt。**

| Agent | A：代码级保证（需要改 OpenCode 源码） | B：协作 Prompt（需要补全） |
|-------|-------------------------------------|--------------------------|
| **Main Agent** | prompt.ts 强制转发给 Scheduler（代码路由） | 怎么汇报结果、转达变更、与用户沟通 |
| **Scheduler** | 代码保证只能通过 task 工具派发 Worker/Architect | 怎么拆任务、怎么用 coordinator 工具、怎么读写 task-graph、怎么和 Architect 协作 |
| **Architect** | 工具白名单已有（只读） | 怎么写 task-graph.json、怎么 fork Reviewer、审查结果发给谁 |
| **Worker** | Scheduler 校验 WorkerResult 包含 cppcheck 输出 | 怎么汇报结果（WorkerResult 格式）、EXECUTE/DEBUG 模式切换、结果返回给谁 |

### 3.2 每个 Agent 需要知道的协作信息

```
我是谁 → 我的角色和约束
我的上游是谁 → 谁派发了我，结果返回给谁
我的下游是谁 → 我能派发谁，用什么工具
通信协议 → 共享文件在哪、结果格式是什么、事件怎么收
```

### 3.3 具体改动清单

#### 改动 1：agent.ts — 注册 3 个自定义 Agent

```typescript
// 在 agents 对象中添加：
scheduler: {
  name: "scheduler",
  description: "AirCoding 调度引擎",
  mode: "subagent",   // 不是 primary，由 Main Agent 派发
  native: true,
  steps: 200,
  prompt: PROMPT_SCHEDULER,
  permission: Permission.merge(defaults, Permission.fromConfig({
    edit: "deny", write: "deny", todowrite: "deny", task: "allow",
  }), user),
},
worker: { ... mode: "subagent", prompt: PROMPT_WORKER, ... },
architect: { ... mode: "subagent", prompt: PROMPT_ARCHITECT,
  permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", task: "allow" }
},
```

#### 改动 2：build agent 加 prompt — Main Agent 编排逻辑

```typescript
build: {
  name: "build",
  prompt: PROMPT_AIRCODING_MAIN,  // ← 新增
  mode: "primary",
  ...
}
```

PROMPT_AIRCODING_MAIN 内容：
- 你是 AirCoding 主代理，面向用户的唯一交互入口
- 你不直接执行复杂任务，通过 task 工具派发 scheduler
- 始终设置 background: true
- 子代理完成后自动通知你，你负责向用户汇报

#### 改动 3：prompt.ts — 代码级路由（可选但推荐）

在主循环中插入确定性路由，强制将复杂任务转发给 Scheduler：

```typescript
// 在 runLoop 中，LLM 调用之前
// 如果当前 agent 是 build，且用户消息不是简单问答
// → 确定性派发 scheduler（不经过 LLM 判断）
```

#### 改动 4：各 Agent prompt 补全协作指令

每个 prompt 需要补充：
- 上游/下游是谁
- 用什么工具通信（task, coordinator.listen, coordinator.status）
- 共享文件路径和格式（task-graph.json, review-result.json）
- 结果格式（WorkerResult 结构）

---

## 四、设计文档索引

| 文档 | 路径 | 内容 |
|------|------|------|
| 架构设计 | aircoding-architecture-mvp.md | 完整架构（16 章，7 项已确定决策） |
| 实现计划 | implementation-plan.md | 实现步骤 v2.0 |
| 集成指南 | INTEGRATION.md | 如何集成到 OpenCode fork |
| AI 编码指南 | AGENTS.md | 代码风格 + Agent 约束 |
| V1 痛点 | airplanV2-Qwen3.7-Max设计.md | 25 个 P0/P1 缺陷及 V2 方案 |
| 原始愿景 | idea.md | 完整系统设计（参考用） |
| V1 基线 | baselineV1.md | 早期基线设计（参考用） |

---

## 五、环境配置

```bash
# Bun 版本
bun 1.3.14

# 必需环境变量
WindowsSdkDir=D:\Dev\IDE\VS\VSIDE\Windows Kits\10\
VCToolsInstallDir=D:\Dev\IDE\VS\VSIDE\VC\Tools\MSVC\14.50.35717\
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true

# 项目结构
E:\WorkSpace\AirCodingCli\
├── workspace/          # OpenCode v1.17.4 fork（工作目录）
├── reference/opencode/ # OpenCode v1.17.4 原始参考
├── reference/airplan-v2/ # V2 插件 prompt 参考
├── src/                # AirCoding 自有源码（coordinator.ts, prompts）
└── *.md                # 设计文档
```

---

## 六、关键代码参考

### coordinator.ts 已实现的 4 个工具

1. `coordinator_listen` — 等待后台 Worker 完成，返回结果
2. `coordinator_status` — 查询所有后台 Worker 状态
3. `coordinator_save_state` — 保存调度状态到 scheduler-state.json
4. `coordinator_load_state` — 从 scheduler-state.json 恢复状态

### TaskTool 关键 API（OpenCode 已有）

```typescript
// 派发子代理（前台/后台）
task({
  description: "任务描述",
  prompt: "详细任务指令",
  subagent_type: "scheduler",  // 或 "worker", "architect"
  background: true,            // 后台运行
  task_id: "复用已有session的ID"  // 可选，复用持久 session
})
```

### 共享文件结构

```
.air/shared/
├── plan/
│   ├── plan.md           # 架构方案
│   ├── task-graph.json   # 任务图（source of truth）
│   ├── requirements.md   # 原始需求
│   └── docs/ADR-*.md     # 架构决策记录
└── rules/
    ├── project-rules.md
    └── toolchain-rules.md

.air/local/
├── state/
│   └── scheduler-state.json  # 调度器实时状态
└── sessions/
```
