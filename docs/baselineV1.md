# AirCoding Architecture Baseline V1

Date: 2026-05-26
Status: Canonical baseline for formal C4 / ADR / plan / todo work

This document supersedes earlier exploratory wording in `idea.md` and decision rounds where conflicts exist. Round files remain historical records; this baseline is the implementation-facing source of truth until V2.

## 1. Product Positioning

AirCoding is a self-owned AI coding agent/runtime, not a Claude Code plugin wrapper.

The runtime is language-agnostic. C++ is the first deep language profile, with later expansion through `toolchain-<lang>` packages.

Core loop:

```text
Requirement understanding
  → architecture/interface design
  → code reading
  → implementation planning
  → build
  → static analysis
  → test
  → run/debug
  → crash/log/network/GUI evidence analysis
  → fix
  → change summary
  → experience mining
```

## 2. Reference Projects and Roles

### OpenCode

Reference for:

- Runtime layering
- TUI visual style and interaction layout
- Session/event/sync concepts
- Provider/model abstraction
- Plugin/SDK extension ideas

AirCoding reuses OpenCode-style UI primitives and OpenTUI patterns, but does **not** reuse OpenCode SDK/sync/session business state.

### Claude Code CLI

Primary reference for execution-layer quality.

AirCoding execution-layer primitives should align with Claude Code as much as possible to maximize code quality, correctness, safe modification behavior, and verification discipline.

Reference areas:

- File read/edit/write safety boundaries
- Exact and conservative diff/update application behavior
- Patch granularity and conflict handling
- Tool lifecycle and schema style
- Permission checks around filesystem and shell
- Read-before-edit discipline
- Small-step edits
- Avoiding unrelated refactors and premature abstractions during task execution
- Verification-before-completion discipline
- Build/test/debug evidence collection before declaring completion
- Project Rules / memory adherence during edits
- Root-cause-oriented failure handling rather than random retries
- Explicit blocker escalation when implementation discovers architecture/interface conflicts
- TAOR / TORI execution feedback loops

Claude Code is the quality benchmark because it productizes coding execution discipline: conservative edits, strong tool boundaries, persistent project rules, contextual memory, and verified build/test/debug closure.

### Hermes Agent

Reference for:

- Experience mining
- Nudge Engine interval-triggered learning
- Curator daemon
- Skill self-patching
- SKILL.md format and FTS retrieval

### OpenAI Codex

Reference for:

- Shell / patch / test direct execution loop
- Coding sandbox and tool orchestration
- Tool/plugin/core-plugin/MCP implementation ideas
- Wider tool surface including image generation/editing/vision capabilities

Local reference path: `reference/openai-codex/`.

### Anthropic Claude Skills

Reference for:

- `SKILL.md` structure and frontmatter conventions
- Skill directory layout (`scripts/`, `references/`, `assets/`)
- Reusable workflow packaging
- Skill trigger/retrieval descriptions
- Skill/Project Rules/MCP/Capability boundary

Local reference path: `reference/anthropic-skills/`.

### asciinema / Atuin / claude-hud

Reference for:

- PTY capture and terminal replay
- Command metadata/history indexing
- HUD/statusline layout and activity display

## 3. Technology Baseline

- Runtime: TypeScript on Bun
- Monorepo: Bun workspaces + Turborepo
- TUI: `@opentui/solid`, `@opentui/core`, `@opentui/keymap`
- Storage: SQLite per session, project-local
- IPC: NDJSON over stdio
- Python: subprocess-only helper layer for existing scripts/libraries, not core runtime
- Distribution: binary tarball before public package channels

## 4. Monorepo Packages

Canonical V1.0.0 Alpha package set:

```text
packages/
  contracts/        # shared TypeScript interfaces (no implementation deps)
  cli/              # command entrypoint, resource loading, startup/doctor/init
  tui/              # OpenTUI/Solid UI, ProjectionStore consumers, HUD
  runtime/          # EventBus, Scheduler, Agent process mgmt, ToolRegistry, PermissionEngine, SessionStore, ContextAssembler
  llm/              # provider/model adapters, Anthropic canonical format, cross-provider conversion
  toolchain-cpp/    # C++ detector, build/test/static-analysis/debug tools
```

Future language packages:

```text
packages/toolchain-python/
packages/toolchain-rust/
packages/toolchain-js/
```

Dependency direction:

