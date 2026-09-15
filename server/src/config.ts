/**
 * 集中运行配置。
 *
 * 无命令行参数运行时使用本文件默认值；同名环境变量优先。
 * 环境变量通过 server/.env 提供（见 .env.example）。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MAP_TOOL_NAMES, OPEN_GIS_TOOL_NAMES } from "./webgis.js";

/**
 * 从 import.meta.url 推导 server/src/ 位置。
 * esbuild cjs 打包产物中 import.meta.url 为 undefined（esbuild 警告行为），
 * 返回 null 走 env / cwd 兜底链。
 */
function srcDirFromImportMeta(): string | null {
  try {
    const url = import.meta.url;
    if (typeof url !== "string" || !url.startsWith("file:")) return null;
    return dirname(fileURLToPath(url));
  } catch {
    return null;
  }
}

/**
 * 项目根目录（server/ 的上一级）。解析优先级：
 * 1. 环境变量 GISER_PROJECT_DIR（桌面 Electron 模式显式指定）；
 * 2. 源码位置推导（srcDir 为 server/src（tsx 开发）或 server/build（打包产物），
 *    上溯两级到项目根；校验父目录名为 server，防路径中恰含 server 时误判）；
 * 3. cwd 上一级（打包产物以 server/ 为工作目录运行时）。
 */
export const PROJECT_DIR = (() => {
  if (process.env.GISER_PROJECT_DIR) return resolve(process.env.GISER_PROJECT_DIR);
  const srcDir = srcDirFromImportMeta();
  if (srcDir && basename(dirname(srcDir)) === "server") return resolve(srcDir, "..", "..");
  return resolve(process.cwd(), "..");
})();
/** server/ 目录（与 PROJECT_DIR 同源推导，保证二者一致） */
export const SERVER_DIR = resolve(PROJECT_DIR, "server");

/** Agent 默认启用的工具白名单（全部内置工具 + customTools 注册的 opengis/arcgis、map_ 前缀地图工具与 todo） */
const DEFAULT_AGENT_TOOLS = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "bash",
  "powershell",
  "opengis",
  "arcgis",
  ...MAP_TOOL_NAMES,
  ...OPEN_GIS_TOOL_NAMES,
  "todo",
  "ask_user",
];
/** 执行前需要人工确认的工具（approval-gate 扩展）；arcgis 为任意 arcpy 代码执行，与 opengis 同口径 */
const DEFAULT_APPROVAL_TOOLS = ["bash", "powershell", "opengis", "arcgis"];
/** plan 模式允许的工具子集（只读探查 + 任务清单 + 结构化提问；bash 另受只读命令白名单限制，
 *  不含 powershell——白名单正则只覆盖 POSIX 命令语法） */
const DEFAULT_PLAN_TOOLS = ["read", "ls", "grep", "find", "bash", "todo", "ask_user"];
/** plan 模式专属工具（不在 agentTools 常驻名单，由 effectiveTools 编排：
 *  plan 模式注入、act 模式排除；submit_plan 提交结构化计划供用户审批） */
export const PLAN_ONLY_TOOLS = ["submit_plan"];

export interface ServerConfig {
  /** HTTP 服务端口 */
  port: number;
  /** Agent 运行时实现，当前仅支持 "pi" */
  adapter: "pi";
  /** Agent 工作区根目录（其下 sessions/<id>/ 为各会话隔离目录；环境变量 GISER_WORKSPACE_DIR 可覆盖） */
  workspaceDir: string;
  /** Python Runner 使用的解释器（项目内便携 Python，供 Agent 执行代码与 GIS 处理） */
  pythonExecutable: string;
  /** ArcGIS Pro 自带 Python（arcgispro-py3 的 python.exe）；未检测到安装时为 null，arcgis 工具执行时给出中文提示 */
  arcgisPython: string | null;
  /** Agent 工具白名单 */
  agentTools: string[];
  /** plan 模式允许的工具子集 */
  planTools: string[];
  /** 执行前需要人工确认的工具列表 */
  approvalTools: string[];
  /** 审批请求的超时毫秒数，超时视为拒绝 */
  approvalTimeoutMs: number;
  /** ask_user 提问的等待时限毫秒数，超时返回「用户未回答」给模型（不视为拒绝） */
  questionTimeoutMs: number;
}

