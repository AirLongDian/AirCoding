# AirCoding Agent 设计文档

> 最后更新：2026-05-26
> Canonical baseline: `AirPlan/docs/architecture/baselineV1.md`
> 历史决策记录：`AirPlan/docs/architecture/decisions-round-1.md`、`decisions-round-2.md`、`decisions-round-3.md`

## 1. 背景与动机

当前 Air 系列插件主要运行在 Claude Code 已暴露的 agent/plugin 接口之上，能力边界受限。尤其是 AirContext 为了参与上下文管理，需要通过插件层绕行，这种方式不够优雅，也不利于长期演进。

新的方向是：从"Claude Code 插件外挂式扩展"转向"自有 agent/runtime 架构"。

目标不是做一个泛用 Claude Code clone，而是构建一个以 C++ 为首个深度支持语言、后续可扩展至 Python/Rust/JS 等多语言的长期可用 AI Coding Agent。

## 2. 核心定位

AirCoding Agent 的核心 runtime 是语言无关的。C++ 是第一个深度支持的语言 profile，后续按 `toolchain-<lang>` 包扩展。

开发闭环：

```text
需求理解
  → 架构/接口设计
  → 代码阅读
  → 修改计划
  → 编译
  → 静态分析
  → 单测/集成测试
  → 运行/调试
  → 崩溃/日志/网络/GUI 证据分析
  → 修复
  → 变更总结
  → 经验沉淀
```

## 3. 参考项目分工

### 3.1 OpenCode

OpenCode 作为 runtime 骨架、TUI、provider 抽象、session/tool registry 的主要参考。

- TUI 交互布局以 OpenCode 为设计规范
- runtime 分层（session/event/sync、多 agent 组织）
- provider / model 抽象
- plugin / SDK 扩展层

### 3.2 Claude Code CLI

Claude Code CLI 作为执行层代码质量、Executor 行为、工具调用策略、记忆系统、文件编辑安全边界的标杆。AirCoding 的执行层功能应尽可能与 Claude Code 对齐，以提升代码修改质量、安全性和验证纪律。

- 工具生命周期、schema 校验
- 权限模型
- 子代理调度
- 文件 read/edit/write 与 diff/update 执行原语
- 小步精确编辑、先读后改、避免无关重构、失败时定位根因而不是随机重试
- build/test/debug 证据闭环，完成前必须验证或明确说明未验证原因
- 实现中发现架构/接口冲突时显式上报 blocker
- compact / resume / history / rewind 交互
- **记忆系统**（MEMORY.md + frontmatter + 多类型分层）
- **TAOR / TORI 设计**（Task-Agent-Observation-Result / Tool-Observation-Reasoning-Iteration 循环）

### 3.3 Hermes Agent

Hermes Agent 作为长期运行、跨会话学习、技能生成和 Curator 机制的参考。

- Nudge Engine 计数触发机制
- Curator Daemon 定期去重/合并/归档
- 使用中自我 patch
- SKILL.md 格式（YAML frontmatter + Markdown body）
- FTS5 语义搜索

### 3.4 Codex / OpenAI Coding Agent

Codex / OpenAI 开源 coding agent 作为通用工具调用与多模态工具面的补充参考。

- shell / patch / test 直接闭环
- coding sandbox 与工具调用编排
- tools / plugin / core-plugins / MCP 相关实现
- 图像生成、图像编辑、视觉输入等通用工具能力的 capability 设计参考
- 只作为工具面参考，不作为 AirCoding 核心 runtime 形态参考
- 本地参考路径：`reference/openai-codex/`

### 3.5 Anthropic / Claude Skills

Anthropic/Claude 开源 Skills 项目作为 skill/tool 组织方式的重要参考。

- SKILL.md 结构、frontmatter、触发描述与资源组织
- 技能包内 scripts / references / assets 的组织方式
- 可复用工具步骤如何沉淀成 skill
- skill 与 MCP / capability / Project Rules 的边界划分
- 作为 AirCoding SkillGenerator、ExperienceMiner、Capability 文档格式的参考
- 本地参考路径：`reference/anthropic-skills/`

### 3.6 asciinema / Atuin / claude-hud

- asciinema：PTY 接管与终端流捕获
- Atuin：SQLite 命令历史结构化存储与搜索
- claude-hud：实时 HUD / statusline 设计

## 4. 语言选型（已确定）

### 4.1 主语言：TypeScript + Bun

