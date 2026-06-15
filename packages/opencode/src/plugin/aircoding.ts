import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"

// Strong signals: almost always indicate design downgrade
const FALLBACK_STRONG_CN = [
  "先硬编码", "先跑通", "先回退", "先跳过", "暂时绕过",
]
const FALLBACK_STRONG_EN = [
  "hardcode first", "hard-code for now", "get it working first",
  "make it run first", "rollback first", "revert first",
  "skip for now", "skip it for now", "bypass temporarily",
]
// Soft signals: only flag when near a completion claim
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
const COMPLETION_MARKERS = [
  "编译通过", "测试通过", "任务完成", "状态.*completed",
  "tests? pass", "build.*(?:pass|succeed|success)",
  "cppcheck.*(?:通过|pass|clean|no.*issue)",
  "(?:completed|finished|done)\\s*$",
  "审查结论.*PASS", "无严重问题",
]
const TODO_FALLBACK_PATTERN = /TODO.*(?:以后|later|补|implement|fix|refactor|设计|design)/i

const SURFACE_EVIDENCE_PATTERNS = [
  /(?:tests?\s*(?:all\s*)?(?:pass|green|passed))/i,
  /(?:测试\s*(?:全绿|pass|通过))/,
  /(?:function\s*exists|函数存在)/i,
  /(?:file\s*exists|文件存在)/i,
  /(?:typecheck|build|lint)\s*(?:passed|通过)/i,
  /(?:looks?\s*(?:correct|right|fine)|看起来?正确|应该.*对)/i,
  /(?:compilation\s*succeeded|编译成功)/i,
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
  const hasCompletion = COMPLETION_MARKERS.some((m) => new RegExp(m, "i").test(text))
  if (!hasCompletion) return []
  for (const kw of FALLBACK_SOFT_CN) if (text.includes(kw)) hits.push(kw)
  for (const kw of FALLBACK_SOFT_EN) if (lower.includes(kw)) hits.push(kw)
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

function detectSurfaceEvidenceOnlyPass(text: string): boolean {
  const hasPassConclusion = /(?:PASS|审查结论.*PASS|通过.*审查)/i.test(text)
  if (!hasPassConclusion) return false
  const hasDesignComparison = hasCodeToDesignTable(text)
  if (hasDesignComparison) return false
  const surfaceCount = SURFACE_EVIDENCE_PATTERNS.filter((p) => p.test(text)).length
  return surfaceCount >= 1
}

export async function AirCodingPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return

      const subagentType = output.args?.subagent_type
      if (subagentType !== "scheduler") return

      const planDir = path.join(process.cwd(), ".air", "shared", "plan")
      const planExists = fs.existsSync(path.join(planDir, "plan.md"))
      const graphExists = fs.existsSync(path.join(planDir, "task-graph.json"))

      if (planExists && graphExists) return

      const existingPrompt = output.args.prompt ?? ""
      const missing: string[] = []
      if (!planExists) missing.push("plan.md")
      if (!graphExists) missing.push("task-graph.json")

      output.args = {
        ...output.args,
        prompt:
          `[AirCoding 系统指令] 当前项目缺少架构规划文件：${missing.join("、")}。\n` +
          "你必须先通过 task 工具派发 architect 子代理进行架构设计和任务规划，\n" +
          "等待 Architect 完成后再调用 coordinator_tick 开始调度。\n" +
          "不要跳过架构设计直接派工。\n\n---\n\n" +
          existingPrompt,
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return

      const subagentType = input.args?.subagent_type

      if (subagentType === "worker") {
        const resultText = output.output ?? ""
        const hasCppcheckOutput =
          resultText.includes("Checking ") ||
          resultText.includes("no issues found") ||
          resultText.includes("cppcheck:") ||
          resultText.match(/\d+ errors?, \d+ warnings?/) !== null ||
          (resultText.toLowerCase().includes("cppcheck") && resultText.includes("--enable"))
        if (!hasCppcheckOutput) {
          output.output =
            resultText +
            "\n\n⚠️ [AirCoding 验证] Worker 结果缺少有效的 cppcheck 输出。" +
            "cppcheck 输出应包含 'Checking <file>' 或 'no issues found' 或错误/警告统计。" +
            "请重新派发 Worker 并要求运行 cppcheck --enable=all。"
        }
        // Defense layer: detect fallback keywords in worker output
        const fallbackHits = detectFallbackKeywords(resultText)
        if (fallbackHits.length > 0) {
          output.output =
            resultText +
            "\n\n🚫 [AirCoding 降级检测] Worker 输出中检测到降级关键词：" +
            fallbackHits.slice(0, 5).join("、") +
            "。以降级方案代替设计实现不可接受。" +
            "请移除所有临时实现、硬编码、兜底方案，按设计方案完整实现。"
        }
      }

      if (subagentType === "reviewer") {
        const resultText = output.output ?? ""
        const hasTable = hasCodeToDesignTable(resultText)
        const surfaceOnly = detectSurfaceEvidenceOnlyPass(resultText)
        const issues: string[] = []
        if (!hasTable) {
          issues.push(
            "审查报告缺少「Code-to-Design 逐行对照表」。" +
            "必须包含表格格式的逐行对照：| # | 设计要点 | 代码位置 | 匹配状态 | 说明 |"
          )
        }
        if (surfaceOnly) {
          issues.push(
            "审查报告仅凭表面证据（测试pass/函数存在/build通过）判定 PASS。不成立。" +
            "必须逐行对照设计文档后才可判定。"
          )
        }
        if (issues.length > 0) {
          output.output =
            resultText +
            "\n\n🚫 [AirCoding 审查质量检查] 审查报告不合格：\n" +
            issues.map((i) => "- " + i).join("\n") +
            "\n\n请重新审查，按三层流程（逐行对照 → 静态审查 → 测试验证）产出完整审查报告。"
        }
      }

      if (subagentType === "architect") {
        const resultText = output.output ?? ""
        if (!resultText.includes(".air/shared/plan")) {
          output.output =
            resultText +
            "\n\n[AirCoding 验证] 请确认 Architect 已写入 .air/shared/plan/plan.md 和 task-graph.json。"
        }
        if (!resultText.includes("AGENTS.md")) {
          output.output =
            (output.output ?? resultText) +
            "\n\n[AirCoding 验证] Architect 未提及 AGENTS.md。请确认已产出或更新项目根目录的 AGENTS.md 文件。"
        }
      }
    },
  }
}
