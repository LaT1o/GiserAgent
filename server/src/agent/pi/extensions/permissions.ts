/**
 * 读写权限门控扩展（替代原 protected-paths）。
 *
 * 与前端权限抽屉对应的强制层：
 * - read/write 三态（off / project / all）：project 时仅允许会话绑定的根目录
 *   （项目路径或会话工作区）+ 会话自身目录之内；越界直接 block。
 * - 黑名单在任何级别下都生效（即使 all）：写黑名单保护项目关键文件与
 *   原始 GIS 数据；读黑名单保护密钥文件。
 *
 * 工具集的增删（read=off 时移除 read/ls 等）由 PiAdapter 通过
 * setActiveToolsByName 处理（下一轮生效）；本扩展负责范围拦截
 * （立即生效）与双保险。
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentSessionMode, SessionPermissions } from "../../session.js";
import { SERVER_DIR } from "../../../config.js";
import { isMapToolName, isOpenGisToolName } from "../../../webgis.js";

/**
 * 写黑名单：路径片段包含即命中（统一正斜杠比较）。
 * `.latio/` 为项目内应用数据（会话/地图制品/临时数据），Agent 不可经普通文件工具写入，
 * GIS 结果只能由受控工具写入；导出供测试与文档引用。
 */
export const WRITE_BLOCKED_PATTERNS = [
  ".env",
  ".git/",
  ".latio/",
  "node_modules/",
  "runtime/",
  "server/.pi/",
  "workspace/test-data/",
];

/** 读黑名单：密钥与凭据文件，任何 read 级别都不放行 */
const READ_BLOCKED_PATTERNS = [".env", "server/.pi/auth.json"];

/** PiAdapter 与扩展闭包共享的可变会话控制状态 */
export interface SessionControlState {
  permissions: SessionPermissions;
  mode: AgentSessionMode;
  /** 允许读写的绝对根目录列表（cwd 在首位，用于解析相对路径） */
  allowedRoots: string[];
}

export interface PermissionGuardOptions {
  getState: () => SessionControlState;
  /** 阻止发生时登记 toolCallId，供 PiAdapter 将该调用标记为失败 */
  blockedCalls: Set<string>;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 解析为绝对路径（相对路径基于 cwd，即 allowedRoots[0]） */
function toAbsolute(path: string, state: SessionControlState): string {
  const base = state.allowedRoots[0] ?? process.cwd();
  return resolve(base, path);
}

function isInsideRoots(absPath: string, state: SessionControlState): boolean {
  return state.allowedRoots.some((root) => {
    const absRoot = resolve(root);
    return absPath === absRoot || absPath.startsWith(absRoot + sep);
  });
}

/**
 * 技能根目录（全局应用级、用户级、当前项目级）。
 * 技能位于会话根目录之外，若不单独放行，read: "project" 会让 Agent 读不到
 * SKILL.md——技能只能靠 `/skill:名字` 手动展开，无法自动触发。
 */
function isInsideSkillRoots(absPath: string, state: SessionControlState): boolean {
  const roots = [
    resolve(SERVER_DIR, ".pi", "skills"),
    resolve(homedir(), ".agents", "skills"),
    ...state.allowedRoots.map((root) => resolve(root, ".pi", "skills")),
  ];
  return roots.some((root) => absPath === root || absPath.startsWith(root + sep));
}

function hitPattern(absPath: string, patterns: string[]): string | undefined {
  const normalized = normalize(absPath);
  return patterns.find((p) => normalized.includes(p));
}

function blockCall(options: PermissionGuardOptions, toolCallId: string, path: string, reason: string) {
  options.blockedCalls.add(toolCallId);
  return { block: true, reason: `路径 "${path}" 被读写权限拦截：${reason}` };
}

/** 读类工具（受 read 三态范围控制；grep/find 的 path 参数同样检查） */
const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
/** 写类工具（受 write 三态范围控制） */
const WRITE_TOOLS = new Set(["write", "edit"]);
/** 执行类工具（受 bash 开关控制；powershell/opengis/arcgis/map_* 不在 setActiveToolsByName
 *  的内置名单语义内，必须在此强制拦截；todo 为清单工具恒可用） */
const EXEC_TOOLS = new Set(["bash", "powershell", "opengis", "arcgis"]);
const isExecTool = (name: string): boolean =>
  EXEC_TOOLS.has(name) || isMapToolName(name) || isOpenGisToolName(name);

export function createPermissionGuard(options: PermissionGuardOptions): InlineExtension {
  return {
    name: "giser-permissions",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        const state = options.getState();

        if (!state.permissions.bash && isExecTool(event.toolName)) {
          options.blockedCalls.add(event.toolCallId);
          return {
            block: true,
            reason: "命令行执行权限已关闭（bash/powershell/opengis/arcgis 与 GIS 工具均不可用）。",
          };
        }

        const tool = event.toolName;
        const isRead = READ_TOOLS.has(tool);
        const isWrite = WRITE_TOOLS.has(tool);
        if (!isRead && !isWrite) return undefined;
        const path = (event.input as { path?: unknown }).path;
        // ls/grep/find 等工具允许无 path 参数（默认即 cwd，天然在边界内）
        if (typeof path !== "string" || !path.trim()) return undefined;

        const absPath = toAbsolute(path, state);

        if (isRead) {
          const hit = hitPattern(absPath, READ_BLOCKED_PATTERNS);
          if (hit) {
            return blockCall(options, event.toolCallId, path, `命中读黑名单 ${hit}（密钥/凭据文件禁止读取）`);
          }
          if (
            state.permissions.read === "project" &&
            !isInsideRoots(absPath, state) &&
            !isInsideSkillRoots(absPath, state)
          ) {
            return blockCall(
              options,
              event.toolCallId,
              path,
              `读取范围限定在会话绑定的项目/工作区目录内，允许范围: ${state.allowedRoots.join("、")}。如需访问其他目录，请在该目录下新建会话或将其注册为项目。`
            );
          }
          return undefined;
        }

        // write / edit
        const hit = hitPattern(absPath, WRITE_BLOCKED_PATTERNS);
        if (hit) {
          return blockCall(options, event.toolCallId, path, `命中写黑名单 ${hit}（受保护文件禁止写入）`);
        }
        if (state.permissions.write === "project" && !isInsideRoots(absPath, state)) {
          return blockCall(
            options,
            event.toolCallId,
            path,
            `写入范围限定在会话绑定的项目/工作区目录内，允许范围: ${state.allowedRoots.join("、")}。如需写入其他目录，请在该目录下新建会话或将其注册为项目。`
          );
        }
        return undefined;
      });
    },
  };
}