- **运行时**：Bun（内置 SQLite，原生 TSX 支持）
- **TUI 框架**：`@opentui/solid`（MIT 许可独立项目，npm 依赖引入）
- **包结构**：Bun workspaces + Turborepo monorepo

### 4.2 Python 角色

Python 退化为纯 subprocess 工具调用（`Bun.spawn` + JSON-over-stdio），仅用于封装已有 C++ 工具链脚本和 Python 特有库。经验提炼、上下文组装、记忆管理全部留在 TS runtime 内部。

### 4.3 多语言 toolchain 包结构

Runtime 核心是语言无关的。每种语言通过独立包 + LanguageDetector plugin 扩展：

```
packages/
  tui/              — 语言无关 TUI
  runtime/          — 语言无关 Agent Runtime
  llm/              — 语言无关 Provider 抽象
  cli/              — 语言无关入口
  toolchain-cpp/    — C++ 工具链
  toolchain-python/ — Python 工具链（后续）
  toolchain-rust/   — Rust 工具链（后续）
  toolchain-js/     — JS/TS 工具链（后续）
```

## 5. 架构设计

### 5.1 架构模型

事件驱动。Main Agent 订阅 EventBus 获取 agent/task/tool 事件并渲染 TUI/HUD。

Main Agent 状态机详见 `AirPlan/docs/architecture/main-agent-state-machine.md`：

```text
IDLE → CLASSIFYING（LLM 判断意图）
  → DELEGATING（需要执行时）
  → CONFIRMING（架构级变更需确认，实现级静默通过）
  → EXECUTING（Scheduler 派发任务，Main Agent 监控进度）
  → INTERRUPTING（用户中途变更，LLM 判断意图）
  → SUMMARIZING（汇总结果，触发 ExperienceMiner）
  → IDLE
```

核心约束：Main Agent 必须保持空闲可响应用户介入。后台任务派子代理做。

**确认门控**：实现级变更（不影响接口/架构）→ 静默进入 EXECUTING。架构级变更 → Architecture Designer 评估 → 低权限需确认，高权限自动推进但结果显示给用户。

### 5.2 Agent 层级

```
Main Agent（用户唯一交互入口）
  ├── 对话模式（默认）：不直接操作文件和命令
  └── 直通模式（/direct 触发，/done 退出）

Architecture Designer（全周期架构规划与审查）

Scheduler（任务图拆解、并行/串行调度、进度监控）
  ├── Executor（写代码、改文件、编译、测试验证）
  ├── Reviewer（代码审查、静态分析审查，只读不改代码）
  └── Debugger（证据收集、问题定位、插桩修复，吸收 Fixer 职责）
```

### 5.3 子代理进程模型

每个 Executor/Reviewer/Debugger 是**独立 Bun 进程**（非单进程内异步任务，也非 Worker 线程）。IPC 通过 stdio + JSON。崩溃隔离、上下文隔离、天然适配 worktree。

### 5.4 心跳与超时

- **心跳**：Push 模型。子代理每 N 秒主动推送 `AgentHeartbeat`（当前状态、turn 数、已用 token）
- **超时**：混合硬超时（kill）+ 软超时（警告 + 允许申请延期）。Scheduler 按任务类型分情况决定
- **死循环检测**：同一错误签名出现 N+ 次 → 上报 Main Agent

### 5.5 并发写入策略

轻量 write_area 粗分：

- 不同写集 → 默认可并发
- 相同写集但大概率不写相同代码块 → git worktree 隔离并发，事后合并
- 高概率改同一代码块或公共接口 → 串行

Scheduler 是合并协调者，非统一写入器。lockfile、构建配置、公共 API/schema 默认提高并发风险。

### 5.6 Worker Agent 类型

**Executor**（Claude Code 为行为标杆）：
- 内部 loop：LOADING → THINKING → ACTING → OBSERVING → （调试子循环）→ FINALIZING
- 自治完成完整闭环，不逐步骤汇报
- 出口：TaskCompleted / TaskBlocked / TaskFailed
- TaskSpec 附带 max_turns / acceptance_criteria / timeout

**Reviewer**（只读）：
- 流程规则自动触发（Executor 完成 → Reviewer）
- loop：LOADING → REVIEWING → DECIDING（approved / changes_requested / blocked）

**Debugger**（build/test 失败自动触发）：
- loop：GATHERING → ANALYZING → FIXING → RECORDING 或 ESCALATING
- 产出 DebuggerResult + DebugRecord 候选