```text
contracts → (no implementation deps)
cli → tui/runtime/llm/toolchain-cpp
runtime → contracts, llm (interfaces/adapters), toolchain-* via registry
tui → contracts (ProjectionClient only)
llm → contracts
toolchain-cpp → contracts
runtime must not depend on tui
tui must consume ProjectionStore, not raw DB/EventBus directly
```

## 5. Project and Global Filesystem Layout

### Global User Directory

`~/.air/` stores user-global configuration, caches, global skills, logs, and project index only. It is not the source of truth for project sessions.

```text
~/.air/
  ├── config.yaml
  ├── models.yaml
  ├── permissions.yaml
  ├── compaction-rules.md
  ├── project-index.db
  ├── cache/
  │   ├── plugins/
  │   ├── providers/
  │   ├── lsp/
  │   └── downloads/
  ├── resources/versions/<version>/
  ├── skills/
  └── logs/
      ├── air.log
      └── air.developer.log
```

### Project Directory

Project source of truth lives under the project.

```text
<project>/.air/
  ├── shared/
  │   ├── project.json
  │   ├── permissions.yaml
  │   ├── compaction-rules.md
  │   ├── rules/
  │   │   ├── project-rules.md
  │   │   └── toolchain-rules.md
  │   └── plan/
  │       ├── AGENTS.md
  │       ├── plan.md
  │       ├── todo.md
  │       └── docs/
  └── local/
      ├── sessions/<session-id>/
      │   ├── session.db
      │   └── artifacts/
      ├── state/
      ├── backups/
      ├── debug-records.db
      ├── learned-memory.db
      ├── workspaces/
      ├── tmp/
      └── locks/
```

Recommended `.gitignore`:

```gitignore
.air/local/
```

`.air/shared/` is git-shareable. `.air/local/` is portable with the project directory but private/local by default.

`project_id` is a stable UUID generated at initialization and stored in `.air/shared/project.json`. It is not derived from the absolute path.

## 6. Runtime Architecture

AirCoding is event-driven.

```text
Main Agent
  → Architecture Designer
  → Scheduler
      → Executor
      → Reviewer
      → Debugger
      → Compactor
      → ExperienceMiner
```

### Main Agent

- Only user-facing agent
- Handles conversation, decisions, progress summaries, requirement changes
- Must remain responsive and idle-ready
- Does not perform background work itself
- Direct mode is a foreground execution lane, not a long-running Main Agent blockage

Canonical Main Agent state machine is defined in `AirPlan/docs/architecture/main-agent-state-machine.md`.

### Architecture Designer

- Architecture planning and impact assessment
- Requirement-change assessment for design/interface/goal changes
- C4/ADR/plan/todo alignment
- Full-cycle architecture review

Canonical implementation/interface/architecture/product escalation rules are defined in `AirPlan/docs/architecture/scope-escalation-v1.md`.

### Scheduler

- Reads TaskGraph
- Computes dependency order, write-area conflicts, waves, retries, workspaces
- Spawns child agents as independent Bun processes
- Monitors heartbeat and progress
- Handles merge coordination

Canonical Scheduler task graph, wave, retry, heartbeat, workspace merge, and recovery state machine is defined in `AirPlan/docs/architecture/scheduler-state-machine-v1.md`.

### Worker Agents

- Executor: implementation/build/test verification
- Reviewer: read-only code/static-analysis review
- Debugger: evidence gathering, diagnosis, instrumentation, fix, verification
- Compactor: copy-on-write context compaction
- ExperienceMiner: memory/skill extraction, patching, promotion suggestions

Worker loops are independent implementations, not one generic shared loop.

## 7. RuntimeEvent and EventStore

Cross-cutting runtime semantics for EventIngestor, heartbeat coalescing, cross-DB/file side effects, compaction ownership, execution primitives, scanner behavior, and learning/skills lifecycle are defined in `AirPlan/docs/architecture/runtime-semantics-v1.md`.

Event envelope:

```ts
interface RuntimeEvent<T = unknown> {
  id: string
  type: string
  version: number
  timestamp: string
  session_id: string
  project_id?: string
  source: EventSource
  route: string[]
  payload: T
}
```

`route` is an append-only structured route chain. Event durability is determined by EventStore based on event type, not by the event producer.

Canonical event names, payload schemas, persistence policy, and producer/consumer rules are defined in `AirPlan/docs/architecture/event-registry-v1.md`.

