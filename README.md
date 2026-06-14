<p align="center">
  <h1 align="center">AirCoding</h1>
</p>
<p align="center">基于 OpenCode v1.17.4 的多 Agent 协作 AI 编程系统</p>
<p align="center">
  <a href="http://git.airlongdian.fun/admin/AirCoding"><img alt="Gitea" src="https://img.shields.io/badge/Gitea-AirCoding-blue?style=flat-square" /></a>
</p>

---

### 概述

AirCoding 是一个确定性调度为主、LLM 为辅的多 Agent 协作编程框架，以 C++ 为首个深度支持语言。核心设计原则：

- **工具白名单是硬阻断**：每层 Agent 的能力由代码级权限控制，不依赖 Prompt 约束
- **确定性调度优先**：正常流程走 DAG 状态机，异常/边界才调 LLM
- **两层审查**：Worker 自验 + Reviewer Code-to-Design 审查
- **证据门控**：cppcheck 强制（C++ 项目），取证后才能改代码（DEBUG 模式）

### 架构

```
用户 → Main Agent (aircoding) → 协调派发
         │
         ├─→ Architect（架构规划器）
         │     产出：plan.md + task-graph.json + ADR + C4 文档
         │
         └─→ Scheduler（调度引擎）
               │  coordinator_tick 确定性 DAG 调度
               │
               ├─→ Worker（执行器/调试器）
               │     EXECUTE: 写代码 → 编译 → 测试 → cppcheck
               │     DEBUG:   取证 → 记录 → 修复 → 验证
               │
               └─→ Reviewer（代码审查器）
                     对照 plan.md 做 Code-to-Design Review
```

### Agent 权限矩阵

| Agent | 可用工具 | 禁止工具 |
|-------|---------|---------|
| aircoding (Main) | read, glob, grep, task, question, web | write, edit, bash |
| Scheduler | read, glob, grep, task, coordinator_* | write, edit, bash |
| Worker | read, write, edit, bash, glob, grep | task |
| Architect | read, glob, grep, task, edit/write (.air/shared/plan/**) | bash, 代码文件写 |
| Reviewer | read, glob, grep | write, edit, bash, task |

### 构建

```bash
bun install          # 安装依赖
bun typecheck        # 类型检查
cd packages/opencode && bun test  # 运行测试
```

### 目录约定

```
.air/shared/plan/plan.md              # 架构方案（Architect 产出）
.air/shared/plan/task-graph.json      # 任务图（Architect 产出，Scheduler 执行）
.air/shared/plan/docs/ADR-*.md       # 架构决策记录
.air/shared/plan/docs/c4/            # C4 模型文档
.air/local/state/scheduler-state.json # 调度器状态（实时落盘）
.air/local/debug/debug-log.md        # 调试记录
```

### 设计文档

详细设计文档在 `docs/` 目录：

- [架构设计 MVP](docs/aircoding-architecture-mvp.md)
- [V2 实现计划](docs/implementation-plan.md)
- [V2 设计（详细）](docs/airplanV2-Qwen3.7-Max设计.md)
- [V1 基线](docs/baselineV1.md)
- [AGENTS.md](docs/AGENTS.md)
- [集成说明](docs/INTEGRATION.md)

### 致谢

基于 [OpenCode](https://github.com/anomalyco/opencode) v1.17.4 fork。
