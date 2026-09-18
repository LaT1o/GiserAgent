/**
 * WebGIS 地图图层存储（项目内 `.latio/webgis/` 或会话目录下 `webgis/`）。
 *
 * 目录约定：
 *   webgis/
 *     layers.json            图层清单（本项目全部会话共享）
 *     artifacts/<id>.geojson 地图可加载的矢量结果（工具产出，非原始数据）
 *
 * 说明：
 * - GeoJSON 坐标保持数据自身的坐标系（dataCrs），不强制转换；前端按
 *   dataCrs → 视图坐标系做一次投影变换展示。
 * - 只登记「工具产出」的派生结果，不登记用户原始数据；覆盖原始文件不属于本模块语义。
 * - layers.json 采用「临时文件 + rename」原子写，避免并发/中断读到半截文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve, sep } from "node:path";

/** 前端地图工作区工具名（单一事实源：config 工具名单、门控判定共用）
 *  - map_inspect：数据元信息检查 + 按需登记为图层
 *  - map_list_layers / map_add_layer / map_set_layer / map_remove_layer：地图图层交互
 *  与执行任意数据处理代码的 opengis 逃生舱是两族工具：本族只操作前端地图工作区
 *  （图层清单与展示状态），不承担通用 GIS 数据加工。 */
export const MAP_TOOL_NAMES = [
  "map_inspect",
  "map_list_layers",
  "map_add_layer",
  "map_set_layer",
  "map_remove_layer",
] as const;

/** 是否为前端地图工作区工具（受命令行总闸控制、plan 模式禁用、免审批） */
export function isMapToolName(name: string): boolean {
  return name.startsWith("map_");
}

/** 开源 GIS 数据处理的结构化动作（与逃生舱 `opengis` 同族、不同安全等级）：
 *  - opengis_describe：数据元信息（GDB 图层清单、schema、坐标系、字段别名，只读）
 *  - opengis_re_schema：按目标 schema 重排属性表结构
 *  - opengis_convert：格式互转（gdb↔shp/geojson/gpkg，属性表→csv/xlsx）
 *  - opengis_reproject：矢量重投影（to_crs 真坐标变换，区别于 convert 的 crs 改标注）
 *  - opengis_clip：矢量裁剪（mask 范围裁剪，字段沿用输入，CRS 自动对齐）
 *  - opengis_geometry：几何运算族（buffer/dissolve/merge，operation 枚举路由，
 *    参数同构的新几何操作毕业到这里的枚举扩展）
 *  - opengis_set_alias：批量设置 GDB 图层/字段别名（需 GDAL）
 *  免审批：安全边界靠路径硬校验（输出必须落在会话绑定目录内、绝不覆盖源数据）。 */
export const OPEN_GIS_TOOL_NAMES = [
  "opengis_describe",
  "opengis_re_schema",
  "opengis_convert",
  "opengis_reproject",
  "opengis_clip",
  "opengis_geometry",
  "opengis_set_alias",
] as const;

/** 是否为 opengis 族工具（含任意代码逃生舱 `opengis` 本身） */
export function isOpenGisToolName(name: string): boolean {
  return name === "opengis" || name.startsWith("opengis_");
}

/** 项目内存储目录名（创建项目时初始化；会话、地图制品、临时数据都放这里） */
export const LATIO_DIR = ".latio";

export interface LatioLayout {
  /** 项目内 .latio 根目录 */
  latio: string;
  /** 会话目录根（.latio/sessions） */
  sessions: string;
  /** 地图数据根（.latio/webgis） */
  webgis: string;
  /** 地图制品目录（.latio/webgis/artifacts） */
  artifacts: string;
  /** 临时目录（.latio/tmp） */
  tmp: string;
}

/** .latio 各子目录绝对路径（不创建） */
export function latioLayout(projectPath: string): LatioLayout {
  const latio = resolve(projectPath, LATIO_DIR);
  const webgis = resolve(latio, "webgis");
  return {
    latio,
    sessions: resolve(latio, "sessions"),
    webgis,
    artifacts: resolve(webgis, "artifacts"),
    tmp: resolve(latio, "tmp"),
  };
}

