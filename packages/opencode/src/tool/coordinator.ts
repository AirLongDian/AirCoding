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
  status: "pending" | "running" | "pending_review" | "pending_rvr" | "completed" | "failed" | "blocked"
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
    airrvr_review_retry_budget?: number
  }
  contracts?: {
    provides?: Array<{ module: string; kind: string; spec: string; stability: string }>
    requires?: Array<{ module: string; kind: string; spec: string; stability: string }>
  }
  retry_count?: number
  airrvr_review_retry_count?: number
  rvr_completed?: boolean
  rvr_results?: string[]
  rvr_count?: number
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
  /** T-1.26 / P1-26: scheduler 可显式声明本轮提交的 R-XX 报告编号（与文本扫描互为补充）
   *  - 提供此字段：coordinator_tick 会先用该声明核对编号是否齐全，再用文本扫描验证内容
   *  - 不提供此字段：coordinator_tick 仅依赖 output_text 文本扫描
   */
  airrvr_reports?: string[]
  rvr_id?: string
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

// ============================================================================
// T-1.26 / P1-26 + P1-27: AirRvr 强制路由 — 16 项专项审查硬门禁
// 设计文档: docs/airplanV2-Qwen3.7-Max设计.md §3.7.4
//
// 不变量（L1 代码级强制）:
//   INV-RVR-1: Worker status="completed" 必须包含 R-01~R-16 全部 16 项专项报告
//              任一缺失 → coordinator_tick 退回重做 / 超预算 blocked
//   INV-RVR-2: Reviewer 审查结论必须对 R-01~R-16 逐项给出明确判定
//              任一未评估 → coordinator_tick 退回重审 / 超预算 blocked
//   INV-RVR-3: coordinator_tick 是唯一允许把 task.status 设为 "completed"
//              的代码位置，因此是唯一允许通过门禁的位置
// ============================================================================

const AIRRVR_REQUIRED_REPORTS: readonly string[] = [
  "R-01","R-02","R-03","R-04","R-05","R-06","R-07","R-08",
  "R-09","R-10","R-11","R-12","R-13","R-14","R-15","R-16",
] as const

/** Worker 产出要求的专项报告（不含 R-16 ASan/TSan/UBSan，该项仅 RVR 阶段执行） */
const AIRRVR_WORKER_GATE_REPORTS: readonly string[] = [
  "R-01","R-02","R-03","R-04","R-05","R-06","R-07","R-08",
  "R-09","R-10","R-11","R-12","R-13","R-14","R-15",
] as const

