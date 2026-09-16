/**
 * Windows shell 惯用法防护扩展。
 *
 * 背景：bash 工具经 Git Bash（MSYS）执行，模型常写 cmd 风格的 `2>nul` 丢弃输出——
 * MSYS 不把 nul 当设备名，而是在会话 cwd 创建名为 nul 的真实文件（且 cmd 的
 * `del nul` 删的是 NUL 设备，无法清理该残留）。
 *
 * 两层防护：
 * 1. tool_call 阶段原地改写命令（SDK 官方支持 mutate event.input）：
 *    bash 的 `>nul`/`2>nul` → `/dev/null` 等价形态；powershell → `$null` 等价形态。
 *    本扩展注册在最前，后续 planMode/审批判定与审批卡显示看到的都是改写后的命令。
 * 2. tool_result 阶段兜底：检查 cwd 是否出现 nul 文件（冷门形态如 `<nul` 改写不覆盖），
 *    存在则删除并在工具输出末尾附提示。
 *
 * 仅在 win32 生效；其他平台工厂注册空处理器。
 */

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * bash 命令中 cmd 风格 nul 重定向 → /dev/null。
 * 前导字符限制（空白/行首/`;`/`&`/`|`/`(`/数字 fd 尾）保证只命中重定向目标位置的
 * nul，不误伤 `echo nul`、`cat nul`、`nul.txt` 等参数与文件名；`<nul`（stdin）一并转换。
 */
export function rewriteBashNullRedirect(command: string): string {
  return command
    .replace(
      /(^|[\s(;&|0-9])(\d?)(>{1,2})\s*nul\b(?=$|[\s;|&)])/gi,
      (_m, lead: string, fd: string, arrow: string) => `${lead}${fd}${arrow}/dev/null`
    )
    .replace(
      /(^|[\s(;&|=])(<)\s*nul\b(?=$|[\s;|&)])/gi,
      (_m, lead: string, arrow: string) => `${lead}${arrow}/dev/null`
    );
}

/** powershell 命令中 cmd 风格 nul 重定向 → $null 等价形态 */
export function rewritePowerShellNullRedirect(command: string): string {
  return command.replace(
    /(^|[\s(;|])(\d?)(>{1,2})\s*nul\b(?=$|[\s;|)])/gi,
    (_m, lead: string, fd: string, arrow: string) => `${lead}${fd}${arrow}$null`
  );
}

export interface ShellGuardOptions {
  /** 会话工作目录（nul 残留的检查与清理范围） */
  cwd: string;
}

/**
 * 事件展示层同步改写：SDK 的 tool_execution_start 事件在扩展变异之前发射、
 * 且读取 assistant 消息里的原始参数快照（执行层用的才是变异后的引用）。
 * 落盘/前端工具卡经此归一，显示与实际执行保持一致。
 */
export function rewriteShellToolInputForDisplay(
  tool: string,
  args: unknown
): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return (args as Record<string, unknown>) ?? {};
  const input = args as { command?: unknown };
  if (typeof input.command !== "string") return input as Record<string, unknown>;
  const rewritten =
    tool === "bash"
      ? rewriteBashNullRedirect(input.command)
      : tool === "powershell"
        ? rewritePowerShellNullRedirect(input.command)
        : input.command;
  return rewritten === input.command
    ? (input as Record<string, unknown>)
    : { ...input, command: rewritten };
}

export function createShellGuard(options: ShellGuardOptions): InlineExtension {
  return {
    name: "giser-shell-guard",
    hidden: true,
    factory: (pi) => {
      if (process.platform !== "win32") return;

      pi.on("tool_call", async (event) => {
        const input = event.input as { command?: unknown };
        if (typeof input.command !== "string") return undefined;
        const rewritten =
          event.toolName === "bash"
            ? rewriteBashNullRedirect(input.command)
            : event.toolName === "powershell"
              ? rewritePowerShellNullRedirect(input.command)
              : input.command;
        if (rewritten !== input.command) input.command = rewritten;
        return undefined;
      });

      pi.on("tool_result", async (event) => {
        if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
        try {
          const nulPath = resolve(options.cwd, "nul");
          if (!existsSync(nulPath)) return undefined;
          rmSync(nulPath, { force: true });
        } catch {
          return undefined;
        }
        const note =
          "\n[shell-guard] 已自动删除 MSYS 误创建的 nul 残留文件。" +
          "cmd 风格 >nul/2>nul 在 Git Bash 中会落盘为真实文件，请改用 >/dev/null（bash）或 >$null（PowerShell）丢弃输出。";
        return { content: [...event.content, { type: "text", text: note } as const] };
      });
    },
  };
}
