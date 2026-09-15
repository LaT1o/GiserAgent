/**
 * plan/act 模式门控扩展（改编自 Pi 官方示例 plan-mode）。
 *
 * plan 模式（只读调研出计划）：
 * - bash 仅放行只读命令白名单（正则集移植自官方示例 utils.ts 的 isSafeCommand）
 * - opengis 族（含结构化动作）、arcgis 与 map_* 地图工具直接阻止（读写数据或产出地图图层）
 * - 每次 agent 启动前注入模式提示，引导输出带编号的计划
 * - 切回 act 后通过 context 事件过滤历史 plan 模式提示，避免上下文残留
 *
 * 工具集切换（plan 下移除 write/edit/opengis/arcgis/map_*）由 PiAdapter 统一通过
 * setActiveToolsByName 完成；本扩展的拦截是双保险。
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionControlState } from "./permissions.js";
import { isReadOnlyBashCommand } from "./commandRisk.js";
import { isMapToolName, isOpenGisToolName } from "../../../webgis.js";

// 兼容既有引用：plan 模式用严格只读判定（不随 Act 智能批准的工作区写放宽变化）
export { isReadOnlyBashCommand as isSafeCommand } from "./commandRisk.js";

const PLAN_CONTEXT_TYPE = "giser-plan-context";

const PLAN_MODE_PROMPT = `[PLAN MODE ACTIVE - 规划模式]
你当前处于规划模式（只读调研）。

限制：
- write / edit / opengis 族 / arcgis 与地图工具（map_*）等可产生副作用的工具已禁用
- bash 仅允许只读命令（cat / ls / grep / find / git status 等），写操作命令会被拦截
- 文件读取受会话读取权限范围限制

请先调研理解问题，然后调用 submit_plan 工具提交结构化计划：
- title：一句话概括目标（可选）
- steps：有序步骤数组（3~8 步为宜，每步一句话，写清做什么与产出物）

计划会展示给用户审批，用户点击「按此计划执行」后才会开始执行。
不要尝试直接执行修改——只调研和提交计划。`;

export interface PlanModeGuardOptions {
  getState: () => SessionControlState;
  /** 阻止发生时登记 toolCallId，供 PiAdapter 将该调用标记为失败 */
  blockedCalls: Set<string>;
}

export function createPlanModeGuard(options: PlanModeGuardOptions): InlineExtension {
  return {
    name: "giser-plan-mode",
    hidden: true,
    factory: (pi) => {
      // plan 模式下的双保险拦截：bash 白名单 + opengis/arcgis/map_* 禁用
      pi.on("tool_call", async (event) => {
        const state = options.getState();
        if (state.mode !== "plan") return undefined;

        if (isOpenGisToolName(event.toolName) || event.toolName === "arcgis" || isMapToolName(event.toolName)) {
          options.blockedCalls.add(event.toolCallId);
          return {
            block: true,
            reason: "规划模式禁止执行代码与产出 GIS 结果。请仅调研并输出计划；切换到执行模式后才能运行。",
          };
        }
        if (event.toolName === "bash") {
          const command = (event.input as { command?: unknown }).command;
          if (typeof command === "string" && !isReadOnlyBashCommand(command)) {
            options.blockedCalls.add(event.toolCallId);
            return {
              block: true,
              reason: `规划模式仅允许只读命令，已拦截: ${command.slice(0, 200)}\n请仅调研并输出计划。`,
            };
          }
        }
        return undefined;
      });

      // plan 模式每轮注入模式提示（对 LLM 可见、前端不显示）
      pi.on("before_agent_start", async () => {
        if (options.getState().mode !== "plan") return undefined;
        return {
          message: {
            customType: PLAN_CONTEXT_TYPE,
            content: PLAN_MODE_PROMPT,
            display: false,
          },
        };
      });

      // act 模式下把历史 plan 模式提示从上下文过滤掉（避免残留累积）
      pi.on("context", async (event) => {
        if (options.getState().mode === "plan") return undefined;
        const messages = event.messages.filter((m) => {
          const msg = m as { customType?: string };
          return msg.customType !== PLAN_CONTEXT_TYPE;
        });
        return { messages };
      });
    },
  };
}