Persistence rules:

1. Event producers emit valid envelopes but do not decide storage ad hoc.
2. EventStore owns persistence policy by event type.
3. Durable event insert and matching domain table update happen in one SQLite transaction.
4. Ephemeral stream/progress events may be throttled or coalesced by EventBus/ProjectionStore.
5. Event payload schema changes increment that event type's `version`.

V1 durable event families:

```text
session, message, agent, task, tool, command,
artifact, diagnostic, evidence,
context, summary, permission, doctor,
requirement, architecture, workspace, memory, debug
```

V1 ephemeral event families:

```text
agent heartbeat, task progress, assistant message delta,
tool progress, command stdout/stderr delta, HUD frame render
```

## 8. IPC Protocol

Child agents are independent Bun processes.

IPC uses NDJSON over stdio.

Canonical IPC envelopes are defined in `AirPlan/docs/architecture/interface-contracts-v1.md`.

Required V1.0.0 Alpha IPC kinds:

```text
control
event
log
tool.call
tool.result
tool.stream
worker.result
worker.checkpoint
protocol.error
```

All request/response IPC messages include `id`, `direction`, `timestamp`, `session_id`, `agent_id`, and optional `correlation_id`.

- stdout: protocol only
- stderr: crash fallback and fatal diagnostics

Exit codes:

```text
0  protocol-level completion, including task failed/blocked
1  uncaught exception
2  startup/protocol error
3  permission error
4  parent cancelled
5  hard timeout killed
```

## 9. TaskSpec and WorkerResult

### TaskSpec

```ts
interface TaskSpec {
  id: string
  type: "execute" | "review" | "debug" | "compact" | "mine_experience"
  title: string
  description: string
  acceptance_criteria: string[]
  scope: {
    write_area?: string
    expected_files?: string[]
    allowed_paths?: string[]
    denied_paths?: string[]
  }
  dependencies: Array<{
    depends_on_task_id: string
    dependency_type: "hard" | "soft" | "conflict" | "serialization"
    reason?: string
    source?: "architecture" | "scheduler" | "worker" | "user" | "system"
  }>
  verification: {
    commands?: string[]
    required: boolean
    fallback_allowed: boolean
  }
  constraints: {
    max_turns: number
    soft_timeout_ms: number
    hard_timeout_ms: number
    retry_budget: number
    model_policy: "scheduler_forced" | "agent_select"
    model_id?: string
  }
  context_refs: {
    plan_ref?: string
    arc_ref?: string
    parent_task_results?: string[]
    artifacts?: string[]
  }
  output_contract: "ExecutorResult" | "ReviewerResult" | "DebuggerResult" | "CompactorResult" | "ExperienceMinerResult"
}
```

### WorkerResult

```ts
interface WorkerResult<T = unknown> {
  task_id: string
  agent_id: string
  agent_type: "executor" | "reviewer" | "debugger" | "compactor" | "experience_miner"
  status: "completed" | "failed" | "blocked" | "cancelled"
  summary: string
  changed_files: string[]
  diff_ref?: string
  artifacts: ArtifactRef[]
  verification: VerificationResult[]
  risks: Risk[]
  follow_up_tasks: FollowUpTask[]
  evidence_refs: EvidenceRef[]
  result: T
}
```

`failed` means the task goal was not achieved and Scheduler may retry/skip. `blocked` means upper-level decision is needed.

`summary` is a 3–6 sentence human-readable summary covering what was done, evidence, conclusion, and risk. It is not used for scheduling decisions.

## 10. Tool and Capability System

### ToolDefinition

```ts
interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  version: number
  description: string
  input_schema: JsonSchema<I>
  output_schema: JsonSchema<O>
  category: "filesystem" | "shell" | "build" | "test" | "debug" | "static_analysis" | "gui" | "network" | "memory" | "project" | "internal"
  permissions: {
    read_paths?: PathPolicy
    write_paths?: PathPolicy
    execute?: boolean
    network?: boolean
    system_sensitive?: boolean
  }
  streaming: boolean
  execute(input: I, context: ToolExecutionContext): AsyncIterable<ToolEvent> | Promise<ToolResult<O>>
}
```

Inputs and outputs are schema-validated. Streaming tools emit a final `tool.result`.