const AIRRVR_SPEC: Record<string, { name: string; task: string; tools: string; execRequired: boolean }> = {
  "R-01": { name: "智能指针审计", task: "grep 搜索 new/malloc/delete 和裸指针声明，逐处确认是否用 unique_ptr/shared_ptr/weak_ptr 持有所有权；裸指针仅允许作为非持有观察指针", tools: "grep + read", execRequired: false },
  "R-02": { name: "RAII 包装审计", task: "grep 搜索 fopen/socket/pthread_mutex_init/new 等资源获取处，逐处确认有对应 RAII 包装类析构释放；文件/socket/mutex/线程/定时器/DB 连接必须 RAII", tools: "grep + read", execRequired: false },
  "R-03": { name: "循环依赖审查", task: "read CMakeLists.txt 的 target_link_libraries + grep #include 链，构建依赖图，确认头文件/CMake target/运行时组件三层无环", tools: "read + grep", execRequired: false },
  "R-04": { name: "异常安全审查", task: "grep throw/catch/noexcept/new/malloc 和 IO 操作调用，逐函数检查异常路径是否有资源释放；确认 RAII 在异常路径能正确析构", tools: "grep + read", execRequired: false },
  "R-05": { name: "对象生命周期竞态", task: "grep std::thread/std::async/std::mutex/lambda 捕获，逐处检查异步/跨线程上下文中的指针引用、迭代器、shared_ptr 循环引用", tools: "grep + read", execRequired: false },
  "R-06": { name: "架构引用合规", task: "read .air/shared/plan/plan.md 的模块依赖图 + CMakeLists.txt 的 target_link_libraries 对照，确认依赖方向符合 C4 模块边界，无反向/跨层依赖", tools: "read + grep", execRequired: false },
  "R-07": { name: "Code-to-Design 逐行对照", task: "read plan.md + ADR 全部设计要点 + 每个变更源文件，逐函数逐行对照；列出每个设计要点的代码位置和匹配状态；代码中「后续任务」「由X实现」「TODO:功能」等将设计功能前推到不存在任务的前向引用 → 自动 FAIL", tools: "read", execRequired: false },
  "R-08": { name: "CMakeList 配置", task: "在板端执行 cmake configure + build，确认全部 target 编译通过；输出完整编译日志", tools: "bash", execRequired: true },
  "R-09": { name: "测试覆盖率与执行", task: "read 测试源文件，逐场景对照需求检查覆盖完整性；检查关键数据字段（路径/缓冲区/输出参数）是否被实际赋值使用，若空则功能未实现；在板端执行 Catch2 + CTest 全部测试，输出完整测试日志", tools: "bash + read", execRequired: true },
  "R-10": { name: "有效注释率 ≥ 60%", task: "read 每个变更源文件，统计有效注释行数（意图/不变量/前后置条件/复杂度说明）÷ 总行数，每文件独立计算，输出统计表", tools: "read", execRequired: false },
  "R-11": { name: "关键流程日志", task: "grep spdlog/LOG_/log_ 调用，确认关键函数入口/出口/异常/状态变更处有日志语句；检查 release/debug 级别切换配置", tools: "grep + read", execRequired: false },
  "R-12": { name: "Watchdog 心跳初始化", task: "grep watchdog/heartbeat 相关调用，确认 CORE 模块的 watchdog 注册和周期心跳发送已配置；非 CORE 模块输出 SKIP 并说明原因", tools: "grep", execRequired: false },
  "R-13": { name: "Debug 断言 + 仿真实环境测试", task: "grep assert/#ifdef DEBUG/NDEBUG 确认调试断言存在且不影响 release；在 RK3588 aarch64 / Kylin V10 板端执行全功能仿真实环境测试，输出完整测试日志", tools: "bash + grep", execRequired: true },
  "R-14": { name: "禁止降级兜底", task: "grep Worker 输出和所有变更源文件中的降级关键词（先这样/先跑通/以后再改/兜底方案/hardcode first/for now/temporary solution/workaround 等），命中即 FAIL，列出每个命中的文件:行号", tools: "grep", execRequired: false },
  "R-15": { name: "终焉审查引擎 静态交叉审查", task: "路径 A（引擎可用）：检查环境变量 $env:Abyssal-Watch-Engine → abyssal-watch.exe doctor --probe --json → scan --project ... --out ... --json → verify --report ... --json；\n路径 B（引擎不可用，板端手动）：在板端依次执行 Infer、Cppcheck --enable=all、Clang-Tidy、Semgrep 四工具，输出完整日志，交叉核对结论一致性；\n两条路径都必须达到：全部工具真实执行、零发现零缺口、输出完整报告，任一条件不满足 → FAIL", tools: "bash", execRequired: true },
  "R-16": { name: "动态 Sanitizer 审查", task: "在板端编译并执行 ASan + TSan + UBSan 全套动态检测，Qt 项目额外 QTEST；输出完整日志，确认无内存/线程/未定义行为报错", tools: "bash", execRequired: true },
}

