/**
 * openGIS 工具（底层为便携 Python GIS 运行时）与 ArcGIS 工具（底层为 ArcGIS Pro
 * 自带 Python / arcpy）——SDK customTools 模块。
 *
 * 由 PiAdapter 以 customTools 注入（进程内，无需扩展文件加载），
 * 工作目录为 Pi 会话 cwd（即会话隔离工作区的 working 目录）。
 *
 * 输出统一为 JSON（对齐设计文档第 13 节 Python Runner 约定）：
 * { success, exit_code, stdout, stderr, duration, timed_out }
 *
 * runPython 为共享执行器：openGIS 逃生舱、arcgis 逃生舱与地图工具
 * （map-inspect-tool.ts / map-tools.ts）共用。
 */

import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 180;
export const MAX_TIMEOUT_SECONDS = 600;
/** stdout / stderr 各自的字符上限，超出保留尾部（错误信息通常在末尾） */
const OUTPUT_CHAR_LIMIT = 30_000;

function truncateTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `...（前 ${text.length - limit} 字符已截断）\n${text.slice(text.length - limit)}`;
}

/** 便携 Python 执行结果 */
export interface PythonRunResult {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** 执行耗时（秒，保留两位） */
  duration: number;
  timed_out: boolean;
}

/**
 * 执行便携 Python：argv 原样传给解释器（如 ["-u","-c",code]、["-u",script,...args]）。
 * 超时或中止（signal）时终止子进程；解释器缺失（ENOENT）时抛出可直接展示的中文错误。
 * extraEnv 追加注入环境变量（如 arcgis 的 PYTHONPATH），不覆盖 UTF-8 相关设置。
 */
export function runPython(
  pythonExecutable: string,
  cwd: string,
  argv: string[],
  timeoutSec: number,
  signal?: AbortSignal,
  extraEnv?: NodeJS.ProcessEnv
): Promise<PythonRunResult> {
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(pythonExecutable, argv, {
      cwd,
      env: { ...process.env, ...extraEnv, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`启动 Python 解释器 ${pythonExecutable} 失败: ${(err as Error).message}`);
  }

  return new Promise<PythonRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSec * 1000);

    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        success: !timedOut && exitCode === 0,
        exit_code: exitCode ?? -1,
        stdout: truncateTail(stdout, OUTPUT_CHAR_LIMIT),
        stderr: truncateTail(stderr, OUTPUT_CHAR_LIMIT),
        duration: Math.round(((Date.now() - startedAt) / 1000) * 100) / 100,
        timed_out: timedOut,
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" && !settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Python 解释器不存在: ${pythonExecutable}（请检查 GISER_PYTHON 配置或运行 scripts/setup-python.md 重建 runtime/）`
          )
        );
        return;
      }
      stderr += `\n[python-runner] 进程错误: ${err.message}`;
      finish(null);
    });
    child.on("close", (code2) => finish(code2));
  });
}

/** 执行结果转工具返回（统一 JSON 文本 + details，供工具卡片与审批摘要展示） */
export function toToolResult(result: PythonRunResult): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

/** 创建 openGIS 工具定义；pythonExecutable 为便携解释器绝对路径，cwd 为该会话的工作目录 */
export function createOpenGisTool(pythonExecutable: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "opengis",
    label: "openGIS",
    description:
      "openGIS 空间分析工具：使用内置的便携 Python 运行时（独立于系统 Python，随应用分发）执行开源 GIS 栈" +
      "（geopandas / shapely / pyproj / fiona / rasterio / pandas，GDAL·GEOS·PROJ 系）完成矢量与栅格的空间读写、变换与运算。" +
      "参数二选一：code（内联代码）或 script（脚本文件路径，相对当前工作目录）；" +
      "返回 JSON：{ success, exit_code, stdout, stderr, duration, timed_out }。",
    promptSnippet:
      "run open-source GIS operations (vector & raster) with the bundled portable Python runtime (geopandas / shapely / rasterio)",
    parameters: Type.Object({
      code: Type.Optional(
        Type.String({ description: "要执行的 Python 代码" })
      ),
      script: Type.Optional(
        Type.String({ description: "要执行的脚本文件路径（相对当前工作目录）" })
      ),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description: "传给脚本的命令行参数（仅与 script 搭配）",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: `执行超时秒数，默认 ${DEFAULT_TIMEOUT_SECONDS}，最大 ${MAX_TIMEOUT_SECONDS}`,
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { code, script, args, timeout_seconds } = params;
      if (!code && !script) {
        throw new Error("必须提供 code（内联代码）或 script（脚本路径）之一");
      }
      const timeoutSec = Math.min(
        Math.max(timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, 1),
        MAX_TIMEOUT_SECONDS
      );

      const argv = code
        ? ["-u", "-c", code]
        : ["-u", script as string, ...(args ?? [])];

      return toToolResult(await runPython(pythonExecutable, cwd, argv, timeoutSec, signal));
    },
  });
}

