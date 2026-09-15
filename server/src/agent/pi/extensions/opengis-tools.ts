/**
 * 开源 GIS 数据处理的结构化动作（`opengis_*` 家族）——SDK customTools 模块。
 *
 * 与两个邻居的分工：
 * - `map_*`：只操作前端地图工作区（图层清单/显隐/登记），不转换数据；
 * - `opengis_*`（本模块）：结构化的数据读取与加工（元信息、属性表对齐、格式互转、别名），
 *   参数固定、免审批，安全边界靠 **路径硬校验**：输入受会话读范围约束，
 *   输出必须落在会话绑定的项目/工作区目录内，且绝不覆盖已有文件或源数据；
 * - `opengis`：任意 Python 逃生舱，长尾分析走它，需人工审批。
 *
 * 具体实现全部在 `server/python/opengis_toolbox.py`（复刻自 latio/gpd_tools.py）。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SessionControlState } from "./permissions.js";
import { DATA_TIMEOUT_SECONDS, runToolbox, toolboxPayload } from "./toolbox.js";

export interface OpenGisToolOptions {
  /** 便携 Python 解释器 */
  pythonExecutable: string;
  /** 会话工作目录（相对路径基准） */
  cwd: string;
  /** 会话 output 目录（缺省输出位置，落在会话绑定的可写范围内） */
  outputDir: string;
  /** 会话控制状态（实时读取 allowedRoots 与读范围，不用快照） */
  getState: () => SessionControlState;
}

/** 相对路径按 cwd 解析（与权限守卫同一基准） */
function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** `xxx.gdb/图层名` → `xxx.gdb`；校验写入边界时要看数据库目录而不是图层名 */
function writeBoundaryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.toLowerCase().indexOf(".gdb/");
  return index >= 0 ? normalized.slice(0, index + 4) : path;
}

/** 统一为正斜杠比较（resolve 出来是反斜杠，而 writeBoundaryOf 会规范化） */
function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function isInsideRoots(abs: string, roots: string[]): boolean {
  const target = normalize(abs);
  return roots.some((root) => {
    const base = normalize(resolve(root));
    return target === base || target.startsWith(base + "/");
  });
}

/** 输入校验：会话读范围限定内；read=all 时允许任意路径 */
function assertReadable(path: string, cwd: string, state: SessionControlState, label: string): string {
  const abs = toAbsolute(path, cwd);
  if (state.permissions.read === "all") return abs;
  if (!isInsideRoots(abs, state.allowedRoots)) {
    throw new Error(
      `${label}超出会话可读范围: ${path}。允许范围: ${state.allowedRoots.join("、")}；` +
        `如需读取其他目录，请把数据复制进项目/工作区，或在该目录下新建会话。`
    );
  }
  return abs;
}

/** 输出校验：必须落在会话绑定目录内，且不得与任何输入相同 */
function assertWritable(output: string, cwd: string, state: SessionControlState, inputs: string[]): string {
  const abs = toAbsolute(output, cwd);
  const boundary = writeBoundaryOf(abs);
  if (!isInsideRoots(boundary, state.allowedRoots)) {
    throw new Error(
      `输出路径超出会话可写范围: ${output}。允许范围: ${state.allowedRoots.join("、")}（工具不会写出到源数据目录）。`
    );
  }
  for (const input of inputs) {
    if (input && writeBoundaryOf(resolve(input)) === boundary) {
      throw new Error(`输出与输入相同（${output}）：工具不覆盖源数据，请换一个输出路径。`);
    }
  }
  return abs;
}

function text(payload: Record<string, unknown>): { type: "text"; text: string }[] {
  return [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }];
}

