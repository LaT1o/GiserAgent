/**
 * submit_plan 工具（计划提交）——SDK customTools 模块。
 *
 * Plan 模式专用（经 effectiveTools 编排：plan 激活 / act 排除，
 * 语义对齐 Claude Code 的 ExitPlanMode 与 Cline 的计划审批）。
 * 模型调研完成后调用本工具提交结构化计划，前端将 tool.input 渲染为
 * 计划卡片并出现「按此计划执行」按钮；服务端不解析、不落额外状态，
 * 计划内容随 tool.started/input 事件落盘（回放天然支持）。
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export function createSubmitPlanTool(): ToolDefinition {
  return defineTool({
    name: "submit_plan",
    label: "提交计划",
    description:
      "提交结构化执行计划（仅规划模式可用）。调研完成后调用本工具提交计划供用户审批：" +
      "steps 为有序步骤数组（3~8 步为宜，每步一句话，写清做什么与产出物）。" +
      "提交后计划会展示给用户，用户点击「按此计划执行」后才开始执行；" +
      "提交本身不产生任何副作用，提交前也不要执行任何修改操作。",
    promptSnippet: "submit a structured plan for user approval (plan mode only)",
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({ description: "计划标题（一句话概括目标，可选）" })
      ),
      steps: Type.Array(Type.String({ description: "单个执行步骤，一句话" }), {
        minItems: 2,
        maxItems: 15,
        description: "有序执行步骤（3~8 步为宜，按执行顺序排列）",
      }),
    }),
    async execute(_toolCallId, params) {
      const steps = params.steps.map((s) => s.trim()).filter(Boolean);
      if (steps.length < 2) {
        throw new Error(`steps 至少需要 2 个有效步骤（收到 ${steps.length} 个）`);
      }
      const plan = {
        steps,
        ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `计划已提交（${steps.length} 步），等待用户确认后执行。`,
          },
        ],
        details: plan,
      };
    },
  });
}