/**
 * 初始化项目 .latio 布局（幂等）：目录骨架 + project.json 稳定身份。
 * project.json 已存在时不覆盖（保留 displayCrs 等后续写入的字段）。
 * 创建项目（routes）与旧项目首次建会话（PiAdapter）共用。
 */
export function ensureLatioLayout(projectPath: string, name?: string): LatioLayout {
  const layout = latioLayout(projectPath);
  for (const dir of [layout.sessions, layout.artifacts, layout.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  const file = resolve(layout.latio, "project.json");
  if (!existsSync(file)) {
    const payload = {
      schemaVersion: 1,
      id: randomUUID(),
      name: name?.trim() || basename(projectPath) || projectPath,
      createdAt: new Date().toISOString(),
    };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
  }
  return layout;
}

export interface MapLayerField {
  name: string;
  dtype: string;
}

/** 地图图层条目（layers.json 数组元素；字段名与前端 MapLayer 类型一致） */
export interface MapLayer {
  id: string;
  /** 稳定标识（缺省取数据文件名，同一项目内重名时追加序号） */
  name: string;
  /** 展示名（图层树显示） */
  alias: string;
  /** 产出来源会话 */
  sessionId: string;
  format: "geojson";
  /** 相对 webgis 目录的 GeoJSON 路径（artifactId.geojson） */
  relativePath: string;
  /** 数据坐标系（如 "EPSG:4547"；未知为 undefined） */
  dataCrs?: string;
  /** 要素范围 [minx, miny, maxx, maxy] */
  bounds?: [number, number, number, number];
  featureCount?: number;
  geometryTypes?: string[];
  fields?: MapLayerField[];
  createdAt: string;
  /** 产出工具名（如 map_inspect；历史数据可能是旧名 gis_inspect） */
  sourceTool?: string;
  /** 内容版本（重新生成时变化，前端据此刷新 source） */
  loadKey: string;
  status: "ready";
  /** 项目地图配置中的可选展示状态（API 返回时合并） */
  visible?: boolean;
  order?: number;
}

interface LayersFile {
  version: number;
  layers: MapLayer[];
}

/** 归一化磁盘内容（损坏/缺关键字段的条目跳过） */
function sanitize(raw: unknown): MapLayer[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as LayersFile).layers;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (l): l is MapLayer =>
      l &&
      typeof l.id === "string" &&
      typeof l.relativePath === "string" &&
      l.format === "geojson" &&
      typeof l.createdAt === "string"
  );
}

/** 文件名安全化（去除路径符号与控制字符；空结果回落 layer） */
export function sanitizeLayerName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "layer";
}

export class MapLayerStore {
  constructor(readonly dir: string) {}

  private get file(): string {
    return resolve(this.dir, "layers.json");
  }

  /** 确保 webgis 目录与制品目录存在 */
  ensureDirs(): void {
    mkdirSync(resolve(this.dir, "artifacts"), { recursive: true });
  }