/** opengis_describe：GDB 图层清单 / 单图层 schema、坐标系与字段别名 */
export function createOpenGisDescribeTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_describe",
    label: "数据元信息",
    description:
      "读取矢量数据的元信息：GDB 传数据库路径时列出全部图层（含图层别名），" +
      "传 `xxx.gdb/图层名` 或 shp/geojson 时返回 driver、几何类型、要素数、坐标系（EPSG）、" +
      "范围与字段清单（含中文字段别名）。只读，免审批。",
    promptSnippet: "describe a vector dataset (layers, schema, crs, field aliases)",
    parameters: Type.Object({
      path: Type.String({ description: "数据路径：`存储.gdb` 列出图层；`存储.gdb/图层名` 或 shp/geojson 读取元信息" }),
      layer: Type.Optional(Type.String({ description: "图层名（路径已含图层名时可省略）" })),
      with_alias: Type.Optional(Type.Boolean({ description: "是否附带 GDB 图层/字段别名（默认 true）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const abs = assertReadable(String(params.path ?? "").trim(), options.cwd, state, "输入路径");
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "describe",
        {
          path: abs,
          ...(params.layer ? { layer: String(params.layer) } : {}),
          with_alias: params.with_alias !== false,
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "describe");
      return { content: text(payload), details: payload };
    },
  });
}

/** opengis_re_schema：按目标 schema 重排属性表结构（多删缺补、类型对齐） */
export function createOpenGisReSchemaTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_re_schema",
    label: "属性表结构对齐",
    description:
      "按目标 schema 重排矢量数据的属性表结构：多则删、缺则补空、字段类型对齐（跨格式往返后字段不漂移）。" +
      "schema 可直接给出，或用 schema_from 指定参考数据（常用：同一 GDB 里的标准图层）。" +
      "输出写入工作区新文件，**不修改输入**；免审批。",
    promptSnippet: "re-align attribute schema of a dataset (drop/add/cast fields) into a new output",
    parameters: Type.Object({
      input: Type.String({ description: "输入数据路径（支持 `存储.gdb/图层名`）" }),
      output: Type.Optional(
        Type.String({ description: "输出路径（相对会话工作目录；缺省写到会话 output 目录且文件名自动避让）" })
      ),
      schema_from: Type.Optional(Type.String({ description: "参考数据的路径或 `xxx.gdb/图层名`，取其字段结构作为目标 schema" })),
      schema: Type.Optional(
        Type.Object(
          {
            geometry: Type.Optional(Type.String({ description: "几何类型（可选）" })),
            fields: Type.Array(
              Type.Object({
                name: Type.String(),
                type: Type.Optional(Type.String({ description: "string / integer / double / date" })),
              })
            ),
          },
          { description: "直接给出的目标 schema（与 schema_from 二选一）" }
        )
      ),
      layer: Type.Optional(Type.String({ description: "输入图层名（路径已含图层名时可省略）" })),
      crs: Type.Optional(Type.String({ description: "指定输出坐标系（如 EPSG:4524；缺省沿用输入）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const input = assertReadable(String(params.input ?? "").trim(), options.cwd, state, "输入路径");
      const output = params.output
        ? assertWritable(String(params.output), options.cwd, state, [input])
        : defaultOutput(options, input, "reschema");
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "re_schema",
        {
          input,
          output,
          ...(params.schema_from ? { schema_from: assertReadable(String(params.schema_from), options.cwd, state, "参考数据") } : {}),
          ...(params.schema ? { schema: params.schema } : {}),
          ...(params.layer ? { layer: String(params.layer) } : {}),
          ...(params.crs ? { crs: String(params.crs) } : {}),
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "re_schema");
      return { content: text(payload), details: payload };
    },
  });
}

/** opengis_convert：格式互转（GDB ↔ SHP/GeoJSON/GPKG，属性表 → CSV/Excel） */
export function createOpenGisConvertTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_convert",
    label: "格式互转",
    description:
      "矢量/属性表格式互转：GDB 图层 ↔ SHP / GeoJSON / GPKG，属性表 → CSV / Excel，" +
      "GDB → GDB 图层导出。按输出扩展名自动选择驱动；可顺带做几何修复与多部件拆分（repair=true）。" +
      "输出写入工作区新文件，**不修改输入**；免审批。",
    promptSnippet: "convert vector data between gdb/shp/geojson/gpkg/csv/xlsx",
    parameters: Type.Object({
      input: Type.String({ description: "输入数据路径（支持 `存储.gdb/图层名`）" }),
      output: Type.String({
        description: "输出路径（相对会话工作目录；扩展名决定格式：.shp/.geojson/.gpkg/.gdb/图层名/.csv/.xlsx）",
      }),
      layer: Type.Optional(Type.String({ description: "输入图层名（路径已含图层名时可省略）" })),
      crs: Type.Optional(Type.String({ description: "指定输出坐标系（如 EPSG:4524；缺省沿用输入）" })),
      repair: Type.Optional(Type.Boolean({ description: "是否先做多部件拆分 + 几何修复（默认 false）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const rawOutput = String(params.output ?? "").trim();
      if (!rawOutput) throw new Error("convert 必须提供 output（扩展名决定目标格式）");
      const input = assertReadable(String(params.input ?? "").trim(), options.cwd, state, "输入路径");
      const output = assertWritable(rawOutput, options.cwd, state, [input]);
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "convert",
        {
          input,
          output,
          ...(params.layer ? { layer: String(params.layer) } : {}),
          ...(params.crs ? { crs: String(params.crs) } : {}),
          repair: params.repair === true,
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "convert");
      return { content: text(payload), details: payload };
    },
  });
}

/** opengis_set_alias：批量设置 GDB 图层/字段中文别名（写 GDB_Items 定义 XML） */
export function createOpenGisSetAliasTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_set_alias",
    label: "设置别名",
    description:
      "为 GDB 图层与字段批量设置别名（中文名），写 GDB_Items 定义 XML。" +
      "只作用于**会话工作区内的 GDB 副本**（工具拒绝修改工作区外的源数据），" +
      "需要便携运行时安装 GDAL(osgeo) 绑定，未安装时返回明确提示。免审批。",
    promptSnippet: "set layer/field aliases in a workspace copy of a file geodatabase",
    parameters: Type.Object({
      gdb: Type.String({ description: "工作区内的 GDB 路径（不支持工作区外的源数据）" }),
      layer_aliases: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: "图层别名表：{ 图层名: 别名 }" })
      ),
      field_aliases: Type.Optional(
        Type.Record(Type.String(), Type.Record(Type.String(), Type.String()), {
          description: "字段别名表：{ 图层名: { 字段名: 别名 } }",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const gdb = assertWritable(String(params.gdb ?? "").trim(), options.cwd, state, []);
      if (!existsSync(gdb)) throw new Error(`GDB 不存在: ${gdb}`);
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "set_alias",
        {
          gdb,
          layer_aliases: params.layer_aliases ?? {},
          field_aliases: params.field_aliases ?? {},
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "set_alias");
      return { content: text(payload), details: payload };
    },
  });
}

/** opengis_reproject：矢量重投影（真正的坐标变换 to_crs，输出为新文件） */
export function createOpenGisReprojectTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_reproject",
    label: "重投影",
    description:
      "把矢量数据重投影到目标坐标系（真正的坐标变换，几何坐标会实际换算）。" +
      "注意与 opengis_convert 的 crs 参数的区别：convert 的 crs 只改坐标系标注（数据坐标本来就该是那个坐标系），" +
      "本工具执行 to_crs 变换（如 CGCS2000 投影坐标 → EPSG:4326 经纬度）。" +
      "输出写入工作区新文件，**不修改输入**；免审批。",
    promptSnippet: "reproject vector data into another CRS (to_crs, not just relabeling)",
    parameters: Type.Object({
      input: Type.String({ description: "输入数据路径（支持 `存储.gdb/图层名`；必须已有坐标系标注）" }),
      crs: Type.String({ description: "目标坐标系（如 `EPSG:4326`、`EPSG:4524`，或 proj4/WKT 串）" }),
      output: Type.Optional(
        Type.String({ description: "输出路径（相对会话工作目录；缺省写到会话 output 目录且文件名自动避让）" })
      ),
      layer: Type.Optional(Type.String({ description: "输入图层名（路径已含图层名时可省略）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const input = assertReadable(String(params.input ?? "").trim(), options.cwd, state, "输入路径");
      const crs = String(params.crs ?? "").trim();
      if (!crs) throw new Error("reproject 必须提供 crs（目标坐标系，如 EPSG:4326）");
      const output = params.output
        ? assertWritable(String(params.output), options.cwd, state, [input])
        : defaultOutput(options, input, "reproject");
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "reproject",
        {
          input,
          output,
          crs,
          ...(params.layer ? { layer: String(params.layer) } : {}),
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "reproject");
      return { content: text(payload), details: payload };
    },
  });
}

/** opengis_clip：矢量裁剪（用 mask 图层裁出范围，字段保留输入结构） */
export function createOpenGisClipTool(options: OpenGisToolOptions): ToolDefinition {
  return defineTool({
    name: "opengis_clip",
    label: "矢量裁剪",
    description:
      "用裁剪范围（mask 矢量数据）裁剪输入数据：只保留落在范围内的几何，字段结构沿用输入。" +
      "mask 与输入坐标系不同时自动对齐（mask 变换到输入坐标系）；字段完全落在范围外的要素被移除。" +
      "输出写入工作区新文件，**不修改输入与裁剪范围**；免审批。",
    promptSnippet: "clip vector data by a mask layer (keep input attributes)",
    parameters: Type.Object({
      input: Type.String({ description: "被裁剪的数据路径（支持 `存储.gdb/图层名`）" }),
      mask: Type.String({ description: "裁剪范围数据路径（任意矢量数据，支持 `存储.gdb/图层名`；只需几何，属性被忽略）" }),
      output: Type.Optional(
        Type.String({ description: "输出路径（相对会话工作目录；缺省写到会话 output 目录且文件名自动避让）" })
      ),
      layer: Type.Optional(Type.String({ description: "输入图层名（路径已含图层名时可省略）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const state = options.getState();
      const input = assertReadable(String(params.input ?? "").trim(), options.cwd, state, "输入路径");
      const rawMask = String(params.mask ?? "").trim();
      if (!rawMask) throw new Error("clip 必须提供 mask（裁剪范围数据路径）");
      const mask = assertReadable(rawMask, options.cwd, state, "裁剪范围");
      const output = params.output
        ? assertWritable(String(params.output), options.cwd, state, [input, mask])
        : defaultOutput(options, input, "clip");
      const entry = await runToolbox(
        options.pythonExecutable,
        options.cwd,
        "clip",
        {
          input,
          mask,
          output,
          ...(params.layer ? { layer: String(params.layer) } : {}),
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const payload = toolboxPayload(entry, "clip");
      return { content: text(payload), details: payload };
    },
  });
}

/**
 * 缺省输出：会话 output 目录下带动作与时间戳的新文件。
 * 源数据是 GDB 图层（`xxx.gdb/图层名`）时产物写进新 GDB 并沿用图层名，
 * 否则沿用输入扩展名（取不到扩展名时用 gpkg——能保留字段类型与坐标系）。
 */
function defaultOutput(options: OpenGisToolOptions, input: string, action: string): string {
  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  if (normalized.toLowerCase().includes(".gdb/")) {
    const layer = parts[parts.length - 1] ?? "output";
    return resolve(options.outputDir, `${action}_${stamp}.gdb`, layer);
  }
  const base = parts[parts.length - 1] ?? "output";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : ".gpkg";
  return resolve(options.outputDir, `${action}_${stamp}${ext}`);
}

/** 一次性创建全部 opengis_* 结构化动作 */
export function createOpenGisTools(options: OpenGisToolOptions): ToolDefinition[] {
  return [
    createOpenGisDescribeTool(options),
    createOpenGisReSchemaTool(options),
    createOpenGisConvertTool(options),
    createOpenGisReprojectTool(options),
    createOpenGisClipTool(options),
    createOpenGisSetAliasTool(options),
  ];
}