/**
 * 创建 ArcGIS 工具定义：调用本机 ArcGIS Pro 自带的 Python（arcpy）执行 GIS 操作。
 * arcgisPython 为探测结果（未检测到 ArcGIS Pro 时为 null，执行时返回中文提示）；
 * toolboxDir 注入 PYTHONPATH，使 server/python/arcgis_toolbox.py 可直接 import。
 */
export function createArcGisTool(
  arcgisPython: string | null,
  cwd: string,
  toolboxDir: string
): ToolDefinition {
  // 保留调用方进程已有 PYTHONPATH，工具箱目录排在最前
  const pythonPath = [toolboxDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  return defineTool({
    name: "arcgis",
    label: "ArcGIS",
    description:
      "ArcGIS Pro 工具：调用本机 ArcGIS Pro 自带的 Python 环境（arcpy）执行商业 GIS 栈操作，" +
      "适合 Pro 独占或更可靠的能力——叠加擦除/裁剪、CGCS2000 椭球（大地）面积、GDB 批量导入导出、" +
      "渔网生成、线分割地块等。环境变量 PYTHONPATH 已包含 arcgis_toolbox 函数库，可直接 " +
      "import arcgis_toolbox 调用现成函数。需本机安装 ArcGIS Pro 且许可可用；参数二选一：" +
      "code（内联代码）或 script（脚本文件路径，相对当前工作目录）；" +
      "返回 JSON：{ success, exit_code, stdout, stderr, duration, timed_out }。",
    promptSnippet:
      "run arcpy operations (erase, geodesic area, GDB batch import/export, fishnet, line split) with the local ArcGIS Pro Python runtime",
    parameters: Type.Object({
      code: Type.Optional(
        Type.String({ description: "要执行的 Python 代码（arcpy）" })
      ),
      script: Type.Optional(
        Type.String({ description: "要执行的脚本文件路径（相对当前工作目录）" })
      ),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description: "传给脚本的命令行参数（仅与 script 搭配）",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: `执行超时秒数，默认 ${DEFAULT_TIMEOUT_SECONDS}，最大 ${MAX_TIMEOUT_SECONDS}`,
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!arcgisPython) {
        throw new Error(
          "未找到 ArcGIS Pro 的 Python 环境（已依次尝试环境变量 GISER_ARCGIS_PYTHON、" +
            "注册表 HKLM\\SOFTWARE\\ESRI\\ArcGISPro 与默认安装路径）。" +
            "请确认本机已安装 ArcGIS Pro；如安装在自定义位置，可在 server/.env 中设置 " +
            "GISER_ARCGIS_PYTHON 指向 arcgispro-py3 的 python.exe。"
        );
      }
      const { code, script, args, timeout_seconds } = params;
      if (!code && !script) {
        throw new Error("必须提供 code（内联代码）或 script（脚本路径）之一");
      }
      const timeoutSec = Math.min(
        Math.max(timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, 1),
        MAX_TIMEOUT_SECONDS
      );

      const argv = code
        ? ["-u", "-c", code]
        : ["-u", script as string, ...(args ?? [])];

      return toToolResult(
        await runPython(arcgisPython, cwd, argv, timeoutSec, signal, { PYTHONPATH: pythonPath })
      );
    },
  });
}