/**
 * 读取注册表字符串值（HKLM 支持下）；键不存在或查询失败返回 null。
 * 解析 reg query 输出形如 "    PythonCondaRoot    REG_SZ    C:\\Program Files\\ArcGIS\\Pro\\bin\\Python"。
 */
function readRegistryString(key: string, valueName: string): string | null {
  try {
    const out = spawnSync("reg", ["query", key, "/v", valueName], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout) return null;
    const line = out.stdout
      .split(/\r?\n/)
      .find((l) => l.includes(valueName) && l.includes("REG_SZ"));
    if (!line) return null;
    const idx = line.indexOf("REG_SZ");
    const value = line.slice(idx + "REG_SZ".length).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 探测 ArcGIS Pro 自带的 Python 解释器（照 run_arc.bat 的定位逻辑）：
 * 1. 环境变量 GISER_ARCGIS_PYTHON 显式指定；
 * 2. 注册表 HKLM\SOFTWARE\ESRI\ArcGISPro 的 PythonCondaRoot / PythonCondaEnv；
 * 3. 默认安装路径 %ProgramW6432%\ArcGIS\Pro\bin\Python + envs\arcgispro-py3。
 * ArcGIS Pro 是可选组件：探测不到返回 null（不抛错），由 arcgis 工具执行时提示安装。
 */
export function detectArcGisPython(env: NodeJS.ProcessEnv = process.env): string | null {
  let candidate: string;
  if (env.GISER_ARCGIS_PYTHON) {
    candidate = resolve(env.GISER_ARCGIS_PYTHON);
  } else {
    const root =
      readRegistryString("HKLM\\SOFTWARE\\ESRI\\ArcGISPro", "PythonCondaRoot") ??
      join(env.ProgramW6432 ?? process.env.ProgramW6432 ?? "C:\\Program Files", "ArcGIS", "Pro", "bin", "Python");
    const envName =
      readRegistryString("HKLM\\SOFTWARE\\ESRI\\ArcGISPro", "PythonCondaEnv") ?? "arcgispro-py3";
    candidate = join(root, "envs", envName, "python.exe");
  }
  return existsSync(candidate) ? candidate : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // 默认使用项目内便携 Python；未显式覆盖而文件缺失时尽早报错
  let pythonExecutable = resolve(PROJECT_DIR, "runtime", "python", "python.exe");
  if (env.GISER_PYTHON) {
    pythonExecutable = env.GISER_PYTHON;
  } else if (!existsSync(pythonExecutable)) {
    throw new Error(
      `便携 Python 不存在: ${pythonExecutable}\n` +
        "请按 scripts/setup-python.md 重建 runtime/python，或在 server/.env 中设置 GISER_PYTHON 指向已有解释器。"
    );
  }

  return {
    port: env.PORT ? Number(env.PORT) : 13001,
    adapter: "pi",
    // 可将新数据写入独立目录；不迁移已有工作区。
    workspaceDir: env.GISER_WORKSPACE_DIR ? resolve(env.GISER_WORKSPACE_DIR) : resolve(PROJECT_DIR, "workspace"),
    pythonExecutable,
    arcgisPython: detectArcGisPython(env),
    agentTools: env.AGENT_TOOLS ? env.AGENT_TOOLS.split(",").map((t) => t.trim()).filter(Boolean) : DEFAULT_AGENT_TOOLS,
    planTools: env.GISER_PLAN_TOOLS
      ? env.GISER_PLAN_TOOLS.split(",").map((t) => t.trim()).filter(Boolean)
      : DEFAULT_PLAN_TOOLS,
    approvalTools: env.GISER_APPROVAL_TOOLS
      ? env.GISER_APPROVAL_TOOLS.split(",").map((t) => t.trim()).filter(Boolean)
      : DEFAULT_APPROVAL_TOOLS,
    approvalTimeoutMs: env.GISER_APPROVAL_TIMEOUT_MS ? Number(env.GISER_APPROVAL_TIMEOUT_MS) : 300_000,
    // ask_user 提问的等待时限（超时与审批不同：不视为拒绝，而是把「未回答」交回模型自行决定）
    questionTimeoutMs: env.GISER_QUESTION_TIMEOUT_MS ? Number(env.GISER_QUESTION_TIMEOUT_MS) : 300_000,
  };
}