三个子代理的 Agent Loop **各自独立实现**，不共享通用 loop 引擎。

### 5.7 流程规则

```text
Executor 完成切片 → 自动触发 Reviewer
build/test 失败 → 自动触发 Debugger
静态分析报警 → 自动触发 Reviewer 或 Debugger
阶段完成 → 自动触发 Architecture Designer 架构审查
项目完成 → Architecture Designer 最终一致性审查
```

### 5.8 需求变更协议

用户需求变更先由 Main Agent 做 LLM 分类：

- execution 级 → Scheduler 直接调整
- possible_design 级 → Architecture Designer 轻量 impact check
- design/interface/goal 级 → Architecture Designer 完整影响评估

Scheduler 基于分类结果或 Arc Revision 调整 TaskGraph。

### 5.9 Worker Result 标准

所有 Worker 结果必须结构化（非自由文本摘要）。格式详见 idea.md 原始定义（ExecutorResult / ReviewerResult / DebuggerResult）。

## 6. C++ Toolchain 工具链

### 6.1 分层

```text
Agent 接口: build(config) → BuildResult, test(filter) → TestResult, analyze() → Diagnostic[]
       ↓
C++ Toolchain Adapter（屏蔽 CMake/MSBuild/Bazel 差异）
       ↓
Native Tool Execution（实际调用 cmake/ninja/msbuild/...）
```

### 6.2 BuildTool

优先级：CMake（内置）> Meson/Bazel/XMake（capability plugin）> Makefile/.sln

冲突处理：多种构建系统文件同时存在 → 询问用户
Generator：Ninja 优先，失败回退 Make
配置失败：BuildTool 内置逻辑先尝试修复 → 失败则交给 Debugger

### 6.3 CompilerDiagnosticParser

**全部走 LLM 解析**（不用正则），生成结构化 Diagnostic + 语义错误签名（归一化 GCC/Clang/MSVC 措辞差异）。链接器错误单独归类。

### 6.4 TestRunner / StaticAnalysis / CodeIntelligence

- TestRunner：CTest + GoogleTest 内置，Catch2/Boost.Test 插件
- StaticAnalysis：cppcheck 内置，clang-tidy 插件
- CodeIntelligence：MVP 走 clangd CLI 模式（spawn 用完即退），LSP daemon 模式后续按需加

### 6.5 compile_commands.json

按需生成（`cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`），不做持久化缓存。

## 7. Project Model 项目模型

### 7.1 设计原则

- 多语言通用：语言无关层 + 语言特定层分离
- Scanner 只收集文件系统元数据（目录树 + 文件扩展名 + 特殊文件），不读文件内容
- LLM 驱动理解，用户确认修正

### 7.2 Scanner 策略

- **无递归深度限制、无目录排除**——完整目录树本身就是有用的结构信息
- 15 秒硬超时兜底，超时返回部分结果 + incomplete 标记
- 首次全量，后续增量（mtime diff）
- 再打开时加载 project.json + 快速确认顶层无变化，有变化才增量扫描

### 7.3 LLM 驱动的项目初始化

Scanner 收集事实 → Main Agent + LLM 推理 → 提出假设 → 用户确认/修正 → 沉淀

- **Schema 校验**：宽松接受，缺失字段标记 unknown，不让 LLM 反复重试
- **用户纠正**：增量更新单字段 + 提示"关联判断可能受影响"，不自动重写整个 json
- **版本迁移**：打开项目时检测旧 schema → 备份后提示用户确认迁移 → 失败回滚

## 8. Agent 目录结构

### 8.1 全局目录

```text
~/.air/
  ├── config.yaml
  ├── models.yaml
  ├── permissions.yaml
  ├── compaction-rules.md       # 用户模板
  ├── project-index.db          # 最近项目索引，不是 source of truth
  ├── cache/                    # plugins/providers/lsp/downloads
  ├── resources/versions/<version>/
  ├── skills/                   # 跨项目复用技能（SKILL.md 格式）
  └── logs/
      ├── air.log               # 用户可读（启动失败、异常报错）
      └── air.developer.log     # 开发组公钥加密全量调试日志，保留 7 天
```

### 8.2 项目内 `.air/`