function buildRvrWorkerPrompt(rvrId: string, task: TaskGraphTask, reviewerOutput: string): string {
  const spec = AIRRVR_SPEC[rvrId]
  if (!spec) return `## RVR 审查: ${rvrId}\n\n执行对应的专项审查。`
  const rvrInstructions: string[] = []
  if (rvrId === "R-15") {
    rvrInstructions.push(
      "### 引擎路径判断（仅 R-15）",
      "- 先读取环境变量 `$env:Abyssal-Watch-Engine`",
      "- **若已设置**：用该路径下的 abyssal-watch.exe 执行 doctor --probe → scan → verify 全流程，每条命令带 --json，退出码和 JSON exit_code 必须一致为 0，state=PASSED + release_eligible=true + finding_count=0 + gap_count=0",
      "- **若未设置**：在板端手动执行：Infer → Cppcheck --enable=all → Clang-Tidy → Semgrep，输出四份完整日志，交叉核对结论一致性",
      "- 无论走哪条路径，全部工具必须真实执行、零发现零缺口、输出完整报告，任一不满足 → FAIL",
      "- 禁止：跳过任何工具、解析自然语言 PASS、复用旧输出目录",
    )
  }
  return [
    `## 三方测试工程师: ${spec.name} (${rvrId})`,
    "",
    "你是独立第三方测试工程师，不隶属于 Worker 团队，不信任任何已有的自述结论。",
    "你的唯一职责是对当前任务执行本专项审查，以实际工具产出作为唯一证据来源。",
    "Worker 的结论、Reviewer 的推断、任何外部声明均不可绕过你的独立验证。",
    "",
    `### 审查任务`,
    spec.task,
    ...(rvrInstructions.length > 0 ? rvrInstructions : []),
    "",
    `### 使用的工具`,
    spec.tools,
    "",
    `### 执行要求`,
    spec.execRequired
      ? "- 此项必须在 RK3588 aarch64 / Kylin V10 板端实际执行工具，输出完整日志"
      : "- 此项通过 read/glob/grep 工具审查代码即可，**必须实际调用工具**",
    "- 输出格式：先写判定（PASS/FAIL/SKIP），然后附完整证据（文件:行号 / 命令输出 / 日志片段）",
    "- 不得仅写一个 PASS 词而没有具体证据",
    "- **禁止**以「整体看起来 OK」「从 Worker 输出看没问题」等二手推断代替亲自执行工具",
    "",
    "### 原始任务信息",
    `任务: ${task.title}`,
    task.description ? `描述: ${task.description}` : "",
    "",
    "### Reviewer 审查结论（参考，不可替代你的独立审查）",
    reviewerOutput.slice(0, 2000),
  ].filter(Boolean).join("\n")
}

/**
 * 检测 worker output_text 是否显式包含 R-01~R-15（不含 R-16 ASan/TSan/UBSan）专项报告。
 * R-16 仅在 RVR 阶段由三方测试子代理执行，不在 Worker 门禁要求范围内。
 */
function validateAirRvrReports(
  text: string,
  declared: string[] = [],
): {
  present: string[]
  missing: string[]
  complete: boolean
} {
  const empty = !text || text.trim().length === 0
  if (empty) {
    return {
      present: [],
      missing: [...AIRRVR_WORKER_GATE_REPORTS],
      complete: false,
    }
  }

  const present: string[] = []
  for (const r of AIRRVR_WORKER_GATE_REPORTS) {
    // Word-boundary style matching: R-XX 必须独立出现
    // 例如 "R-01" 后不能紧跟数字或字母（避免 R-011 误匹配 R-01）
    const re = new RegExp(
      `${r.replace("-", "\\-")}(?![A-Za-z0-9])`,
      "i",
    )
    if (re.test(text)) present.push(r)
  }

  // 若 scheduler 显式声明了 airrvr_reports 但文本找不到，仍以文本扫描为准
  // （防 LLM 在声明字段作弊写"已提交 R-01"但实际未产出）
  if (declared.length > 0) {
    const declaredSet = new Set(declared)
    for (const r of AIRRVR_WORKER_GATE_REPORTS) {
      if (declaredSet.has(r) && !present.includes(r)) {
        // 声明但文本未找到 → 视为缺失（LLM 不可信）
      }
    }
  }

  const missing = AIRRVR_WORKER_GATE_REPORTS.filter((r) => !present.includes(r))
  return { present: [...present], missing: [...missing], complete: missing.length === 0 }
}

/**
 * 检测 reviewer output_text 是否对 R-01~R-16 每一项都给出了明确判定 + 实质性证据。
 *
 * 两层检查：
 * 1. 判定词必须出现在 R-XX 编号之后 400 字符的窗口内
 * 2. 判定词旁的窗口内必须有足够长的证据内容（非仅 verdict / label）
 *
 * 允许的判定词：
 *   PASS | FAIL | BLOCK | SKIP | PASSED | FAILED | BLOCKED | SKIPPED
 *   通过 | 未通过 | 阻断 | 跳过 | 条件式 | 已审查 | 未审查
 *
 * MIN_EVIDENCE_CHARS: 判定词之外必须有至少这么多字符的实质内容，
 * 防止 LLM 写 "R-01: PASS" 一行填表打勾绕过审查。
 */
const MIN_EVIDENCE_CHARS = 40