  list(): MapLayer[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return sanitize(raw);
    } catch (err) {
      console.warn(`[webgis] layers.json 解析失败，按空清单处理: ${(err as Error).message}`);
      return [];
    }
  }

  private persist(layers: MapLayer[]): void {
    this.ensureDirs();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, layers }, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  /** 分配新的制品路径（不落盘；同名图层追加 -2/-3 序号保证 name 唯一） */
  allocate(sourceName: string): { id: string; name: string; relativePath: string; absPath: string } {
    const id = randomUUID();
    const base = sanitizeLayerName(sourceName);
    const existing = new Set(this.list().map((l) => l.name));
    let name = base;
    for (let i = 2; existing.has(name); i += 1) name = `${base}-${i}`;
    const relativePath = `artifacts/${id}.geojson`;
    return { id, name, relativePath, absPath: resolve(this.dir, "artifacts", `${id}.geojson`) };
  }

  /** 新增或按 id 覆盖图层条目（重新生成同一制品时保留 name） */
  upsert(layer: MapLayer): void {
    const layers = this.list();
    const index = layers.findIndex((l) => l.id === layer.id);
    if (index >= 0) layers[index] = layer;
    else layers.push(layer);
    this.persist(layers);
  }

  /** 更新受控图层状态；未知字段不会写入注册表。 */
  update(id: string, patch: Partial<Pick<MapLayer, "alias">>): MapLayer | null {
    const layers = this.list();
    const index = layers.findIndex((layer) => layer.id === id);
    if (index < 0) return null;
    const next = { ...layers[index], ...(patch.alias?.trim() ? { alias: patch.alias.trim() } : {}) };
    layers[index] = next;
    this.persist(layers);
    return next;
  }

  /** 从注册表解除挂载；默认保留 artifacts 制品，避免误删原始/派生数据。 */
  detach(id: string, purgeArtifact = false): boolean {
    const found = this.read(id);
    if (!found) return false;
    const layers = this.list().filter((layer) => layer.id !== id);
    this.persist(layers);
    if (purgeArtifact) rmSync(found.absPath, { force: true });
    return true;
  }

  /** 按 id 取图层与其绝对路径（越界/缺失返回 null） */
  read(id: string): { layer: MapLayer; absPath: string } | null {
    const layer = this.list().find((l) => l.id === id);
    if (!layer) return null;
    const absPath = resolve(this.dir, layer.relativePath);
    // 防目录穿越：制品必须落在 webgis 目录内
    if (absPath !== this.dir && !absPath.startsWith(this.dir + sep)) return null;
    if (!existsSync(absPath)) return null;
    return { layer, absPath };
  }
}

/** 缺省图层别名：文件名去扩展名 */
export function defaultLayerAlias(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "") || basename(path);
}

/* ---------- 地图视图配置（webgis/map.json） ----------
 * 由 MapService（HTTP）与 Agent 的 map_* 工具共用，保证单一事实源。
 * 只保存视图与图层展示状态；天地图密钥属于应用设置，不写入项目文件。 */

export interface MapLayerState {
  visible?: boolean;
  order?: number;
}

export interface ProjectMapConfig {
  version: 1;
  displayCrs?: string;
  view?: { center: [number, number]; zoom: number };
  layerState: Record<string, MapLayerState>;
  updatedAt?: string;
}

export const DEFAULT_MAP_CONFIG: ProjectMapConfig = { version: 1, layerState: {} };

/** 归一化地图配置（损坏/缺字段回退默认值） */
export function sanitizeMapConfig(raw: unknown): ProjectMapConfig {
  const result: ProjectMapConfig = { version: 1, layerState: {} };
  if (!raw || typeof raw !== "object") return result;
  const input = raw as Record<string, unknown>;
  if (typeof input.displayCrs === "string" && input.displayCrs.trim()) {
    result.displayCrs = input.displayCrs.trim();
  }
  const view = input.view as Record<string, unknown> | undefined;
  if (
    view && Array.isArray(view.center) && view.center.length === 2 &&
    view.center.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    typeof view.zoom === "number" && Number.isFinite(view.zoom)
  ) {
    result.view = {
      center: [Number(view.center[0]), Number(view.center[1])],
      zoom: Math.max(0, Math.min(28, Number(view.zoom))),
    };
  }
  const layerState = input.layerState as Record<string, unknown> | undefined;
  if (layerState && typeof layerState === "object") {
    for (const [id, value] of Object.entries(layerState)) {
      if (!value || typeof value !== "object") continue;
      const state = value as Record<string, unknown>;
      const next: MapLayerState = {};
      if (typeof state.visible === "boolean") next.visible = state.visible;
      if (typeof state.order === "number" && Number.isFinite(state.order)) next.order = Math.round(state.order);
      if (Object.keys(next).length) result.layerState[id] = next;
    }
  }
  if (typeof input.updatedAt === "string") result.updatedAt = input.updatedAt;
  return result;
}

