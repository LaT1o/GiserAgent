/**
 * 审批门控扩展（InlineExtension，进程内）。
 *
 * 对配置的工具在执行前挂起整个 Agent，等待外部（经 SSE → 浏览器 →
 * approve API）的人工确认；拒绝时返回 block，原因会作为工具错误结果
 * 回传给 LLM，Agent 可据此调整行为。
 */

import { randomUUID } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ApprovalRequest {
  requestId: string;
  tool: string;
  callId: string;
  input: unknown;
  summary: string;
}

export interface ApprovalGateOptions {
  /** 需要确认的工具名列表 */
  tools: string[];
  /**
   * 由 PiAdapter 提供的桥：返回 true 放行、false 拒绝。
   * 实现方负责发 approval.required 事件、登记 pending 表与超时兜底。
   */
  onRequest: (req: ApprovalRequest) => Promise<boolean>;
  /**
   * 跳过审批的判定（返回 true 直接放行）。
   * 用于 plan 模式下白名单只读命令：门控扩展已保证安全，无需重复人工确认。
   */
  skip?: (tool: string, input: unknown) => boolean;
}

/** 生成供前端展示的操作摘要 */
export function summarizeToolInput(tool: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (tool === "bash" && typeof record.command === "string") {
    return record.command.slice(0, 300);
  }
  if (tool === "opengis" || tool === "python") {
    if (typeof record.code === "string") {
      const firstLine = record.code.split("\n").find((l) => l.trim()) ?? "";
      return (record.code.length > 120 ? `${firstLine.slice(0, 120)} …` : firstLine) || "(openGIS 代码)";
    }
    if (typeof record.script === "string") return record.script;
  }
  if ((tool === "write" || tool === "edit" || tool === "read") && typeof record.path === "string") {
    return record.path;
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "(无法序列化的入参)";
  }
}

export function createApprovalGate(options: ApprovalGateOptions): InlineExtension {
  const toolSet = new Set(options.tools);
  return {
    name: "approval-gate",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (!toolSet.has(event.toolName)) return undefined;
        if (options.skip?.(event.toolName, event.input)) return undefined;
        const ok = await options.onRequest({
          requestId: randomUUID(),
          tool: event.toolName,
          callId: event.toolCallId,
          input: event.input,
          summary: summarizeToolInput(event.toolName, event.input),
        });
        if (!ok) {
          return { block: true, reason: "用户拒绝了本次工具执行。请勿原样重试，先向用户说明并询问如何继续。" };
        }
        return undefined;
      });
    },
  };
}
