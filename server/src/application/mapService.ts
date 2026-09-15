/**
 * 项目级地图服务（HTTP 层的数据边界）。
 *
 * 与 Agent 侧 map_* 地图工具共用 webgis.ts 的存储与配置实现：
 * 图层制品在 <项目>/.latio/webgis/artifacts，视图与展示状态在 webgis/map.json。
 * 本模块只按已注册项目解析路径，避免用会话路径猜测项目数据。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectStore } from "../projects.js";
import {
  applyLayerState,
  ensureLatioLayout,
  MapLayerStore,
  readMapConfig,
  writeMapConfig,
  type MapLayer,
  type MapLayerState,
  type ProjectMapConfig,
} from "../webgis.js";

/** 项目或其路径不可用时抛出（路由层按 statusCode 映射为 404） */
export class ProjectMapError extends Error {
  readonly statusCode = 404;
}

export class MapService {
  constructor(
    private readonly projects: ProjectStore,
    /** 便携 Python 解释器（拖拽上传登记图层时调工具箱 inspect；缺省不可上传） */
    private readonly pythonExecutable?: string
  ) {}

  private resolveWebgisDir(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new ProjectMapError(`项目不存在: ${projectId}`);
    if (!existsSync(project.path)) throw new ProjectMapError(`项目路径不存在: ${project.path}`);
    return ensureLatioLayout(project.path, project.name).webgis;
  }

  private store(projectId: string): MapLayerStore {
    const store = new MapLayerStore(this.resolveWebgisDir(projectId));
    store.ensureDirs();
    return store;
  }

  listLayers(projectId: string): MapLayer[] {
    const dir = this.resolveWebgisDir(projectId);
    return applyLayerState(new MapLayerStore(dir).list(), readMapConfig(dir));
  }

  readLayerGeoJSON(projectId: string, layerId: string): string | null {
    const found = this.store(projectId).read(layerId);
    return found ? readFileSync(found.absPath, "utf8") : null;
  }

  getConfig(projectId: string): ProjectMapConfig {
    return readMapConfig(this.resolveWebgisDir(projectId));
  }

  updateConfig(projectId: string, raw: unknown): ProjectMapConfig {
    const dir = this.resolveWebgisDir(projectId);
    const current = readMapConfig(dir);
    const incoming = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const incomingState = incoming.layerState && typeof incoming.layerState === "object"
      ? incoming.layerState as Record<string, unknown>
      : {};
    return writeMapConfig(dir, {
      ...current,
      ...incoming,
      version: 1,
      layerState: {
        ...current.layerState,
        ...incomingState as Record<string, MapLayerState>,
      },
    });
  }

  updateLayer(
    projectId: string,
    layerId: string,
    patch: { alias?: string; visible?: boolean; order?: number }
  ): MapLayer | null {
    const dir = this.resolveWebgisDir(projectId);
    const store = new MapLayerStore(dir);
    const existing = store.list().find((layer) => layer.id === layerId);
    if (!existing) return null;
    const layer = patch.alias !== undefined ? store.update(layerId, { alias: patch.alias }) ?? existing : existing;

    const state: MapLayerState = {};
    if (typeof patch.visible === "boolean") state.visible = patch.visible;
    if (typeof patch.order === "number" && Number.isFinite(patch.order)) state.order = Math.round(patch.order);
    if (Object.keys(state).length) {
      const config = readMapConfig(dir);
      writeMapConfig(dir, {
        ...config,
        layerState: { ...config.layerState, [layerId]: { ...config.layerState[layerId], ...state } },
      });
    }
    return layer;
  }

  /** 默认只解除登记（保留制品）；purgeArtifact 才删除 GeoJSON 文件 */
  detachLayer(projectId: string, layerId: string, purgeArtifact = false): boolean {
    const dir = this.resolveWebgisDir(projectId);
    const removed = new MapLayerStore(dir).detach(layerId, purgeArtifact);
    if (removed) {
      const config = readMapConfig(dir);
      const nextState = { ...config.layerState };
      delete nextState[layerId];
      writeMapConfig(dir, { ...config, layerState: nextState });
    }
    return removed;
  }

  /** 制品绝对路径（供将来导出等只读操作使用；越界返回 null） */
  artifactPath(projectId: string, layerId: string): string | null {
    return this.store(projectId).read(layerId)?.absPath ?? null;
  }

  /** 项目 webgis 目录绝对路径（Agent 工具与验证脚本共用） */
  webgisDir(projectId: string): string {
    return this.resolveWebgisDir(projectId);
  }

  /** 项目根目录下的相对制品路径（预留：导出/共享用） */
  artifactRelative(projectId: string, layerId: string): string | null {
    const dir = this.resolveWebgisDir(projectId);
    return new MapLayerStore(dir).read(layerId)?.layer.relativePath ?? null;
  }

  /** 项目的矢量上传上下文（拖拽上图）：webgis 目录、便携 Python、读取基准目录 */
  uploadContext(projectId: string): {
    webgisDir: string;
    pythonExecutable: string;
    cwd: string;
    sessionId: string;
  } {
    if (!this.pythonExecutable) throw new ProjectMapError("未配置便携 Python，无法登记上传的矢量数据");
    const project = this.projects.get(projectId);
    if (!project) throw new ProjectMapError(`项目不存在: ${projectId}`);
    return {
      webgisDir: this.resolveWebgisDir(projectId),
      pythonExecutable: this.pythonExecutable,
      cwd: project.path,
      sessionId: `project:${projectId}`,
    };
  }
}

/** 兼容旧引用：路径拼接（不创建目录） */
export function projectWebgisDir(projectPath: string): string {
  return resolve(projectPath, ".latio", "webgis");
}