```text
<project>/.air/
  ├── shared/                   # 可提交 git，共享给团队
  │   ├── project.json          # 含 stable UUID project_id
  │   ├── permissions.yaml
  │   ├── compaction-rules.md
  │   ├── rules/
  │   │   ├── project-rules.md
  │   │   └── toolchain-rules.md
  │   └── plan/                 # 原 AirPlan 工作流内化
  │       ├── AGENTS.md
  │       ├── plan.md
  │       ├── todo.md
  │       └── docs/
  └── local/                    # 可随项目携带但默认 gitignore
      ├── sessions/<session-id>/
      │   ├── session.db
      │   └── artifacts/
      ├── state/
      ├── backups/              # Git 仓库管理的项目外文件备份
      ├── debug-records.db
      ├── learned-memory.db
      ├── workspaces/
      ├── tmp/
      └── locks/
```

推荐 `.gitignore`：

```gitignore
.air/local/
```

## 9. Provider / Model 抽象层

- 原生支持 Anthropic API + OpenAI API
- 兼容接入：OpenRouter / ollama / 自定义 endpoint（通过 Anthropic/OpenAI 兼容模式）
- **内部存储格式**：Anthropic 原生 content blocks（Claude Code 路线）
- **Provider 转换**：API 边界做双向转换，存回 Anthropic 格式
- **同 provider 切换**：零开销
- **跨 provider 切换**：API 边界双向转换

## 10. Permission 权限模型

### 10.1 核心原则

```text
只读操作 → 永远允许
项目目录内 → 完全开放（含 build 目录，C++ 打包部署需要手动组织运行库）
项目外非系统 → 自动备份 + Git 记录，静默执行
高危系统操作 → 用户确认
```

### 10.2 边界定义

- **Symlink**：按物理路径（follow realpath），防止逃逸
- **`.git/`**：默认写保护（需确认），可在 permissions.yaml 关闭
- **build 目录**：不加特殊规则，Agent 需要完全读写
- **`sudo`**：不算高危（开发机日常操作）
- **高危判断**：静态路径白名单（`/etc/fstab`、`/boot/`、`/etc/default/grub` 等），模糊情况走 LLM escape hatch
- **`~/.air/`**：AirCoding 自身管理，不经过 PermissionEngine

### 10.3 备份与还原

- 项目外文件修改备份为 **Git 仓库**（`<project>/.air/local/backups/`）
- 每次修改 = `cp` + `git add && git commit`（commit message: session_id、agent_type、reason）
- `air restore` 三个粒度：单文件最近版本、指定时间点、整个 session
- 用户手动删备份，不做自动清理

## 11. 会话持久化

### 11.1 存储策略

- 按 session 分库 SQLite（`<project>/.air/local/sessions/<id>/session.db`）
- 消息存储：Anthropic 原生 content blocks（canonical source）
- `message_drafts` 保存流式 assistant 中间态，完成后删除
- 调度状态由 domain tables 持久化：tasks / task_dependencies / task_attempts / agents / tool_runs / command_runs / artifacts / diagnostics / evidence_refs / workspaces / events
- `ui_state` 只保存 UI 恢复状态，定时和退出时 flush
- ProjectionStore 从 DB + EventBus 重建 TUI/HUD view model
- 中断恢复：Scheduler 从 domain tables 重建调度队列，running 状态按心跳时间戳判断存亡

### 11.2 Event Store 分层

- **EventBus**：高频实时事件（TokenDelta、StdoutChunk、AgentHeartbeat），不落盘
- **PersistentEventStore**：durable events（AgentStarted、TaskCompleted、ToolRunCompleted 等），SQLite 主线程同步写入
- **ArtifactStore**：大体积内容（build log、test log、pcap、screenshot），DB 存引用 + 摘要 + hash

## 12. 上下文与记忆系统

### 12.1 记忆分层

```text
Project Rules（权威层，Claude Code 风格 Markdown + frontmatter）
  → Project Profile（事实层）
  → Session Memory（会话层）
  → Learned Experience（学习层，tentative）
  → Debug Knowledge（结构化经验库）
  → User Preference（用户偏好）
```

### 12.2 ExperienceMiner

- **触发**：DebugRecord 产生时 + 会话结束时 + 每 N 轮/工具调用中间触发（Hermes Nudge Engine 风格）
- **执行者**：独立后台子代理，不阻塞 Main Agent
- **去重**：周期性 Curator Daemon（识别重叠技能、建议合并、标记过期、归档无用）
- **自我 patch**：Agent 执行中发现经验/规则不对，转发给 ExperienceMiner 做 patch
- **升级**：非调试经验按出现次数（N=3）提醒升级；调试经验以验证证据为置信度，不打分
- **格式**：SKILL.md（YAML frontmatter + Markdown body）