function validateAirRvrReviewCoverage(text: string): {
  reviewed: string[]
  unreviewed: string[]
  noEvidence: string[]
  allCovered: boolean
} {
  const empty = !text || text.trim().length === 0
  if (empty) {
    return {
      reviewed: [],
      unreviewed: [...AIRRVR_REQUIRED_REPORTS],
      noEvidence: [],
      allCovered: false,
    }
  }

  const verdictRe =
    /(?:PASS(?:ED)?|FAIL(?:ED)?|BLOCK(?:ED)?|SKIP(?:PED)?|通过|未通过|阻断|跳过|条件式|已审查|未审查)/i

  // Label/verdict-specific words to strip when counting evidence
  const labelPattern = /^(R-\d{2}[:\s]*)/
  const separatorPattern = /[\s─\|•·:,.。，、]+/g

  function countEvidence(chunk: string, verdictMatch: string): number {
    // Remove R-XX label and verdict word from the window
    let cleaned = chunk.replace(labelPattern, "").replace(new RegExp(verdictMatch, "gi"), "")
    // Remove table separators / punctuation-only lines
    cleaned = cleaned.replace(separatorPattern, " ").trim()
    return cleaned.length
  }

  const reviewed: string[] = []
  const noEvidence: string[] = []
  for (const r of AIRRVR_REQUIRED_REPORTS) {
    const re = new RegExp(`${r.replace("-", "\\-")}(?![A-Za-z0-9])`, "gi")
    let match: RegExpExecArray | null
    let foundVerdict = false
    let hasEvidence = false
    while ((match = re.exec(text)) !== null) {
      const start = match.index + match[0].length
      const end = Math.min(text.length, start + 400)
      const window = text.slice(start, end)
      const verdictMatch = window.match(verdictRe)
      if (verdictMatch) {
        foundVerdict = true
        // Check evidence: enough non-label/non-verdict content in the window
        const evidenceChars = countEvidence(window, verdictMatch[0])
        if (evidenceChars >= MIN_EVIDENCE_CHARS) {
          hasEvidence = true
          break
        }
      }
    }
    if (foundVerdict && !hasEvidence) {
      noEvidence.push(r)
    }
    if (foundVerdict && hasEvidence) {
      reviewed.push(r)
    }
  }

  const unreviewed = AIRRVR_REQUIRED_REPORTS.filter((r) => !reviewed.includes(r))
  return {
    reviewed: [...reviewed],
    unreviewed: [...unreviewed],
    noEvidence: [...noEvidence],
    allCovered: unreviewed.length === 0,
  }
}