Canonical V1.0.0 Alpha built-in tool names, input/output schemas, and cut lines are defined in `AirPlan/docs/architecture/tool-registry-v1.md`.

Bash is implemented as `shell.run`, a normal shell tool with extra PermissionEngine risk analysis.

### Capability

Capabilities are runtime-registered tool bundles with dependencies, triggers, evidence types, and config schema.

Canonical capability manifest, source trust, dependency declaration, permission declaration, lifecycle, event namespace, and enable/update rules are defined in `AirPlan/docs/architecture/capability-trust-v1.md`.

Capability manifests declare dependencies; they do not install them directly.

Doctor/setup manages detection and installation.

## 11. Doctor and Dependency Policy

- First startup runs read-only doctor automatically.
- If issues exist, user is prompted to run fix.
- High-permission mode may `announce_then_run` dependency installation after first startup.
- First startup always asks before `doctor --fix`, even in high-permission mode.
- `credentials` and `system_sensitive` dependencies always require explicit confirmation.

## 12. Permission and Security Model

Canonical local security boundaries, permission profiles, path classification, command risk analysis, network policy, credential handling, logs/export rules, and refusal/block conditions are defined in `AirPlan/docs/architecture/security-model-v1.md`.

Core principles:

```text
read → allow
project directory → allow
project-outside non-system → backup then allow
system-sensitive → explicit confirmation
credentials → explicit confirmation
```

Project-outside backups are stored as a git repo at:

```text
<project>/.air/local/backups/
```

## 13. Session DB and Domain State

Session DB path:

```text
<project>/.air/local/sessions/<session-id>/session.db
```

Canonical schema details are defined in `AirPlan/docs/architecture/db-schema-v1.md`.

Canonical message storage:

- `messages` stores complete Anthropic canonical content JSON.
- `message_drafts` stores streaming assistant intermediate state and is deleted after final completion.
- `message_parts` is not a source-of-truth MVP table.

Domain state tables are the source of truth for scheduling/recovery/query:

```text
tasks
task_dependencies
task_attempts
agents
tool_runs
command_runs
artifacts
diagnostics
evidence_refs
workspaces
events
ui_state
```

Query-friendly columns are preferred over parsing JSON. Examples:

- `tool_runs.origin_message_id`
- `command_runs.origin_message_id`
- common artifact foreign keys (`task_id`, `agent_id`, `tool_run_id`, `command_run_id`)
- event source/task/agent/tool/command IDs
- `route_json` plus `route_text`

`ui_state` stores only UI recovery state and is flushed periodically plus on normal exit.

## 14. Contract V1 Type Baseline

Canonical implementation-facing service/interface contracts are defined in `AirPlan/docs/architecture/interface-contracts-v1.md`.

Shared implementation contracts live in a dedicated package:

```text
packages/contracts/
  runtime.ts
  event.ts
  ipc.ts
  task.ts
  worker-result.ts
  tool.ts
  artifact.ts
  project.ts
  provider.ts
  ui.ts
  error.ts
```

Principles:

1. Contracts must be compileable and shared by runtime, TUI, LLM, and toolchain packages.
2. Shape stability matters more than perfect detail in V1.
3. Schema-heavy fields may start as `unknown` and tighten later.
4. ContextPack stays lightweight and reference-based; large context bodies are stored as artifacts/summaries and loaded through ContextAssembler.
5. Domain packages depend on `packages/contracts`; they must not import each other's private types.

Core identity aliases:

```ts
type ISOTimeString = string
type UUID = string
type ProjectID = string
type SessionID = string
type TaskID = string
type AgentID = string
type ToolRunID = string
type CommandRunID = string
type ArtifactID = string
type MessageID = string
```

Core event source:

```ts
interface EventSource {
  kind: "main" | "architecture_designer" | "scheduler" | "agent" | "tool" | "system"
  id?: string
  agent_type?: "executor" | "reviewer" | "debugger" | "compactor" | "experience_miner"
}
```

Control messages:

```ts
type ControlMessage =
  | {
      type: "agent.start"
      version: 1
      task_spec: TaskSpec
      context_pack: ContextPack
      runtime: AgentRuntimeContext
    }
  | { type: "agent.cancel"; reason: string }
  | { type: "agent.pause"; reason: string }
  | { type: "agent.resume" }
  | { type: "agent.extend_timeout"; extra_ms: number; reason: string }

interface AgentRuntimeContext {
  session_id: SessionID
  project_id: ProjectID
  agent_id: AgentID
  worktree_path?: string
  permission_template: "main_direct" | "executor" | "reviewer" | "debugger" | "system"
}
```