/** 读取地图配置（webgis/map.json；缺失/损坏按默认值） */
export function readMapConfig(webgisDir: string): ProjectMapConfig {
  const file = resolve(webgisDir, "map.json");
  try {
    if (!existsSync(file)) return { ...DEFAULT_MAP_CONFIG, layerState: {} };
    return sanitizeMapConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.warn(`[webgis] map.json 解析失败，按默认配置处理: ${(err as Error).message}`);
    return { ...DEFAULT_MAP_CONFIG, layerState: {} };
  }
}

/** 原子写地图配置（临时文件 + rename） */
export function writeMapConfig(webgisDir: string, config: ProjectMapConfig): ProjectMapConfig {
  mkdirSync(webgisDir, { recursive: true });
  const next: ProjectMapConfig = { ...config, version: 1, updatedAt: new Date().toISOString() };
  const file = resolve(webgisDir, "map.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, file);
  return next;
}

/** 把配置中的显隐/顺序合并到图层清单（顺序未配置的排在末尾） */
export function applyLayerState(layers: MapLayer[], config: ProjectMapConfig): MapLayer[] {
  return layers
    .map((layer) => {
      const state = config.layerState[layer.id];
      return {
        ...layer,
        visible: state?.visible ?? layer.visible ?? true,
        ...(state?.order !== undefined
          ? { order: state.order }
          : layer.order !== undefined ? { order: layer.order } : {}),
      };
    })
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

/* ---------- 矢量数据登记为图层（ingest） ----------
 * map_add_layer（Agent 工具）与拖拽上传（HTTP 路由）共用的登记管线：
 * 调工具箱 inspect 产出受控 GeoJSON 制品 → 登记 layers.json → 合并 map.json。
 * 不新建服务层，Python 执行通过参数注入以避免对 extensions 的循环依赖。 */

/** 拖拽上传可识别的矢量主文件扩展名（小写，含点） */
export const VECTOR_MAIN_EXTS = [".shp", ".gpkg", ".geojson", ".json", ".kml"] as const;
/** shapefile 的 sidecar 扩展名（与同名 .shp 一并视为一个数据集；含可选） */
const SHP_SIDECAR_EXTS = [".dbf", ".shx", ".prj", ".cpg", ".sbn", ".sbx", ".qix", ".fix"];

export interface UploadDataset {
  /** 数据集标识（主文件名去扩展名，用于图层命名） */
  key: string;
  /** 主数据文件名（相对上传批次的原始名，可能含子目录如 gdb） */
  mainFile: string;
  /** sidecar 文件名（shp 的 .dbf/.shx/...；其它格式为空） */
  sidecars: string[];
  /** 数据集类别：shp / gdb / single（单文件矢量） */
  kind: "shp" | "gdb" | "single";
}

/**
 * 把一次上传的文件名清单按数据集分组（纯函数，便于单测）。
 * - `xxx.shp` 与同 basename 的 .dbf/.shx/.prj 等归为一个 shp 数据集；
 * - `yyy.gdb/...` 路径下的所有文件归为一个 gdb 数据集（mainFile 取 .gdb 目录名）；
 * - 其它可识别单文件（gpkg/geojson/json/kml）各自成一个数据集；
 * - 无法识别的文件名进 returned.ignored（路由层据此提示）。
 */
export function planUploadDatasets(filenames: string[]): { datasets: UploadDataset[]; ignored: string[] } {
  const norm = (n: string) => n.replace(/\\/g, "/");
  const baseOf = (n: string) => {
    const b = norm(n).split("/").pop() ?? n;
    const dot = b.lastIndexOf(".");
    return dot > 0 ? b.slice(0, dot) : b;
  };
  const extOf = (n: string) => {
    const b = norm(n).split("/").pop() ?? n;
    const dot = b.lastIndexOf(".");
    return dot >= 0 ? b.slice(dot).toLowerCase() : "";
  };
  const datasets: UploadDataset[] = [];
  const ignored: string[] = [];
  const gdbSeen = new Set<string>();
  const shpGroups = new Map<string, { main?: string; sidecars: string[] }>();

  for (const raw of filenames) {
    const name = norm(raw).replace(/^\/+/, "");
    if (!name) continue;
    // GDB 目录：路径中出现 xxx.gdb/ 段
    const gdbMatch = name.match(/(^|\/)([^/]+\.gdb)(\/|$)/i);
    if (gdbMatch) {
      const gdbName = gdbMatch[2];
      if (!gdbSeen.has(gdbName.toLowerCase())) {
        gdbSeen.add(gdbName.toLowerCase());
        datasets.push({ key: baseOf(gdbName), mainFile: gdbName, sidecars: [], kind: "gdb" });
      }
      continue;
    }
    const ext = extOf(name);
    if (ext === ".shp") {
      const key = baseOf(name);
      const group = shpGroups.get(key.toLowerCase()) ?? { sidecars: [] };
      group.main = name;
      shpGroups.set(key.toLowerCase(), group);
      continue;
    }
    if (SHP_SIDECAR_EXTS.includes(ext)) {
      const key = baseOf(name);
      const group = shpGroups.get(key.toLowerCase()) ?? { sidecars: [] };
      group.sidecars.push(name);
      shpGroups.set(key.toLowerCase(), group);
      continue;
    }
    if ((VECTOR_MAIN_EXTS as readonly string[]).includes(ext)) {
      datasets.push({ key: baseOf(name), mainFile: name, sidecars: [], kind: "single" });
      continue;
    }
    ignored.push(name);
  }
  for (const group of shpGroups.values()) {
    if (group.main) {
      datasets.push({ key: baseOf(group.main), mainFile: group.main, sidecars: group.sidecars, kind: "shp" });
    } else {
      // 只有 sidecar 没有 .shp：无法成数据集，逐个记为忽略
      ignored.push(...group.sidecars);
    }
  }
  return { datasets, ignored };
}

/** 工具箱 inspect 的返回（ingest 关心的子集） */
export interface InspectVectorInfo {
  success?: boolean;
  kind?: string;
  error?: string;
  epsg?: number;
  bounds?: [number, number, number, number];
  feature_count?: number;
  geometry_types?: string[];
  fields?: MapLayerField[];
}

export interface IngestVectorOptions {
  /** 图层仓库（<项目>/.latio/webgis 或会话 webgis） */
  store: MapLayerStore;
  /** 产出来源会话 id（HTTP 上传时可为项目/会话标识） */
  sessionId: string;
  /** 矢量数据路径（支持 `数据库.gdb/图层名`） */
  path: string;
  /** GDB 图层名（路径已含时可省略） */
  layer?: string;
  /** 图层标识名（缺省取 GDB 图层名/文件名） */
  name?: string;
  /** 图层显示名（缺省同 name） */
  alias?: string;
  visible?: boolean;
  order?: number;
  /** 登记来源标注（map_add_layer / map_upload 等） */
  sourceTool?: string;
  /**
   * 执行工具箱 inspect 的注入实现：给定输入与 GeoJSON 输出路径，返回元信息。
   * Agent 侧与 HTTP 侧各自包装 runToolbox（含 python 路径/cwd/超时/中断信号）。
   */
  inspect: (input: { path: string; layer?: string; output: string }) => Promise<InspectVectorInfo>;
}

export interface IngestVectorResult {
  success: boolean;
  layer?: MapLayer;
  error?: string;
}

/**
 * 把一个矢量数据文件登记为地图图层（不覆盖原始数据，产出受控 GeoJSON 制品）。
 * 成功返回登记后的图层；失败返回 error（不抛异常，便于路由层直接回显）。
 */
export async function ingestVectorAsLayer(options: IngestVectorOptions): Promise<IngestVectorResult> {
  const src = options.path.trim();
  if (!src) return { success: false, error: "缺少矢量数据路径" };
  const layerName = options.layer?.trim() || "";
  // 命名优先级：显式 name → GDB 图层名 → 文件名（`x.gdb/CJXZQ` 取到 CJXZQ）
  const sourceName = options.name?.trim() || layerName || defaultLayerAlias(src);
  const alias = options.alias?.trim() || sourceName;

  const store = options.store;
  store.ensureDirs();
  const artifact = store.allocate(sourceName);
  const info = await options.inspect({
    path: src,
    ...(layerName ? { layer: layerName } : {}),
    output: artifact.absPath,
  });
  if (!info || info.success === false || info.kind !== "vector") {
    return {
      success: false,
      error: info?.error || "仅支持矢量数据（栅格请用 map_inspect 查看元信息）",
    };
  }

  const now = new Date().toISOString();
  const layer: MapLayer = {
    id: artifact.id,
    name: artifact.name,
    alias,
    sessionId: options.sessionId,
    format: "geojson",
    relativePath: artifact.relativePath,
    ...(info.epsg ? { dataCrs: `EPSG:${String(info.epsg)}` } : {}),
    ...(Array.isArray(info.bounds) ? { bounds: info.bounds } : {}),
    ...(typeof info.feature_count === "number" ? { featureCount: info.feature_count } : {}),
    ...(Array.isArray(info.geometry_types) ? { geometryTypes: info.geometry_types } : {}),
    ...(Array.isArray(info.fields) ? { fields: info.fields } : {}),
    createdAt: now,
    sourceTool: options.sourceTool ?? "map_add_layer",
    loadKey: now,
    status: "ready",
  };
  store.upsert(layer);

  const config = readMapConfig(store.dir);
  const state = {
    ...config.layerState[layer.id],
    ...(options.visible === false ? { visible: false } : {}),
    ...(typeof options.order === "number" && Number.isFinite(options.order)
      ? { order: Math.round(options.order) }
      : {}),
  };
  writeMapConfig(store.dir, {
    ...config,
    layerState: { ...config.layerState, [layer.id]: state },
  });
  return { success: true, layer };
}

/** 单个数据集的登记结果（上传响应的数组元素） */
export interface IngestUploadedResult extends IngestVectorResult {
  dataset: string;
  mainFile: string;
}

/**
 * 把一次拖拽上传落盘的文件批量登记为图层。
 * 文件已在 `uploadedRoot` 下按原始相对名落盘（路由层负责 multipart 接收与落盘）；
 * 本函数按 planUploadDatasets 分组，逐数据集调 inspect 注入登记，源文件留在
 * `webgis/uploads/<stamp>/`（不覆盖原始数据，仅读取）。
 */
export async function ingestUploadedVectorFiles(options: {
  store: MapLayerStore;
  sessionId: string;
  /** 上传批次根目录（webgis/uploads/<stamp>），文件按原始相对名落盘 */
  uploadedRoot: string;
  filenames: string[];
  inspect: (input: { path: string; layer?: string; output: string }) => Promise<InspectVectorInfo>;
  sourceTool?: string;
}): Promise<{ results: IngestUploadedResult[]; ignored: string[] }> {
  const { datasets, ignored } = planUploadDatasets(options.filenames);
  const results: IngestUploadedResult[] = [];
  for (const dataset of datasets) {
    // GDB 数据集的主文件是目录名；其余是文件相对路径
    const mainPath = resolve(options.uploadedRoot, dataset.mainFile);
    const res = await ingestVectorAsLayer({
      store: options.store,
      sessionId: options.sessionId,
      path: mainPath,
      name: dataset.key,
      inspect: options.inspect,
      sourceTool: options.sourceTool ?? "map_upload",
    });
    results.push({ ...res, dataset: dataset.key, mainFile: dataset.mainFile });
  }
  return { results, ignored };
}