function buildAirRvrWorkerRetryPrompt(task: TaskGraphTask, missing: string[]): string {
  const retryCount = task.retry_count ?? 0
  const budget = task.constraints?.retry_budget ?? 3
  const remaining = Math.max(0, budget - retryCount)
  const spec = [
    ["R-01", "智能指针审计", "unique_ptr/shared_ptr/weak_ptr; 裸指针仅作为非持有观察指针"],
    ["R-02", "RAII 包装审计", "文件/socket/mutex/线程/定时器/DB 连接必须 RAII 包装"],
    ["R-03", "循环依赖审查", "头文件/CMake target/运行时组件 三层无环"],
    ["R-04", "异常安全审查", "风险操作有异常处理，RAII 在异常路径释放资源"],
    ["R-05", "对象生命周期竞态", "异步捕获指针 / 迭代器失效 / 跨线程对象构造析构"],
    ["R-06", "架构引用合规", "依赖方向符合 C4 模块边界，禁止反向/跨层依赖"],
    ["R-07", "Code-to-Design 逐行对照", "对照 plan.md 与 ADR 的每个设计要点，「后续任务」前向引用 → 自动 FAIL"],
    ["R-08", "CMakeList 配置", "cmake configure + build 全通过"],
    ["R-09", "测试覆盖率与执行", "Catch2 + CTest 配置，覆盖全部场景 + 数据流完整性（空字段即未实现）"],
    ["R-10", "有效注释率 ≥ 60%", "仅计有效注释（意图/不变量/前后置条件/复杂度说明）"],
    ["R-11", "关键流程日志", "spdlog 级别切换 debug/release，关键路径落点齐全"],
    ["R-12", "Watchdog 心跳初始化", "仅 CORE 模块审查"],
    ["R-13", "Debug 断言 + 仿真实环境测试", "Debug 模式断言 + 目标设备全功能测试（**Arc 必须参与**）"],
    ["R-14", "禁止降级兜底", "禁止「先这样」「先跑通」「以后再改」「兜底方案」「hardcode first」等降级措辞"],
    ["R-15", "Abyssal Watch Engine 静态交叉审查", "Infer + Cppcheck + Clang-Tidy + Semgrep，严格遵守 doctor→scan→verify"],
  ]
  const table = spec
    .map(([id, name, point]) => `| ${id} | ${name} | ${point} |`)
    .join("\n")
  const missingList = missing.map((r) => `- ${r} ${spec.find((s) => s[0] === r)?.[1] ?? ""}`).join("\n")
  return [
    `## 退回重做（缺失 AirRvr 专项报告）: ${task.title}`,
    `类型: worker（T-1.26 AirRvr 强制路由）`,
    "",
    `### 检测到的缺失专项 (${missing.length}/15)`,
    missingList,
    "",
    "### CLAUDE.md 铁律（L1 代码级强制，不可绕过）",
    "Worker 的 status=\"completed\" 必须包含 R-01~R-15 全部 15 项专项报告（R-16 ASan/TSan/UBSan 仅 RVR 阶段执行），",
    "任一缺失 → coordinator_tick 退回重做；超预算 → blocked。",
    "本约束不可被任何「先跑通」「以后再补」等降级措辞绕过。",
    "",
    "### 15 项专项审查清单（必须全部出现在你的输出中）",
    "| ID | 名称 | 审查要点 |",
    "|---|---|---|",
    table,
    "",
    "### 强制步骤",
    "1. 在输出中**明确写出每个 R-01~R-15 的专项审查结果**（每项都必须显式提到，包括判定和证据）",
    "2. 执行 Abyssal Watch Engine 全流程（R-15）: `doctor --probe → scan → verify`，五项强制条件核对",
    "3. R-07 / R-13 必须派发 architect 子代理参与",
    "4. 重新编译 + 测试 + cppcheck --enable=all",
    "5. 输出中不得再出现任何降级措辞",
    "",
    `本次是第 ${retryCount}/${budget} 次重试，仍有 ${remaining} 次机会。`,
  ].join("\n")
}