ContextPack:

```ts
interface ContextPack {
  refs: {
    plan_ref?: string
    arc_ref?: string
    task_refs?: string[]
    artifact_refs?: string[]
    rule_refs?: string[]
  }
  assembled_context_ref?: string
  notes?: string[]
}
```

Common result helpers:

```ts
interface VerificationResult {
  name: string
  status: "passed" | "failed" | "skipped" | "unknown"
  evidence_refs?: string[]
  notes?: string
}

interface Risk {
  severity: "low" | "medium" | "high"
  summary: string
}

interface FollowUpTask {
  title: string
  description: string
  type?: "execute" | "review" | "debug" | "docs"
}
```

Provider capability matrix, model assignment, adapter conversion, fallback policy, and doctor checks are defined in `AirPlan/docs/architecture/provider-capability-matrix-v1.md`.

Canonical error kinds, severity, retryability, failure signatures, user-facing formatting, and Scheduler routing are defined in `AirPlan/docs/architecture/error-taxonomy-v1.md`.

`TaskSpec`, `WorkerResult`, `RuntimeEvent`, `ToolDefinition`, `ArtifactRef`, and `EvidenceRef` are defined by earlier sections of this baseline and must be exported from `packages/contracts`.

## 15. Artifact Layout

Artifacts live under:

```text
<project>/.air/local/sessions/<session-id>/artifacts/
```

Canonical URI format, artifact ID format, filename conventions, directory mapping, compression, metadata, write protocol, and evidence linking are defined in `AirPlan/docs/architecture/artifact-naming-v1.md`.

## 15. Context and Compaction

ContextAssembler outputs Anthropic canonical messages. Provider conversion happens only at the LLM adapter boundary.

Canonical prompt/context layer order, agent-specific context profiles, conflict handling, and prompt asset locations are defined in `AirPlan/docs/architecture/prompt-layering-v1.md`.

ContextAssembler records omissions and publishes `context.compaction.requested` when compaction is needed; it does not compact itself.

Compaction rules use Markdown + YAML frontmatter.

Rule locations:

```text
built-in default
~/.air/compaction-rules.md
<project>/.air/shared/compaction-rules.md
```

Compaction uses copy-on-write:

```text
snapshot messages 1-N
  → async Compactor subagent
  → new messages keep appending
  → compaction marker inserted when done
  → original messages preserved for explicit backtracking
```

## 16. Memory, Skills, and Debug Knowledge

Project Rules:

```text
<project>/.air/shared/rules/project-rules.md
```

Skills:

```text
~/.air/skills/<skill-name>/SKILL.md
```

ExperienceMiner triggers:

- DebugRecord produced
- session end
- N turns/tool calls interval
- existing skill/rule discovered outdated during execution

Non-debug experiences promote after repeated occurrence and user confirmation. Debug experience confidence comes from evidence and verification, not numeric scoring.

Debug Knowledge is local-first. Sharing/upload is a separate explicit flow and must be redacted/previewed.

## 17. Provider and Model Layer

- Native providers: Anthropic and OpenAI
- Compatibility: OpenRouter, ollama, custom Anthropic/OpenAI-compatible endpoints
- Internal canonical message format: Anthropic content blocks
- Cross-provider conversion happens at the adapter boundary
- Same-provider model switching has no format conversion cost
- Canonical provider/model capability contract is defined in `AirPlan/docs/architecture/provider-capability-matrix-v1.md`

## 18. TUI and HUD

TUI uses OpenTUI/Solid.

Reuse from OpenCode:

- theme system
- dialog/modal/toast patterns
- keymap wrapper
- layout style
- spinner/border/error components
- markdown/code/diff rendering patterns

Do not reuse OpenCode SDK/sync/session business layer.

HUD/TUI consumes ProjectionStore only.

```text
DB persistent state + EventBus live events
  → ProjectionStore
  → TUI/HUD
```

HUD never directly queries SQLite.

## 19. UI Design Asset Capability

AirCoding supports optional `ui-design-assets` capability.

MVP supports:

- ASCII/wireframe mockups
- design specs
- SVG icons
- screenshot design analysis
- prompts for external image generators

