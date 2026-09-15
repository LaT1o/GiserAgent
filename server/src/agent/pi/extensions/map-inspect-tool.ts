/**
 * 前端地图工作区工具（首批：map_inspect）——SDK customTools 模块。
 *
 * 与 openGIS 族的分工：
 * - `opengis*`：面向数据的读取与加工（元信息、属性表、格式互转），不碰地图；
 * - `map_*`：面向前端地图工作区的固定动作（数据接入与图层状态），参数结构化，免审批。
 *
 * map_inspect：读取矢量/栅格元信息（坐标系、字段、要素数、范围、样本），
 * 矢量数据同时生成 GeoJSON 制品登记为地图图层（供前端地图面板展示）。
 * 制品由 MapLayerStore 分配路径并登记，工具本身不接收任意输出路径。
 *
 * 数据读取统一走 `server/python/opengis_toolbox.py`（复刻自 latio/gpd_tools.py）：
 * 支持 `xxx.gdb/图层名`，并对 CGCS2000 3 度带这类无 EPSG 直查的坐标系做降级解析，
 * 避免图层因缺 dataCrs 而在前端错位。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defaultLayerAlias, type MapLayer, type MapLayerStore } from "../../../webgis.js";
import { DATA_TIMEOUT_SECONDS, runToolbox } from "./toolbox.js";

export interface MapInspectOptions {
  /** 产出来源会话 id（图层条目记录） */
  sessionId: string;
  /** 该会话的地图图层仓库（项目内 .latio/webgis 或会话目录下 webgis） */
  store: MapLayerStore;
}

/** 把工具箱返回的矢量元信息登记为地图图层条目 */
function buildLayer(
  options: MapInspectOptions,
  sourceName: string,
  alias: string,
  artifact: ReturnType<MapLayerStore["allocate"]>,
  info: Record<string, unknown>,
  sourceTool: string
): MapLayer {
  const now = new Date().toISOString();
  const layer: MapLayer = {
    id: artifact.id,
    name: artifact.name,
    alias,
    sessionId: options.sessionId,
    format: "geojson",
    relativePath: artifact.relativePath,
    ...(info.epsg ? { dataCrs: `EPSG:${String(info.epsg)}` } : {}),
    ...(Array.isArray(info.bounds) ? { bounds: info.bounds as MapLayer["bounds"] } : {}),
    ...(typeof info.feature_count === "number" ? { featureCount: info.feature_count } : {}),
    ...(Array.isArray(info.geometry_types) ? { geometryTypes: info.geometry_types as string[] } : {}),
    ...(Array.isArray(info.fields) ? { fields: info.fields as MapLayer["fields"] } : {}),
    createdAt: now,
    sourceTool,
    loadKey: now,
    status: "ready",
  };
  options.store.upsert(layer);
  return layer;
}

/** 创建 map_inspect 工具定义 */
export function createMapInspectTool(
  pythonExecutable: string,
  cwd: string,
  options: MapInspectOptions
): ToolDefinition {
  return defineTool({
    name: "map_inspect",
    label: "地图检查",
    description:
      "检查矢量或栅格数据的元信息（坐标系、字段与类型、要素数/波段数、范围、前几行样本），" +
      "并把矢量数据转换为 GeoJSON 后登记为项目地图图层（前端地图面板可查看、点选）。" +
      "path 相对当前工作目录，支持 `数据库.gdb/图层名`；免审批（只读检查 + 受控图层产出，不覆盖原始数据）。",
    promptSnippet:
      "inspect vector/raster data (crs, fields, feature count, bounds) and publish vector data as a map layer",
    parameters: Type.Object({
      path: Type.String({
        description:
          "要检查的数据路径（相对当前工作目录；支持 shp/gpkg/geojson 与 `数据库.gdb/图层名` 矢量，以及 GeoTIFF 等栅格）",
      }),
      layer: Type.Optional(Type.String({ description: "GDB 图层名（路径已写成 `xxx.gdb/图层名` 时可省略）" })),
      name: Type.Optional(
        Type.String({ description: "图层标识名（缺省取数据文件名；同一项目内重名自动追加序号）" })
      ),
      alias: Type.Optional(Type.String({ description: "图层显示名（缺省与 name 相同）" })),
      add_to_map: Type.Optional(
        Type.Boolean({ description: "是否把矢量数据登记为地图图层（默认 true；仅元信息检查可设 false）" })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const src = typeof params.path === "string" ? params.path.trim() : "";
      if (!src) throw new Error("必须提供要检查的数据路径 path");
      const wantMap = params.add_to_map !== false;
      const layerName = typeof params.layer === "string" && params.layer.trim() ? params.layer.trim() : "";
      // 命名优先级：显式 name → GDB 图层名 → 文件名（`x.gdb/CJXZQ` 取到 CJXZQ）
      const sourceName =
        (typeof params.name === "string" && params.name.trim()) ||
        layerName ||
        defaultLayerAlias(src);
      const alias = (typeof params.alias === "string" && params.alias.trim()) || sourceName;

      let artifact: ReturnType<MapLayerStore["allocate"]> | undefined;
      if (wantMap) {
        options.store.ensureDirs();
        artifact = options.store.allocate(sourceName);
      }

      const entry = await runToolbox(
        pythonExecutable,
        cwd,
        "inspect",
        {
          path: src,
          ...(layerName ? { layer: layerName } : {}),
          ...(artifact ? { output: artifact.absPath } : {}),
        },
        signal,
        DATA_TIMEOUT_SECONDS
      );
      const info = entry.result;
      if (!info || info.success === false) {
        const payload: Record<string, unknown> = {
          success: false,
          error: info?.error ?? "工具箱未返回结果",
          exit_code: entry.run.exit_code,
          stderr: entry.run.stderr.slice(-2000),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }

      // 矢量且需要上图：登记图层（GeoJSON 已由工具箱写入分配的制品路径）
      const layer =
        info.kind === "vector" && artifact && info.output
          ? buildLayer(options, sourceName, alias, artifact, info, "map_inspect")
          : undefined;

      const result: Record<string, unknown> = {
        ...info,
        exit_code: entry.run.exit_code,
        duration: entry.run.duration,
        timed_out: false,
        map_layer: layer
          ? { id: layer.id, name: layer.name, alias: layer.alias, dataCrs: layer.dataCrs ?? null }
          : null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