function buildAirRvrReviewerReReviewPrompt(task: TaskGraphTask, unreviewed: string[]): string {
  const reviewRetry = task.airrvr_review_retry_count ?? 0
  const reviewBudget = task.constraints?.airrvr_review_retry_budget ?? 2
  const remaining = Math.max(0, reviewBudget - reviewRetry)
  const unreviewedList = unreviewed.map((r) => `- ${r}`).join("\n")
  return [
    `## 重审（审查覆盖度不足）: ${task.title}`,
    `类型: reviewer（T-1.26 AirRvr 强制路由）`,
    "",
    "### coordinator_tick 退回原因",
    "上一次审查报告中部分 AirRvr 专项审查未给出明确判定。",
    "",
    `### 缺失明确判定的专项 (${unreviewed.length}/16)`,
    unreviewedList,
    "",
    "### 强制要求（L1 代码级）",
    "1. 审查报告中每项 R-01~R-16 都必须给出明确判定词：",
    "   PASS / FAIL / BLOCK / SKIP / PASSED / FAILED / BLOCKED / SKIPPED / 通过 / 未通过 / 阻断 / 条件式",
    "2. 判定词必须紧跟 R-XX 编号出现（400 字符窗口内），便于 coordinator_tick 解析",
    "3. 禁止以「整体看起来 OK」「总体符合要求」「无严重问题」等模糊判定替代逐项明确判定",
    "4. 仍需满足 Code-to-Design 逐行对照表要求",
    "5. 仍需满足禁止 surface-evidence-only PASS 要求",
    "6. 必须以第三方测试身份审查，禁止以 Worker / Arc 同源上下文自我确认",
    "",
    `本次是第 ${reviewRetry}/${reviewBudget} 次重审，仍有 ${remaining} 次机会。`,
  ].join("\n")
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
  const items = [
    ["R-01", "智能指针审计", "unique_ptr/shared_ptr/weak_ptr 持有所有权；裸指针仅作非持有观察"],
    ["R-02", "RAII 包装审计", "文件/socket/mutex/线程/定时器/DB 连接必须 RAII 包装"],
    ["R-03", "循环依赖审查", "头文件 #include / CMake target / 运行时组件 三层无环"],
    ["R-04", "异常安全审查", "风险操作有异常处理，RAII 在异常路径释放资源"],
    ["R-05", "对象生命周期竞态", "异步/跨线程上下文中的指针、迭代器、shared_ptr 循环引用"],
    ["R-06", "架构引用合规", "依赖方向符合 C4 模块边界，禁止反向/跨层依赖"],
    ["R-07", "Code-to-Design 逐行对照", "对照 plan.md 与 ADR 每个设计要点，前向引用 → 自动 FAIL"],
    ["R-08", "CMakeList 配置", "cmake configure + build 全通过"],
    ["R-09", "测试覆盖率与执行", "Catch2 + CTest 配置，覆盖全部场景 + 关键输出字段非空"],
    ["R-10", "有效注释率 ≥ 60%", "仅计有效注释（意图/不变量/前后置条件/复杂度说明），每文件独立"],
    ["R-11", "关键流程日志", "spdlog 级别可切换，关键路径落点齐全"],
    ["R-12", "Watchdog 心跳初始化", "仅 CORE 模块审查；非 CORE 附证据给 SKIP"],
    ["R-13", "Debug 断言 + 仿真实环境测试", "Debug 断言（不影响 release）+ 目标设备全功能测试"],
    ["R-14", "禁止降级兜底", "扫描 Worker 输出 + 代码中降级关键词，命中即 FAIL"],
    ["R-15", "静态交叉审查", "Infer + Cppcheck + Clang-Tidy + Semgrep 四工具报告交叉验证"],
    ["R-16", "动态 Sanitizer 审查", "ASan + TSan + UBSan 全部通过（Qt 加 QTEST）"],
  ]
  const checklist = items
    .map(([id, name, point]) => `| ${id} | ${name} | ${point} | 待你使用 read/grep/glob 检查后填写 |`)
    .join("\n")
  return [
    `## 审查任务（AirRvr 16 项强制审查）: ${task.title}`,
    "",
    "你必须以第三方测试身份独立审查 Worker 的实现。",
    "**以下 16 项每项必须使用 read/glob/grep 工具检查代码后给出判定，不得仅写判定词。**",
    "PASS 必须附：你用了什么工具 + 读了哪些文件 + 看到了什么证据。",
    "Worker 未提供执行证据的项（编译日志/测试日志/Sanitizer 输出等）直接给 FAIL，不得用 SKIP 代替。",
    "",
    "### Worker 输出（交叉验证用）",
    workerResult.slice(0, 4000),
    "",
    "### AirRvr 16 项审查清单（每项必须填，不得留空）",
    "",
    "| ID | 名称 | 要点 | 你的审查结论（判定 + 工具 + 文件 + 证据） |",
    "|---|---|---|---|",
    checklist,
    "",
    "### 输出要求",
    "",
    "一、Code-to-Design 逐行对照表（R-07，表格格式，每设计要点一行）",
    "   | # | 设计要点（来源） | 代码位置（文件:行号） | 匹配状态 | 说明 |",
    "   匹配状态：✅匹配 / ⚠️偏差 / ❌遗漏 / 🚫越界",
    "",
    "二、AirRvr 16 项证据审查表（使用上表格式，每项附具体证据，不可仅写 PASS/FAIL）",
    "",
    "三、问题列表（FAIL 项：[HIGH/MEDIUM/LOW] [R-XX] 问题描述 — 文件:行号 — 设计依据）",
    "",
    "四、修复建议（引用 plan.md 对应设计要点）",
    "",
    "五、审查统计（工具调用次数、读取文件清单、PASS/FAIL/SKIP 计数）",
    "",
    "### 禁止行为",
    "- 禁止未调用 read/grep/glob 工具就给 PASS",
    "- 禁止以「测试pass」「文件存在」「看起来正确」作为 PASS 理由",
    "- 禁止对缺失证据的项给 SKIP（Worker 没提供编译日志/测试日志/Sanitizer 输出 → FAIL）",
    "- 禁止仅写「R-01: PASS」而没有任何证据内容",
    "- 禁止信任 Worker 的自述结论，必须亲自读代码交叉验证",
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
            rvr_id?: string
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
                // RVR sub-agent result (16 三方测试子代理) — accumulate, skip normal worker gates
                if (result.rvr_id && task.status === "pending_rvr") {
                  if (!task.rvr_results) task.rvr_results = []
                  task.rvr_results.push(`${result.rvr_id}: ${result.output_text?.slice(0, 3000) ?? ""}`)
                  task.rvr_count = (task.rvr_count ?? 0) + 1
                  continue
                }

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
                // T-1.26 / INV-RVR-1: Worker 必须包含 R-01~R-16 全部 16 项专项报告
                // L1 代码级强制，缺失任何一个 → 退回重做 / 超预算 blocked
                const airrvrTextCheck = validateAirRvrReports(
                  result.output_text ?? "",
                  result.airrvr_reports ?? [],
                )
                if (!airrvrTextCheck.complete) {
                  const retryCount = task.retry_count ?? 0
                  const budget = task.constraints?.retry_budget ?? 3
                  if (retryCount < budget) {
                    task.retry_count = retryCount + 1
                    task.status = "pending"
                    actions.push({
                      action: "dispatch_worker",
                      task_id: task.id,
                      subagent_type: "worker",
                      prompt: buildAirRvrWorkerRetryPrompt(task, airrvrTextCheck.missing),
                      description: `退回重做（缺少 AirRvr 专项报告: ${airrvrTextCheck.missing.slice(0, 3).join(", ")}${airrvrTextCheck.missing.length > 3 ? ` (+${airrvrTextCheck.missing.length - 3})` : ""}）`,
                    })
                  } else {
                    task.status = "blocked"
                  }
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
                // T-1.26 / INV-RVR-3: Reviewer 完成后强制派发 16 专项审查子代理
                // 跳过 AirRvr 覆盖度检查（Reviewer 不可能产出 16 项真实证据），直接进入 RVR 阶段
                const reviewerText = result.output_text ?? ""
                if (task.rvr_completed) {
                  // RVR 阶段已完成，此为汇总 Reviewer 输出 → 终检后 completed
                  const coverage = validateAirRvrReviewCoverage(reviewerText)
                  if (coverage.allCovered) {
                    task.status = "completed"
                  } else {
                    task.status = "blocked"
                  }
                } else {
                  // RVR 阶段未执行 → 强制派发 16 个三方测试子代理
                  task.status = "pending_rvr"
                  task.rvr_results = []
                  task.rvr_count = 0
                  for (const rvrId of AIRRVR_REQUIRED_REPORTS) {
                    actions.push({
                      action: "dispatch_rvr_worker",
                      task_id: task.id,
                      rvr_id: rvrId,
                      subagent_type: "worker",
                      prompt: buildRvrWorkerPrompt(rvrId, task, reviewerText),
                      description: `三方测试 ${rvrId} ${AIRRVR_SPEC[rvrId]?.name ?? ""}`,
                    })
                  }
                }
                continue
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

          // RVR completion check: after all 16 RVR workers done, dispatch consolidation Reviewer
          for (const task of graph.tasks) {
            if (task.status === "pending_rvr" && (task.rvr_count ?? 0) >= 16) {
              task.rvr_completed = true
              task.status = "pending_review"
              const consolidated = (task.rvr_results ?? []).join("\n\n---\n\n")
              actions.push({
                action: "dispatch_reviewer",
                task_id: task.id,
                subagent_type: "reviewer",
                prompt: [
                  `## 审查汇总（RVR 16 专项审查结果）: ${task.title}`,
                  "",
                  "你是汇总审查器。以下 16 项已由三方测试子代理独立完成，请逐项审核证据完整性并给出最终判定。",
                  "汇总报告中必须包含 R-01~R-16 每项的：三方测试判定、证据摘要、你的最终验证意见。",
                  "如果某项证据缺失或不足以支撑 PASS，该项给 FAIL。",
                  "",
                  "特别检查：",
                  "- R-15（终焉审查引擎）：必须包含 doctor --probe / scan / verify 三个阶段完整日志，五项强制条件全部核对",
                  "- R-16（动态 Sanitizer）：ASan / TSan / UBSan 必须全部无报错",
                  "- R-08 / R-09 / R-13：必须在板端执行，日志中必须有板端环境标识",
                  "",
                  "### 16 专项审查结果",
                  consolidated,
                ].join("\n"),
                description: `审查汇总: ${task.title}`,
              })
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