Post-MVP supports bitmap image generation/editing via providers.

Generated UI/design assets are artifacts first and must be shown to the user before being written into project files.

## 20. C++ Toolchain V1.0.0 Alpha

`toolchain-cpp` provides:

- BuildTool: CMake built-in, Ninja first then Make fallback
- DiagnosticParser: deterministic compiler/linker output extraction and semantic signatures (LLM-based interpretation belongs to runtime Debugger/Reviewer, not toolchain)
- TestRunner: CTest + GoogleTest first
- StaticAnalysis: cppcheck built-in, clang-tidy later
- CodeIntelligence: clangd CLI mode first
- `compile_commands.json`: generated on demand, not persisted as cache

Build-system conflicts are shown to the user.

BuildTool attempts built-in repair first; unresolved failures route to Debugger.

## 21. Project Initialization

Scanner collects filesystem metadata only:

- full directory tree
- file extension statistics
- special files
- git summary

No directory exclusions and no depth limit.

LLM proposes ProjectProfile; user confirms/corrects.

Project schema lives at:

```text
<project>/.air/shared/project.json
```

Old schema detection triggers migration plan and user confirmation.

## 22. Migration

- Opening a project detects `.air` schema versions.
- Old schema shows a migration plan.
- User confirmation is always required, even in high-permission mode.
- `.air` is backed up first.
- Failure rolls back.

Migration backups should be stored under project-local backup state, e.g.:

```text
<project>/.air/local/backups/migrations/<timestamp>/
```

## 23. Logging and Doctor Bundles

`air.log` is user-readable and contains startup failures, exceptions, and environment configuration issues.

`air.developer.log` is full debug/performance log encrypted with the development team's public key.

Doctor bundles may include full diagnostics and are not automatically redacted. They are never automatically uploaded; user must explicitly export/send them.

Doctor bundles and Debug Knowledge sharing are separate channels:

- doctor bundle: development-team diagnostic channel
- Debug Knowledge: shareable knowledge channel that requires redaction, preview, and explicit authorization

## 24. Testing

- Unit tests: `bun test`, CI, deterministic, no LLM
- Integration tests: CI, recorded LLM fixture replay
- E2E tests: release gate, real LLM, must pass before release
- Platform support levels and release validation matrix are defined in `AirPlan/docs/architecture/cross-platform-matrix-v1.md`

## 25. Distribution

Canonical platform support levels, distribution targets, and release gates are defined in `AirPlan/docs/architecture/cross-platform-matrix-v1.md`.

Early distribution uses binary tarball:

```text
bin/air
resources/
LICENSE
```

Resources include templates, prompts, themes, HUD presets, Python scripts, and toolchain resources.

No public npm/brew/apt/winget channel until stable.

## 26. V1.0.0 Alpha Prerequisite Baselines

This baseline is sufficient for formal architecture design and V1.0.0 Alpha implementation planning. The following prerequisite baselines are frozen for V1:

1. Interface contracts: `AirPlan/docs/architecture/interface-contracts-v1.md`.
2. SQLite schema: `AirPlan/docs/architecture/db-schema-v1.md`.
3. Event payload registry: `AirPlan/docs/architecture/event-registry-v1.md`.
4. Tool registry: `AirPlan/docs/architecture/tool-registry-v1.md`.
5. Scheduler state machine: `AirPlan/docs/architecture/scheduler-state-machine-v1.md`.
6. Prompt layering model: `AirPlan/docs/architecture/prompt-layering-v1.md`.
7. Provider capability matrix: `AirPlan/docs/architecture/provider-capability-matrix-v1.md`.
8. Error taxonomy: `AirPlan/docs/architecture/error-taxonomy-v1.md`.
9. Artifact naming/layout: `AirPlan/docs/architecture/artifact-naming-v1.md`.
10. Scope escalation model: `AirPlan/docs/architecture/scope-escalation-v1.md`.
11. Security model: `AirPlan/docs/architecture/security-model-v1.md`.
12. Capability trust model: `AirPlan/docs/architecture/capability-trust-v1.md`.
13. Cross-platform matrix: `AirPlan/docs/architecture/cross-platform-matrix-v1.md`.
14. Runtime semantics: `AirPlan/docs/architecture/runtime-semantics-v1.md`.

V1.0.0 Alpha scope includes a complete C++ development workflow and local/built-in plugin capability foundation.
