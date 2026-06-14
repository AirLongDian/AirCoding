import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"

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
