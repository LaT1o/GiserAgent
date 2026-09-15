/**
 * Agent 与前端地图交互的语义工具（map_* 家族）——只操作前端地图工作区，
 * 与面向数据读取加工的 opengis 族分属两族。数据读取统一走 opengis_toolbox.py。
 *
 * 与 map_inspect 的关系：
 * - map_inspect：检查数据元信息，并按需把矢量数据登记为新图层；
 * - 本模块：对「已登记图层」做清单查看、显隐/别名/顺序调整、解除挂载，
 *   以及把已有矢量数据文件直接登记为图层（不做元信息讲解）。
 *
 * 所有工具都走受控存储（MapLayerStore + map.json），不接收任意输出路径；
 * 删除默认只解除登记并保留 GeoJSON 制品，避免误删派生数据。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DATA_TIMEOUT_SECONDS, runToolbox } from "./toolbox.js";
import {
  applyLayerState,
  ingestVectorAsLayer,
  MapLayerStore,
  readMapConfig,
  writeMapConfig,
  type MapLayer,
} from "../../../webgis.js";

/** 前端可读的图层摘要（避免把内部路径细节全量暴露给模型） */
function layerSummary(layer: MapLayer, visible: boolean) {
  return {
    id: layer.id,
    name: layer.name,
    alias: layer.alias,
    visible,
    dataCrs: layer.dataCrs ?? null,
    featureCount: layer.featureCount ?? null,
    geometryTypes: layer.geometryTypes ?? null,
    fields: layer.fields?.map((field) => field.name) ?? null,
    createdAt: layer.createdAt,
    sourceTool: layer.sourceTool ?? null,
  };
}

export interface MapToolOptions {
  /** 产出来源会话 id（新增图层时记录） */
  sessionId: string;
  /** 项目地图图层仓库（<项目>/.latio/webgis 或会话目录下 webgis） */
  store: MapLayerStore;
  /** 便携 Python 解释器（仅 map_add_layer 需要） */
  pythonExecutable: string;
  /** 会话工作目录（Python 读取相对路径的基准） */
  cwd: string;
}

