<p align="center">
  <h1 align="center">AirCoding</h1>
</p>
<p align="center">确定性优先、LLM 为辅的多 Agent 协作半自动并发 AI 编程系统</p>
<p align="center">
  <a href="http://git.airlongdian.fun/admin/AirCoding"><img alt="Gitea" src="https://img.shields.io/badge/Gitea-AirCoding-blue?style=flat-square" /></a>
  <a href="http://git.airlongdian.fun/admin/AirCoding/releases/tag/0.1.0"><img alt="Release" src="https://img.shields.io/badge/release-0.1.0-green?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> |
  <a href="README.en.md">English</a>
</p>

---

## ## 概概述述

AirCoding 是我基于自己工作流做的一个半自动开发 Agent ，其主要目的在于以工程化的思路解决 Vibe Coding 交付代码差、对模型性能要求高的问题，旨在用低成本的模型并发完成中小项目开发。

目前这个想法刚刚搓通，而且因为时间问题，Alpha版本是 fork opencode 直接改的，受限于opencode的框架还没能完全实现理想的设计，bug估计也不少，发现一个改一个先凑合用吧。

等多会闲下来还是得自己从头搓 Agent ，现有方案制约太大了。





## 致谢

感谢玩家小张在我拉屎时和我打电话，令我思路畅通。

感谢mr冉，mr泽，mr丁，mr哲打LOL时被我坑到十连败，这就是友情和羁绊的力量啊，我准备找个进化水晶超进化一下以示报答。

提前感谢 mr樊小文 ，因为他最近在研究 go 语言搓 Agent 框架，我准备等他做完偷来用（doge

---

以下为 AI 生成

## 概述

AirCoding 是一个**确定性调度为主、LLM 为辅**的多 Agent 协作编程框架，C++ 为首个深度支持语言。

核心设计原则：

- **工具白名单是硬阻断**：每层 Agent 的能力由代码级权限控制，不依赖 Prompt 约束
- **确定性调度优先**：正常流程走 DAG 状态机，异常和边界才调 LLM
- **两层审查**：Worker 自验 + Reviewer Code-to-Design 审查
- **证据门控**：cppcheck 强制（C++ 项目），取证后才能改代码（DEBUG 模式）
- **禁降级兜底**：调度器和执行器严禁以「先这样」「先跑通」「以后再改」「for now」「temporary solution」等任何理由使用降级方案代替设计实现
- **审查器强制调用**：审查器不可跳过、不可默认通过，必须逐行对照设计方案后，再经静态审查和测试验证，全部通过才能放行

## 架构

```
用户 → Main Agent (aircoding) → 协调派发
         │
         ├─→ Architect（架构规划器）
         │     产出：plan.md + task-graph.json + ADR + C4 文档
         │
         └─→ Scheduler（调度引擎）
               │  coordinator_tick 确定性 DAG 调度
               │
               ├─→ Worker（执行器 / 调试器）
               │     EXECUTE: 写代码 → 编译 → 测试 → cppcheck
               │     DEBUG:   取证 → 记录 → 修复 → 验证
               │
               └─→ Reviewer（代码审查器）
                     对照 plan.md 做 Code-to-Design 审查
                     三层强制流程：
                     1. Code-to-Design 逐行对照表
                     2. 静态审查（安全性 / 正确性 / 合规性）
                     3. 测试 / 构建验证
```

## Agent 权限矩阵

| Agent | 可用工具 | 禁止工具 |
|-------|---------|---------|
| aircoding (Main) | read, glob, grep, task, question, web, coordinator_status, coordinator_tick | write, edit, bash |
| Scheduler | read, glob, grep, task, coordinator_* | write, edit, bash |
| Worker | read, write, edit, bash, glob, grep | task |
| Architect | read, glob, grep, task, edit/write (.air/shared/plan/**) | bash, 源代码文件写 |
| Reviewer | read, glob, grep | write, edit, bash, task |

## 安装

### 二进制（Linux x64）

```bash
# 下载发布包
wget http://git.airlongdian.fun/admin/AirCoding/releases/download/0.1.0/AirCoding-Alpha-0.1.0-linux-x64.tar.gz
tar xzf AirCoding-Alpha-0.1.0-linux-x64.tar.gz
cd AirCoding-Alpha-0.1.0 && ./install.sh

aircoding --version  # → 0.1.0
```

二进制安装到 `~/.aircoding/`，与 opencode（`~/.opencode/`）互不冲突。

### 从源码构建

```bash
bun install          # 安装依赖
bun typecheck        # 类型检查（29 包，全部通过）
cd packages/opencode && OPENCODE_VERSION="0.1.0" OPENCODE_CHANNEL="aircoding" bun run script/build.ts --single --skip-embed-web-ui
```

## 目录约定

```
.air/shared/plan/plan.md               # 架构方案（Architect 产出）
.air/shared/plan/task-graph.json       # 任务图（Architect 产出，Scheduler 执行）
.air/shared/plan/docs/ADR-*.md         # 架构决策记录
.air/shared/plan/docs/c4/              # C4 模型文档
.air/local/state/scheduler-state.json  # 调度器状态（实时落盘）
.air/local/debug/debug-log.md          # 调试记录
```

## 设计文档

详细设计文档在 `docs/` 目录：

- [架构设计 MVP](docs/aircoding-architecture-mvp.md)
- [V2 实现计划](docs/implementation-plan.md)
- [V2 设计（详细）](docs/airplanV2-Qwen3.7-Max设计.md)
- [V1 基线](docs/baselineV1.md)
- [Agent 约束规则](docs/AGENTS.md)
- [集成说明](docs/INTEGRATION.md)

## 约束铁律

详见 `CLAUDE.md`。摘要：

1. **调度器**：禁止降级兜底，必须完全遵循设计方案。设计未覆盖的场景先派 Architect 更新设计，不得在代码中自行裁决。
2. **执行器**：禁止以「先跑通」「以后再改」「以后补上」「for now」「fix later」等理由使用简化实现。编译→测试→cppcheck 三步不可跳过。输出含降级措辞直接 FAIL。
3. **审查器**：强制调用，不可跳过。「测试 pass」「函数存在」「build 通过」不得作为 PASS 依据。必须输出 Code-to-Design 逐行对照表。代码门确定性执行此规则。
4. **防无限循环**：Architect 里程碑审查设有 每阶段2次 / 全局5次 的派发预算 + `milestone_satisfied` 门控，防止 Scheduler 和 Architect 之间无限循环。

## 致谢

基于 [OpenCode](https://github.com/anomalyco/opencode) v1.17.4 fork。