### 12.3 上下文压缩

- **触发**：Context window 占比达 70%
- **策略**：Markdown + frontmatter 规则文件驱动，三层继承（系统默认 → 用户模板 `~/.air/compaction-rules.md` → 项目规则 `.air/shared/compaction-rules.md`）
- **机制**：Copy-on-Write。快照消息 1-N → 异步压缩（独立 Compactor 子代理）→ 新消息继续追加 → 完成后插入压缩标记。LLM 看到：摘要 + 标记 + 新消息。原始消息保留，LLM 可显式回溯。
- **系统默认模板**：确保没写规则的项目也能正常压缩

## 13. Debug Knowledge Network

- 本地优先，provider 接口预留远程共享
- DebugRecord 结构化存储（症状、错误签名、根因、修复方案、验证步骤、证据引用）
- 隐私：默认不上传，上传前脱敏，显式授权，可撤回

## 14. 分发与日志

### 14.1 分发

- **前期**：二进制 tarball（Bun compile 独立可执行文件 + Bundled Bun runtime + Python 脚本 + 默认资源文件），不发布公开渠道
- **后续**：稳定后再考虑 npm / brew / apt / winget

### 14.2 日志

- `air.log`：用户可读（启动失败、异常报错、环境配置问题）
- `air.developer.log`：开发组公钥加密全量调试日志 + 性能指标，7 天保留
- `air doctor`：崩溃诊断包收集命令；诊断包不自动脱敏，但必须用户显式导出/发送
- 下次启动自动检测异常退出并提示

## 15. 测试策略

- **单元测试**：bun test，CI 每次 push，<30s，无 LLM（覆盖所有确定性逻辑）
- **集成测试**：CI 每次 push，<1min，录制 LLM fixture 回放（覆盖 Agent Loop、Scheduler、IPC、session 持久化、压缩、worktree）
- **E2E 测试**：Release gate，真实 LLM（完整 C++ 项目场景），必须通过

## 16. HUD / Status Layer

- HUD 作为 runtime 内建层，通过 ProjectionStore 消费 DB + EventBus 派生状态（不依赖外部脚本解析 transcript）
- 展示：model/project/git/session/context/tasks/agents/tools/build/test/debug
- Preset：Full / Essential / Minimal
- 参考 claude-hud 的 threshold 颜色、多行布局、中文 label

## 17. 架构决策记录（ADR）

原始 13 项 ADR + 三轮讨论补充的新决策，详见：
- `AirPlan/docs/architecture/decisions-round-1.md`（D-001 ~ D-020）
- `AirPlan/docs/architecture/decisions-round-2.md`（D-021 ~ D-037）
- `AirPlan/docs/architecture/decisions-round-3.md`（D-038 ~ D-059）
- `AirPlan/docs/architecture/main-agent-state-machine.md`

## 18. MVP 第一阶段

```text
C++ local dev loop
+ @opentui/solid TUI
+ durable sessions（项目本地 per-session SQLite，domain tables 持续持久化）
+ Copy-on-Write 上下文压缩（三层继承规则文件）
+ Claude Code 风格 Project Rules + Hermes 风格 ExperienceMiner + Curator
+ local debug knowledge base
+ 事件驱动 EventBus + HUD
+ 二进制分发
```

具体包含：

1. Agent 目录与配置（`~/.air/` + `.air/shared/project.json` + `.air/local/`）
2. LLM 驱动的项目初始化（Scanner → LLM → 用户确认 → `.air/shared/project.json`）
3. 多语言 Project Model（语言无关层 + 语言特定 profile + LanguageDetector 接口）
4. TUI Shell + HUD（`@opentui/solid` + ProjectionStore）
5. SQLite Session Store（项目 `.air/local` per-session 分库，Anthropic 原生格式 + domain tables）
6. C++ Toolchain（BuildTool / DiagnosticParser LLM / TestRunner / StaticAnalysis / clangd CLI）
7. Provider / Model（Anthropic + OpenAI 原生，API 边界转换）
8. Permission 引擎（信任优先 + Git 备份 + 静态白名单高危检测）
9. Agent 分层（Main Agent 状态机 + Architecture Designer + Scheduler + Executor/Reviewer/Debugger 独立进程）
10. Context / Memory（Project Rules + ExperienceMiner + Curator + Copy-on-Write 压缩）
11. Local DebugRecord Store
12. Capability Plugin Prototype（AirSDB 优先改造）