/** map_list_layers：查看当前项目已登记的地图图层 */
export function createMapListLayersTool(options: MapToolOptions): ToolDefinition {
  return defineTool({
    name: "map_list_layers",
    label: "图层清单",
    description:
      "查看当前项目已登记的地图图层（别名、坐标系、要素数、几何类型、字段、显隐），" +
      "用于确认前端 WebGIS 面板当前有哪些图层以及引用它们的 layer_id。免审批（只读）。",
    promptSnippet: "list registered map layers of the current project",
    parameters: Type.Object({
      include_hidden: Type.Optional(
        Type.Boolean({ description: "是否包含已隐藏图层（默认 true）" })
      ),
    }),
    async execute(_toolCallId, params) {
      const config = readMapConfig(options.store.dir);
      const layers = applyLayerState(options.store.list(), config);
      const includeHidden = params.include_hidden !== false;
      const items = layers
        .filter((layer) => includeHidden || (config.layerState[layer.id]?.visible ?? true))
        .map((layer) => layerSummary(layer, config.layerState[layer.id]?.visible ?? true));
      const result = { count: items.length, layers: items };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}

/** map_set_layer：调整图层的显隐 / 别名 / 顺序（写入 map.json，前端自动同步） */
export function createMapSetLayerTool(options: MapToolOptions): ToolDefinition {
  return defineTool({
    name: "map_set_layer",
    label: "调整图层",
    description:
      "调整已登记地图图层的显示状态：visible（显隐）、alias（显示名）、order（叠加顺序，越小越靠下）。" +
      "修改写入项目地图配置，前端 WebGIS 面板会在数秒内同步。免审批（仅改展示状态，不动数据）。",
    promptSnippet: "set layer visibility/alias/order for the project map",
    parameters: Type.Object({
      layer_id: Type.String({ description: "图层 id（可用 map_list_layers 查询）" }),
      visible: Type.Optional(Type.Boolean({ description: "是否显示" })),
      alias: Type.Optional(Type.String({ description: "新的显示名" })),
      order: Type.Optional(Type.Number({ description: "叠加顺序（整数，越小越靠下）" })),
    }),
    async execute(_toolCallId, params) {
      const layerId = String(params.layer_id ?? "").trim();
      if (!layerId) throw new Error("必须提供 layer_id");
      const store = options.store;
      const existing = store.list().find((layer) => layer.id === layerId);
      if (!existing) {
        const known = store.list().map((layer) => `${layer.id} (${layer.alias})`).join("; ") || "（无图层）";
        throw new Error(`图层不存在: ${layerId}。当前图层: ${known}`);
      }
      if (typeof params.alias === "string" && params.alias.trim()) {
        store.update(layerId, { alias: params.alias });
      }
      const config = readMapConfig(store.dir);
      const state = { ...config.layerState[layerId] };
      if (typeof params.visible === "boolean") state.visible = params.visible;
      if (typeof params.order === "number" && Number.isFinite(params.order)) state.order = Math.round(params.order);
      const nextConfig = writeMapConfig(store.dir, {
        ...config,
        layerState: { ...config.layerState, [layerId]: state },
      });
      const updated = store.list().find((layer) => layer.id === layerId)!;
      const result = {
        success: true,
        layer: layerSummary(updated, nextConfig.layerState[layerId]?.visible ?? true),
        order: nextConfig.layerState[layerId]?.order ?? null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}

/** map_remove_layer：解除图层挂载（默认保留 GeoJSON 制品） */
export function createMapRemoveLayerTool(options: MapToolOptions): ToolDefinition {
  return defineTool({
    name: "map_remove_layer",
    label: "移除图层",
    description:
      "从项目地图上移除一个图层（默认只解除登记并保留 GeoJSON 制品，可重新登记）。" +
      "purge_artifact=true 会连制品一起删除（仅在确认不再需要时使用）。免审批但会改变前端地图内容。",
    promptSnippet: "detach a layer from the project map (keeps artifact by default)",
    parameters: Type.Object({
      layer_id: Type.String({ description: "图层 id（可用 map_list_layers 查询）" }),
      purge_artifact: Type.Optional(
        Type.Boolean({ description: "是否同时删除 GeoJSON 制品（默认 false，保留可恢复）" })
      ),
    }),
    async execute(_toolCallId, params) {
      const layerId = String(params.layer_id ?? "").trim();
      if (!layerId) throw new Error("必须提供 layer_id");
      const store = options.store;
      const existing = store.list().find((layer) => layer.id === layerId);
      if (!existing) throw new Error(`图层不存在: ${layerId}`);
      const purge = params.purge_artifact === true;
      const removed = store.detach(layerId, purge);
      if (removed) {
        const config = readMapConfig(store.dir);
        const layerState = { ...config.layerState };
        delete layerState[layerId];
        writeMapConfig(store.dir, { ...config, layerState });
      }
      const result = { success: removed, layer_id: layerId, purged_artifact: purge };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}

/**
 * map_add_layer：把已有矢量数据登记为地图图层（不做详细元信息讲解）。
 * 与 map_inspect 共用同一段 Python 检查/转换脚本，保证坐标系记录一致。
 */
export function createMapAddLayerTool(options: MapToolOptions): ToolDefinition {
  return defineTool({
    name: "map_add_layer",
    label: "添加图层",
    description:
      "把矢量数据（shp/gpkg/geojson 等）登记为项目地图图层，前端 WebGIS 面板可查看与点选。" +
      "path 相对当前工作目录；GeoJSON 坐标保持原坐标系并记录 dataCrs。" +
      "免审批（受控产出，不覆盖原始数据）；仅元信息检查请改用 map_inspect。",
    promptSnippet: "register a vector dataset as a project map layer",
    parameters: Type.Object({
      path: Type.String({
        description: "矢量数据路径（相对当前工作目录；支持 `数据库.gdb/图层名`）",
      }),
      layer: Type.Optional(
        Type.String({ description: "GDB 图层名（路径已写成 `xxx.gdb/图层名` 时可省略）" })
      ),
      name: Type.Optional(Type.String({ description: "图层标识名（缺省取文件名）" })),
      alias: Type.Optional(Type.String({ description: "图层显示名（缺省同 name）" })),
      visible: Type.Optional(Type.Boolean({ description: "登记后是否显示（默认 true）" })),
      order: Type.Optional(Type.Number({ description: "叠加顺序（整数，越小越靠下）" })),
    }),
    async execute(_toolCallId, params, signal) {
      const src = typeof params.path === "string" ? params.path.trim() : "";
      if (!src) throw new Error("必须提供矢量数据路径 path");
      const result0 = await ingestVectorAsLayer({
        store: options.store,
        sessionId: options.sessionId,
        path: src,
        layer: typeof params.layer === "string" ? params.layer : undefined,
        name: typeof params.name === "string" ? params.name : undefined,
        alias: typeof params.alias === "string" ? params.alias : undefined,
        visible: params.visible === false ? false : undefined,
        order: typeof params.order === "number" ? params.order : undefined,
        sourceTool: "map_add_layer",
        inspect: async ({ path, layer, output }) => {
          const entry = await runToolbox(
            options.pythonExecutable,
            options.cwd,
            "inspect",
            { path, ...(layer ? { layer } : {}), output },
            signal,
            DATA_TIMEOUT_SECONDS
          );
          return entry.result ?? { success: false, error: entry.run.stderr.slice(-500) };
        },
      });
      if (!result0.success || !result0.layer) {
        const payload: Record<string, unknown> = { success: false, error: result0.error };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }
      const layer = result0.layer;
      const config = readMapConfig(options.store.dir);
      const result = {
        success: true,
        layer: layerSummary(layer, config.layerState[layer.id]?.visible ?? true),
        note: "图层已登记，前端地图面板会自动刷新",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}

/** 一次性创建全部地图交互工具 */
export function createMapTools(options: MapToolOptions): ToolDefinition[] {
  return [
    createMapListLayersTool(options),
    createMapAddLayerTool(options),
    createMapSetLayerTool(options),
    createMapRemoveLayerTool(options),
  ];
}
