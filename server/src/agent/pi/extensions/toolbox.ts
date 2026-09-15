/**
 * 开源 GIS 数据处理工具箱（`server/python/opengis_toolbox.py`）的调用封装。
 *
 * 工具箱是本项目复刻自 latio/gpd_tools.py 的 Python 实现，承担所有矢量数据读写与
 * 元信息解析（支持 `xxx.gdb/图层名`）。这里统一三件事：
 * - 定位脚本路径（随服务端分发，见 release 打包白名单）；
 * - spawn 便携 Python 并解析「stdout 末行 JSON」结果；
 * - 把 Python 侧的结构化失败转成可读错误。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_DIR } from "../../../config.js";
import { DEFAULT_TIMEOUT_SECONDS, runPython, type PythonRunResult } from "./python-runner.js";

/** 工具箱脚本绝对路径（server/python/opengis_toolbox.py） */
export const TOOLBOX_PATH = resolve(SERVER_DIR, "python", "opengis_toolbox.py");

/** 数据操作默认超时（大 GDB 读写比普通命令慢） */
export const DATA_TIMEOUT_SECONDS = 300;

export interface ToolboxResult {
  /** 末行 JSON 解析结果（缺失时为 null） */
  result: Record<string, unknown> | null;
  run: PythonRunResult;
}

/** 取 stdout 末行 JSON（脚本约定；前序行可能含库告警） */
export function parseTrailingJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // 继续向前找
    }
  }
  return null;
}

/** 调用工具箱动作：`python opengis_toolbox.py <action> <json-args>` */
export async function runToolbox(
  pythonExecutable: string,
  cwd: string,
  action: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutSec: number = DEFAULT_TIMEOUT_SECONDS
): Promise<ToolboxResult> {
  if (!existsSync(TOOLBOX_PATH)) {
    throw new Error(`GIS 工具箱脚本缺失: ${TOOLBOX_PATH}（打包时需包含 server/python/**）`);
  }
  const run = await runPython(
    pythonExecutable,
    cwd,
    ["-u", TOOLBOX_PATH, action, JSON.stringify(params)],
    timeoutSec,
    signal
  );
  return { result: parseTrailingJson(run.stdout), run };
}

/** 工具箱动作的结果 → 工具返回值（成功/失败分别落到 details.success） */
export function toolboxPayload(entry: ToolboxResult, action: string): Record<string, unknown> {
  if (entry.result) return entry.result;
  return {
    success: false,
    error: `工具箱 ${action} 未返回结果`,
    exit_code: entry.run.exit_code,
    stderr: entry.run.stderr.slice(-2000),
  };
}
