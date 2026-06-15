import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import fs from "fs"
import path from "path"

const STATE_FILE = ".air/local/state/scheduler-state.json"

function readState(projectDir: string): Record<string, unknown> {
  const filePath = path.join(projectDir, STATE_FILE)
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return { tasks: [], activeJobs: [], lastActivity: Date.now(), wave: 0 }
  }
}

function writeState(projectDir: string, state: Record<string, unknown>): void {
  const filePath = path.join(projectDir, STATE_FILE)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)
}

// --- coordinator_listen ---

const ListenParams = Schema.Struct({
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: "Wait timeout in milliseconds, default 600000 (10 minutes)",
  }),
})

type ListenMetadata = {
  completedCount?: number
  timedOutCount?: number
}

export const CoordinatorListenTool = Tool.define(
  "coordinator_listen",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description:
        "Wait for background Worker tasks to complete and return their results. Used by the Scheduler to monitor Worker progress.",
      parameters: ListenParams,
      execute: (params: Schema.Schema.Type<typeof ListenParams>, _ctx: Tool.Context<ListenMetadata>) =>
        Effect.gen(function* () {
          const timeout = params.timeout_ms ?? 600_000
          const jobs = yield* background.list()
          const activeJobs = jobs.filter((j) => j.status === "running")

          if (activeJobs.length === 0) {
            return {
              title: "coordinator_listen",
              metadata: {} as ListenMetadata,
              output: "没有活跃的后台任务。",
            }
          }

          const results: Array<{ id: string; status: string; output?: string; error?: string }> = []
          for (const job of activeJobs) {
            const waitResult = yield* background.wait({ id: job.id, timeout })
            if (waitResult.timedOut) {
              results.push({ id: job.id, status: "timeout" })
            } else if (waitResult.info) {
              results.push({
                id: job.id,
                status: waitResult.info.status,
                output: waitResult.info.output,
                error: waitResult.info.error,
              })
            }
          }

          const completed = results.filter((r) => r.status !== "timeout" && r.status !== "running")
          const timedOut = results.filter((r) => r.status === "timeout")
          const lines: string[] = []

          if (completed.length > 0) {
            lines.push(`## 已完成的任务 (${completed.length})`)
            for (const r of completed) {
              lines.push(`\n### ${r.id} — ${r.status}`)
              if (r.status === "completed" && r.output) lines.push(r.output.slice(0, 2000))
              if (r.status === "error" && r.error) lines.push(`错误: ${r.error.slice(0, 1000)}`)
            }
          }
          if (timedOut.length > 0) {
            lines.push(`\n## 超时的任务 (${timedOut.length})`)
            for (const r of timedOut) lines.push(`- ${r.id}: 仍在运行中`)
          }

          return {
            title: "coordinator_listen",
            metadata: { completedCount: completed.length, timedOutCount: timedOut.length },
            output: lines.join("\n") || "等待超时，无任务完成。",
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ListenParams, ListenMetadata>
  }),
)

// --- coordinator_status ---

const StatusParams = Schema.Struct({})

type StatusMetadata = {
  total?: number
  running?: number
  completed?: number
  errors?: number
}

export const CoordinatorStatusTool = Tool.define(
  "coordinator_status",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description: "Query all background Worker tasks and return their current status.",
      parameters: StatusParams,
      execute: (_params: Schema.Schema.Type<typeof StatusParams>, _ctx: Tool.Context<StatusMetadata>) =>
        Effect.gen(function* () {
          const jobs = yield* background.list()

          if (jobs.length === 0) {
            return {
              title: "coordinator_status",
              metadata: {} as StatusMetadata,
              output: "当前没有后台任务。",
            }
          }

          const lines: string[] = [`## 后台任务状态 (${jobs.length})`, ""]
          for (const job of jobs) {
            const elapsed = job.started_at ? Math.round((Date.now() - job.started_at) / 1000) : 0
            lines.push(`- **${job.title ?? job.id}** — ${job.status} (${elapsed}s)`)
            if (job.status === "error" && job.error) lines.push(`  错误: ${job.error.slice(0, 200)}`)
          }

          return {
            title: "coordinator_status",
            metadata: {
              total: jobs.length,
              running: jobs.filter((j) => j.status === "running").length,
              completed: jobs.filter((j) => j.status === "completed").length,
              errors: jobs.filter((j) => j.status === "error").length,
            },
            output: lines.join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof StatusParams, StatusMetadata>
  }),
)

// --- coordinator_save_state ---

const SaveStateParams = Schema.Struct({
  state: Schema.String.annotate({
    description: "JSON-formatted scheduler state",
  }),
})

export const CoordinatorSaveStateTool = Tool.define(
  "coordinator_save_state",
  Effect.gen(function* () {
    return {
      description: "Save scheduler state to disk (.air/local/state/scheduler-state.json) for crash recovery.",
      parameters: SaveStateParams,
      execute: (params: Schema.Schema.Type<typeof SaveStateParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const worktree = (ctx.extra?.worktree as string | undefined) ?? process.cwd()
          const parsed = JSON.parse(params.state)
          parsed.lastActivity = Date.now()
          writeState(worktree, parsed)
          return {
            title: "coordinator_save_state",
            metadata: {},
            output: "调度状态已保存。",
          }
        }),
    } satisfies Tool.DefWithoutID<typeof SaveStateParams, Record<string, never>>
  }),
)

// --- coordinator_load_state ---

const LoadStateParams = Schema.Struct({})

export const CoordinatorLoadStateTool = Tool.define(
  "coordinator_load_state",
  Effect.gen(function* () {
    return {
      description: "Load scheduler state from disk (.air/local/state/scheduler-state.json) for crash recovery.",
      parameters: LoadStateParams,
      execute: (_params: Schema.Schema.Type<typeof LoadStateParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const worktree = (ctx.extra?.worktree as string | undefined) ?? process.cwd()
          const state = readState(worktree)
          return {
            title: "coordinator_load_state",
            metadata: {},
            output: JSON.stringify(state, null, 2),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof LoadStateParams, Record<string, never>>
  }),
)

// --- coordinator_tick ---

interface TaskGraphTask {
  id: string
  type: "execute" | "review" | "debug"
  title: string
  description?: string
  status: "pending" | "running" | "pending_review" | "completed" | "failed" | "blocked"
  phase?: number
  dependencies?: Array<string | { task_id: string; type?: string }>
  scope?: {
    expected_files?: string[]
    denied_paths?: string[]
    preserved_paths?: string[]
  }
  acceptance_criteria?: string[]
  verification?: {
    commands?: string[]
    required?: boolean
    evidence_types?: string[]
  }
  constraints?: {
    max_turns?: number
    retry_budget?: number
    soft_timeout_ms?: number
    hard_timeout_ms?: number
  }
  contracts?: {
    provides?: Array<{ module: string; kind: string; spec: string; stability: string }>
    requires?: Array<{ module: string; kind: string; spec: string; stability: string }>
  }
  retry_count?: number
}

interface TaskGraph {
  version?: number
  tasks: TaskGraphTask[]
  phases?: Array<{ id: number; name: string; milestone_review?: boolean; milestone_review_count?: number; milestone_satisfied?: boolean }>
  architect_dispatch_total?: number
}

interface TickResult {
  task_id: string
  worker_type: string
  status: string
  has_cppcheck?: boolean
  output_text?: string
}

function readTaskGraph(projectDir: string): TaskGraph | null {
  const filePath = path.join(projectDir, ".air", "shared", "plan", "task-graph.json")
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

function writeTaskGraph(projectDir: string, graph: TaskGraph): void {
  const filePath = path.join(projectDir, ".air", "shared", "plan", "task-graph.json")
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)
}

function getDependencyIds(task: TaskGraphTask): string[] {
  if (!task.dependencies) return []
  return task.dependencies.map((d) => (typeof d === "string" ? d : d.task_id))
}

// --- Code gates: fallback keyword detection ---

// Strong signals: almost always indicate design downgrade, flag unconditionally
const FALLBACK_STRONG_CN = [
  "先硬编码", "先跑通", "先回退", "先跳过", "暂时绕过",
]

const FALLBACK_STRONG_EN = [
  "hardcode first", "hard-code for now", "get it working first",
  "make it run first", "rollback first", "revert first",
  "skip for now", "skip it for now", "bypass temporarily",
]

// Soft signals: ambiguous in isolation, only flag when accompanied by a completion claim
const FALLBACK_SOFT_CN = [
  "先这样", "以后再改", "以后补上", "兜底方案", "临时方案",
]

const FALLBACK_SOFT_EN = [
  "for now", "just do this", "temporary solution",
  "fix later", "change later", "refactor later",
  "add later", "implement later",
  "workaround", "fallback solution", "backup approach",
  "interim approach", "stopgap",
]

// Completion markers: a Worker claiming "done" while using fallback language = hard violation
const COMPLETION_MARKERS = [
  "编译通过", "测试通过", "任务完成", "状态.*completed",
  "tests? pass", "build.*(?:pass|succeed|success)",
  "cppcheck.*(?:通过|pass|clean|no.*issue)",
  "(?:completed|finished|done)\\s*$",
  "审查结论.*PASS", "无严重问题",
]

function detectStrongFallback(text: string): string[] {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const kw of FALLBACK_STRONG_CN) if (text.includes(kw)) found.push(kw)
  for (const kw of FALLBACK_STRONG_EN) if (lower.includes(kw)) found.push(kw)
  return found
}

function detectContextualFallback(text: string): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  // Check if text contains any completion marker
  const hasCompletion = COMPLETION_MARKERS.some((m) => new RegExp(m, "i").test(text))
  if (!hasCompletion) return [] // no completion claim → not a downgrade attempt

  // With completion markers present, soft keywords become actionable
  for (const kw of FALLBACK_SOFT_CN) if (text.includes(kw)) hits.push(kw)
  for (const kw of FALLBACK_SOFT_EN) if (lower.includes(kw)) hits.push(kw)

  // Proximity check: soft keyword must be within ~300 chars of a completion marker
  return hits.filter((kw) => {
    const kwIdx = lower.indexOf(kw)
    if (kwIdx === -1) return false
    return COMPLETION_MARKERS.some((m) => {
      const match = new RegExp(m, "i").exec(text)
      if (!match) return false
      return Math.abs(kwIdx - match.index) < 300
    })
  })
}

// TODO only flagged as fallback when it defers design-level implementation
const TODO_FALLBACK_PATTERN = /TODO.*(?:以后|later|补|implement|fix|refactor|设计|design)/i

function detectFallbackKeywords(text: string): string[] {
  const strong = detectStrongFallback(text)
  const contextual = detectContextualFallback(text)
  const found = [...strong, ...contextual]
  if (TODO_FALLBACK_PATTERN.test(text)) found.push("TODO (降级标记)")
  return found
}

function hasCodeToDesignTable(text: string): boolean {
  return (
    text.includes("逐行对照") ||
    text.includes("对照表") ||
    text.includes("匹配状态") ||
    /code.to.design.*table/i.test(text) ||
    /design.*point.*code.*location/i.test(text) ||
    /设计要点.*代码位置/i.test(text)
  )
}

const SURFACE_EVIDENCE_PATTERNS = [
  /(?:tests?\s*(?:all\s*)?(?:pass|green|passed))/i,
  /(?:测试\s*(?:全绿|pass|通过))/,
  /(?:function\s*exists|函数存在)/i,
  /(?:file\s*exists|文件存在)/i,
  /(?:typecheck|build|lint)\s*(?:passed|通过)/i,
  /(?:looks?\s*(?:correct|right|fine)|看起来?正确|应该.*对)/i,
  /(?:compilation\s*succeeded|编译成功)/i,
]

function detectSurfaceEvidenceOnlyPass(text: string): boolean {
  const hasPassConclusion = /(?:PASS|审查结论.*PASS|通过.*审查)/i.test(text)
  const hasDesignComparison = hasCodeToDesignTable(text)
  // PASS without design comparison = surface evidence only
  if (hasPassConclusion && !hasDesignComparison) return true
  // Check if the ONLY reasoning given is surface evidence
  const surfaceCount = SURFACE_EVIDENCE_PATTERNS.filter((p) => p.test(text)).length
  return hasPassConclusion && surfaceCount >= 2 && !hasDesignComparison
}

function buildWorkerPrompt(task: TaskGraphTask): string {
  const lines: string[] = []
  lines.push(`## 任务: ${task.title}`)
  lines.push(`类型: ${task.type}`)
  lines.push("")
  if (task.description) {
    lines.push(`### 描述`)
    lines.push(task.description)
    lines.push("")
  }
  if (task.acceptance_criteria?.length) {
    lines.push("### 验收标准")
    for (const c of task.acceptance_criteria) lines.push(`- ${c}`)
    lines.push("")
  }
  if (task.scope) {
    lines.push("### 文件范围")
    if (task.scope.expected_files?.length) lines.push(`可修改: ${task.scope.expected_files.join(", ")}`)
    if (task.scope.denied_paths?.length) lines.push(`禁止: ${task.scope.denied_paths.join(", ")}`)
    if (task.scope.preserved_paths?.length) lines.push(`保留: ${task.scope.preserved_paths.join(", ")}`)
    lines.push("")
  }
  if (task.verification?.commands?.length) {
    lines.push("### 验证命令")
    for (const cmd of task.verification.commands) lines.push(`- \`${cmd}\``)
    lines.push("")
  }
  if (task.verification?.evidence_types?.length) {
    lines.push(`### 需要的证据类型: ${task.verification.evidence_types.join(", ")}`)
    lines.push("")
  }
  lines.push("### 完成要求")
  lines.push("- 编译通过 + 测试通过 + cppcheck --enable=all 无严重问题")
  lines.push("- 结果中必须包含 cppcheck 输出")
  return lines.join("\n")
}

function buildReviewPrompt(task: TaskGraphTask, workerResult: string): string {
  return [
    `## Code-to-Design 审查: ${task.title}`,
    "",
    "请严格按照三层流程审查 Worker 实现（逐行对照 → 静态审查 → 测试验证）。",
    "审查报告必须包含全部六个章节，缺少任一章节 = 无效审查，将被退回重审。",
    "",
    "### Worker 结果",
    workerResult.slice(0, 3000),
    "",
    "### 审查输出要求（必须完整）",
    "",
    "一、Code-to-Design 逐行对照表（表格格式，每个设计要点一行）",
    "   | # | 设计要点（来源） | 代码位置（文件:行号） | 匹配状态 | 说明 |",
    "   匹配状态用：✅匹配 / ⚠️偏差 / ❌遗漏 / 🚫越界",
    "",
    "二、逐项审查（架构一致性、依赖方向、接口一致性、越界检查、功能完整性、降级关键词检测）",
    "",
    "三、静态审查（安全性：注入/越权/输入校验；正确性：边界/并发/资源；合规性：架构铁律/降级实现）",
    "",
    "四、测试/构建验证（仅在前三层全 PASS 后才填入）",
    "",
    "五、问题列表（FAIL 时，格式：[严重程度] 问题描述 — 文件:行号 — 设计依据）",
    "",
    "六、修复建议（FAIL 时，引用 plan.md 对应设计要点）",
    "",
    "### 禁止的判定依据",
    "禁止以「测试pass」「函数存在」「文件存在」「build通过」「typecheck通过」「看起来正确」作为 PASS 理由。",
    "必须逐行对照设计文档后才可判定。",
    "",
    "### 审查结论",
    "审查结论: PASS / FAIL",
  ].join("\n")
}

function buildDebugPrompt(task: TaskGraphTask, errorInfo: string): string {
  return [
    `## 调试任务: ${task.title}`,
    `类型: debug`,
    "",
    "### 错误信息",
    errorInfo.slice(0, 2000),
    "",
    "### 调试要求",
    "1. 先取证：通过 shell 执行 cppcheck --enable=all 进行静态分析",
    "2. 分析错误根因",
    "3. 修复后重新编译 + 测试 + cppcheck",
    "4. 输出根因和修复方案",
  ].join("\n")
}

function buildAntiFallbackPrompt(task: TaskGraphTask, keywords: string[]): string {
  return [
    `## 退回重做（降级实现）: ${task.title}`,
    `类型: debug`,
    "",
    `### 检测到的降级关键词: ${keywords.join(", ")}`,
    "",
    "输出中包含以降级措辞描述的简化实现。以下行为不可接受：",
    "- 以「先这样」「先跑通」「以后再改」「以后补上」「先回退」「先硬编码」「暂时绕过」「兜底方案」「临时方案」等理由使用简化实现",
    '- 以 "for now" "temporary solution" "fix later" "workaround" "fallback" 等理由跳过设计',
    "",
    "### 要求",
    "1. 移除所有以降级措辞描述的简化实现、硬编码、占位符",
    "2. 严格按照 .air/shared/plan/plan.md 中的设计方案完整实现",
    "3. 完整实现后重新编译 + 测试 + cppcheck --enable=all",
    "4. 输出中不得再出现任何降级措辞",
    `5. 本次是第 ${(task.retry_count ?? 0) + 1} 次重试，仍有 ${(task.constraints?.retry_budget ?? 3) - (task.retry_count ?? 0) - 1} 次机会`,
  ].join("\n")
}

function buildReReviewPrompt(task: TaskGraphTask, reasonMissingTable: boolean, reasonSurfaceOnly: boolean): string {
  const issues: string[] = []
  if (reasonMissingTable) issues.push("- 审查报告缺少「逐行对照表」（code-to-design table），必须补充")
  if (reasonSurfaceOnly) issues.push("- 审查报告仅凭表面证据（测试pass/函数存在/build通过）判定 PASS，不成立")
  return [
    `## 重审（审查报告不合格）: ${task.title}`,
    "",
    "上一次审查报告被调度器拒绝，原因：",
    ...issues,
    "",
    "### 必须满足的要求",
    "1. 必须生成完整的「一、Code-to-Design 逐行对照表」（表格格式，每个设计要点一行）",
    "   表头: | # | 设计要点（来源） | 代码位置（文件:行号） | 匹配状态 | 说明 |",
    "   匹配状态: ✅匹配 / ⚠️偏差 / ❌遗漏 / 🚫越界",
    "2. 禁止以测试通过/函数存在/编译通过等表面证据作为 PASS 理由",
    "3. 按三层流程执行：逐行对照 → 静态审查（安全/正确/合规）→ 测试验证",
    "4. 审查报告必须包含全部六个章节（一至六）",
  ].join("\n")
}

const TickParams = Schema.Struct({
  results: Schema.optional(Schema.String).annotate({
    description:
      'JSON array of completed task results: [{"task_id":"t-001","worker_type":"worker","status":"completed","has_cppcheck":true}]',
  }),
})

type TickMetadata = {
  actions?: number
  readyTasks?: number
  transitions?: number
}

export const CoordinatorTickTool = Tool.define(
  "coordinator_tick",
  Effect.gen(function* () {
    return {
      description: [
        "确定性调度引擎：读取 task-graph.json，处理已完成任务的状态转换，",
        "找出下一批可调度的任务（DAG 入度=0），返回结构化行动清单。",
        "Scheduler 只需按清单调用 task 工具派发，无需自行决策调度逻辑。",
      ].join(""),
      parameters: TickParams,
      execute: (params: Schema.Schema.Type<typeof TickParams>, ctx: Tool.Context<TickMetadata>) =>
        Effect.gen(function* () {
          const worktree = (ctx.extra?.worktree as string | undefined) ?? process.cwd()

          const graph = readTaskGraph(worktree)
          if (!graph || !graph.tasks?.length) {
            return {
              title: "coordinator_tick",
              metadata: {} as TickMetadata,
              output: "task-graph.json 不存在或无任务。请先派发 architect 进行架构设计。",
            }
          }

          const taskMap = new Map(graph.tasks.map((t) => [t.id, t]))
          const actions: Array<{
            action: string
            task_id: string
            subagent_type: string
            prompt: string
            description: string
          }> = []

          // Phase 1: Process completed results — state machine transitions
          let transitions = 0
          if (params.results) {
            const results: TickResult[] = JSON.parse(params.results)
            for (const result of results) {
              const task = taskMap.get(result.task_id)
              if (!task) continue

              transitions++

              // Handle architect milestone_review results
              if (result.worker_type === "architect") {
                const phaseMatch = result.task_id.match(/^phase-(\d+)$/)
                if (phaseMatch && graph.phases) {
                  const phaseId = parseInt(phaseMatch[1], 10)
                  const phaseObj = graph.phases.find((p) => p.id === phaseId)
                  if (phaseObj) {
                    phaseObj.milestone_satisfied = true
                  }
                }
                continue
              }

              if (result.worker_type === "worker" && result.status === "completed") {
                // Gate A: detect fallback keywords in worker output
                if (result.output_text) {
                  const fallbackHits = detectFallbackKeywords(result.output_text)
                  if (fallbackHits.length > 0) {
                    const retryCount = task.retry_count ?? 0
                    const budget = task.constraints?.retry_budget ?? 3
                    if (retryCount < budget) {
                      task.retry_count = retryCount + 1
                      task.status = "pending"
                      actions.push({
                        action: "dispatch_debugger",
                        task_id: task.id,
                        subagent_type: "worker",
                        prompt: buildAntiFallbackPrompt(task, fallbackHits),
                        description: `退回重做（降级关键词: ${fallbackHits.slice(0, 3).join(", ")}）`,
                      })
                    } else {
                      task.status = "blocked"
                    }
                    continue
                  }
                }
                if (!result.has_cppcheck) {
                  task.status = "running"
                  actions.push({
                    action: "dispatch_worker",
                    task_id: task.id,
                    subagent_type: "worker",
                    prompt:
                      `## 补跑 cppcheck\n上一次执行缺少 cppcheck 输出。\n\n` +
                      `请对以下文件运行 cppcheck --enable=all 并输出结果：\n` +
                      (task.scope?.expected_files?.join("\n") ?? "所有修改过的文件"),
                    description: `补跑 cppcheck: ${task.title}`,
                  })
                  continue
                }
                task.status = "pending_review"
                actions.push({
                  action: "dispatch_reviewer",
                  task_id: task.id,
                  subagent_type: "reviewer",
                  prompt: buildReviewPrompt(task, result.task_id),
                  description: `审查: ${task.title}`,
                })
              } else if (result.worker_type === "worker" && result.status === "failed") {
                const retryCount = task.retry_count ?? 0
                const budget = task.constraints?.retry_budget ?? 3
                if (retryCount < budget) {
                  task.retry_count = retryCount + 1
                  task.status = "pending"
                  actions.push({
                    action: "dispatch_debugger",
                    task_id: task.id,
                    subagent_type: "worker",
                    prompt: buildDebugPrompt(task, `Worker 执行失败，第 ${retryCount + 1}/${budget} 次重试`),
                    description: `调试: ${task.title}`,
                  })
                } else {
                  task.status = "blocked"
                }
              } else if (result.worker_type === "reviewer" && result.status === "completed") {
                // Gate B: verify reviewer output contains code-to-design table
                if (result.output_text) {
                  const hasTable = hasCodeToDesignTable(result.output_text)
                  const surfaceOnly = detectSurfaceEvidenceOnlyPass(result.output_text)
                  if (!hasTable || surfaceOnly) {
                    task.status = "pending_review"
                    actions.push({
                      action: "dispatch_reviewer",
                      task_id: task.id,
                      subagent_type: "reviewer",
                      prompt: buildReReviewPrompt(task, !hasTable, surfaceOnly),
                      description: `重审（${!hasTable ? "缺少逐行对照表" : "仅凭表面证据判定"}）`,
                    })
                    continue
                  }
                }
                task.status = "completed"
              } else if (result.worker_type === "reviewer" && result.status === "failed") {
                // If reviewer report lacks code-to-design table, re-dispatch reviewer
                const retryCount = task.retry_count ?? 0
                if (result.output_text && !hasCodeToDesignTable(result.output_text)) {
                  if (retryCount < 2) {
                    task.retry_count = retryCount + 1
                    task.status = "pending_review"
                    actions.push({
                      action: "dispatch_reviewer",
                      task_id: task.id,
                      subagent_type: "reviewer",
                      prompt: buildReReviewPrompt(task, true, false),
                      description: `重审（审查报告缺少逐行对照表）`,
                    })
                  } else {
                    task.status = "blocked"
                  }
                  continue
                }
                if (retryCount < 2) {
                  task.retry_count = retryCount + 1
                  task.status = "pending"
                } else {
                  task.status = "blocked"
                }
              }
            }
          }

          // Phase 2: Find ready tasks (DAG: in-degree 0, all deps completed)
          const readyTasks: TaskGraphTask[] = []
          for (const task of graph.tasks) {
            if (task.status !== "pending") continue
            const depIds = getDependencyIds(task)
            const allDepsCompleted = depIds.every((id) => {
              const dep = taskMap.get(id)
              return dep?.status === "completed"
            })
            if (allDepsCompleted) readyTasks.push(task)
          }

          for (const task of readyTasks) {
            task.status = "running"
            actions.push({
              action: "dispatch_worker",
              task_id: task.id,
              subagent_type: "worker",
              prompt: buildWorkerPrompt(task),
              description: task.title,
            })
          }

          // Phase 3: Check phase milestones (2 retries per phase, 5 total across all phases)
          let milestonePhase: number | undefined
          if (graph.phases) {
            const totalArchitectDispatch = graph.architect_dispatch_total ?? 0
            for (const phase of graph.phases) {
              if (!phase.milestone_review) continue
              if (phase.milestone_satisfied) continue   // architect already reviewed, OK
              const phaseDispatchCount = phase.milestone_review_count ?? 0
              if (phaseDispatchCount >= 2) continue     // per-phase retry budget exhausted
              if (totalArchitectDispatch >= 5) continue  // global budget exhausted
              const phaseTasks = graph.tasks.filter((t) => t.phase === phase.id)
              const allDone = phaseTasks.every((t) => t.status === "completed")
              const anyRunning = phaseTasks.some((t) => t.status === "running" || t.status === "pending_review")
              if (allDone && phaseTasks.length > 0) {
                milestonePhase = phase.id
                phase.milestone_review_count = phaseDispatchCount + 1  // pre-increment on dispatch
                graph.architect_dispatch_total = totalArchitectDispatch + 1
                actions.push({
                  action: "milestone_review",
                  task_id: `phase-${phase.id}`,
                  subagent_type: "architect",
                  prompt: [
                    `## 里程碑审查: Phase ${phase.id} — ${phase.name}`,
                    "",
                    `本阶段共 ${phaseTasks.length} 个任务，全部已完成。`,
                    "请执行里程碑审查，检查跨模块一致性。",
                    "",
                    "### 本阶段任务",
                    ...phaseTasks.map((t) => `- ${t.id}: ${t.title}`),
                  ].join("\n"),
                  description: `里程碑审查: Phase ${phase.name}`,
                })
              }
              if (anyRunning) break
            }
          }

          // Phase 4: Check overall completion
          const allCompleted = graph.tasks.every((t) => t.status === "completed" || t.status === "blocked")
          const pendingCount = graph.tasks.filter((t) => t.status === "pending").length
          const runningCount = graph.tasks.filter((t) => t.status === "running").length
          const blockedCount = graph.tasks.filter((t) => t.status === "blocked").length

          // Write updated state
          writeTaskGraph(worktree, graph)
          const state = readState(worktree)
          state.lastActivity = Date.now()
          state.pendingCount = pendingCount
          state.runningCount = runningCount
          state.blockedCount = blockedCount
          state.milestonePhase = milestonePhase
          writeState(worktree, state)

          // Build output
          const lines: string[] = []
          lines.push(`## 调度状态`)
          lines.push(`- 总任务: ${graph.tasks.length}`)
          lines.push(`- 已完成: ${graph.tasks.filter((t) => t.status === "completed").length}`)
          lines.push(`- 运行中: ${runningCount}`)
          lines.push(`- 待调度: ${pendingCount}`)
          lines.push(`- 阻塞: ${blockedCount}`)
          if (graph.phases?.some((p) => p.milestone_review)) {
            const totalUsed = graph.architect_dispatch_total ?? 0
            lines.push(`- Architect 派发预算: 已用 ${totalUsed}/5（每阶段最多 2 次）`)
          }
          lines.push("")

          if (actions.length > 0) {
            lines.push(`## 行动清单 (${actions.length} 项)`)
            lines.push("")
            lines.push("请按以下清单逐项调用 task 工具派发：")
            lines.push("")
            for (let i = 0; i < actions.length; i++) {
              const a = actions[i]
              lines.push(`### ${i + 1}. ${a.action} — ${a.description}`)
              lines.push(`- task_id: ${a.task_id}`)
              lines.push(`- subagent_type: ${a.subagent_type}`)
              lines.push(`- background: true`)
              lines.push(`- prompt:`)
              lines.push("```")
              lines.push(a.prompt)
              lines.push("```")
              lines.push("")
            }
          }

          if (allCompleted && actions.length === 0) {
            lines.push("## 所有任务已完成")
            if (blockedCount > 0) lines.push(`⚠️ 有 ${blockedCount} 个任务被阻塞，需要人工介入。`)
          }

          if (actions.length === 0 && !allCompleted && runningCount === 0) {
            lines.push("## 无可用行动")
            lines.push("所有就绪任务已派发，等待 Worker 完成。请调用 coordinator_listen 等待结果。")
          }

          return {
            title: `coordinator_tick: ${actions.length} actions`,
            metadata: { actions: actions.length, readyTasks: readyTasks.length, transitions },
            output: lines.join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof TickParams, TickMetadata>
  }),
)
