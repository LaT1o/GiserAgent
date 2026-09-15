/**
 * WebGIS 地图视图（React + OpenLayers）。
 *
 * 逻辑参照已验证的 OpenLayers 实践（村庄规划动态维护项目 MapView）：
 * - 无底图矢量工作区（中性底色），controls 精简
 * - 可选天地图底图（EPSG:3857 瓦片服务，vec 底图 + cva 注记两层）
 * - VectorSource + GeoJSON.readFeatures，按 loadKey 增量刷新
 * - 单击选中要素 → 回调属性（供属性表与信息面板展示）
 * - ResizeObserver / visibilitychange 强制 updateSize（flex 布局内尺寸变化不触发 window resize）
 * - 样式按「生效色」缓存，不逐要素创建 Style
 *
 * 与参考实现的差异：视图/数据投影不写死，由图层 dataCrs 与项目显示坐标系决定。
 */

import { useEffect, useRef } from "react";
import OlMap from "ol/Map";
import View from "ol/View";
import { Tile as TileLayer, Vector as VectorLayer } from "ol/layer";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import GeoJSON from "ol/format/GeoJSON";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style";
import { Select } from "ol/interaction";
import { click } from "ol/events/condition";
import type { ProjectionLike } from "ol/proj";
import { ensureProjection } from "../map/crs";

/** 地图图层数据（已加载 GeoJSON 的图层） */
export interface MapLayerData {
  id: string;
  name: string;
  alias: string;
  visible: boolean;
  /** 解析后的 GeoJSON FeatureCollection（未加载时为 undefined） */
  geojson?: Record<string, unknown>;
  /** 内容版本（变化时刷新 source） */
  loadKey: string;
  /** 数据坐标系（缺省视为与视图一致） */
  dataCrs?: string;
}

export interface MapFeatureSelection {
  layerId: string;
  layerAlias: string;
  /** 图层内稳定要素索引（属性表行与地图选中联动共用） */
  featureId: string;
  geometryType?: string;
  properties: Record<string, unknown>;
}

export interface MapApi {
  zoomToExtent(layerIds?: string[]): void;
  /** 相对缩放（正数放大，负数缩小） */
  zoomBy(delta: number): void;
  zoomToFeature(layerId: string, featureId: string): void;
  clearSelection(): void;
  /** 按图层与要素索引选中（属性表行点击） */
  selectFeature(layerId: string, featureId: string): void;
}

interface Props {
  layers: MapLayerData[];
  /** 视图坐标系（项目显示坐标系或首个图层坐标系） */
  viewCrs: string;
  /** 底图模式：天地图需要密钥；无密钥时保持矢量工作区可用 */
  basemap: "tianditu" | "none";
  tiandituToken?: string;
  onFeatureSelect: (selection: MapFeatureSelection | null) => void;
  /** 底图状态提示（缺少密钥/加载失败） */
  onBasemapNotice?: (notice: string | null) => void;
  /** 地图就绪/重建后回调（父组件持有 api 用于缩放等操作） */
  onReady?: (api: MapApi) => void;
}

/** 图层配色（按图层 id 稳定取色） */
const PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return PALETTE[hash % PALETTE.length];
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 每种生效色仅创建 点/线/面 三个 Style（大量短命 Style 是拖动卡顿的主因） */
function styleSet(color: string) {
  return {
    point: new Style({
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
      }),
    }),
    line: new Style({ stroke: new Stroke({ color: withAlpha(color, 0.95), width: 2.5 }) }),
    polygon: new Style({
      fill: new Fill({ color: withAlpha(color, 0.28) }),
      stroke: new Stroke({ color: withAlpha(color, 0.95), width: 1.8 }),
    }),
  };
}

/** 天地图瓦片 URL（WMTS 的 XYZ 兼容入口；vec=底图，cva=注记） */
function tiandituUrl(kind: "vec_w" | "cva_w", token: string): string {
  const layer = kind === "vec_w" ? "vec" : "cva";
  return (
    `https://t{0-7}.tianditu.gov.cn/${kind}/wmts?SERVICE=WMTS&REQUEST=GetTile` +
    `&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
    `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${encodeURIComponent(token)}`
  );
}

/** 要素属性（剔除内部标记与几何） */
function readProperties(feature: Feature<Geometry>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(feature.getProperties())) {
    if (key === "geometry" || key.startsWith("__")) continue;
    properties[key] = value === null || value === undefined ? "" : value;
  }
  return properties;
}

export default function MapView({
  layers,
  viewCrs,
  basemap,
  tiandituToken,
  onFeatureSelect,
  onBasemapNotice,
  onReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const coordRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const selectRef = useRef<Select | null>(null);
  const formatRef = useRef(new GeoJSON());
  const baseLayersRef = useRef<TileLayer<XYZ>[]>([]);
  const entriesRef = useRef(
    new Map<string, {
      layer: VectorLayer<VectorSource>;
      source: VectorSource;
      loadedKey: string;
      /** 要素顺序与 GeoJSON 一致：用于 featureId ↔ Feature 双向定位 */
      features: Feature<Geometry>[];
    }>()
  );
  const stylesRef = useRef(new Map<string, ReturnType<typeof styleSet>>());
  const viewCrsRef = useRef(viewCrs);
  const basemapRef = useRef(basemap);
  const tokenRef = useRef(tiandituToken);
  const selectCbRef = useRef(onFeatureSelect);
  selectCbRef.current = onFeatureSelect;
  const noticeCbRef = useRef(onBasemapNotice);
  noticeCbRef.current = onBasemapNotice;
  const readyCbRef = useRef(onReady);
  readyCbRef.current = onReady;
  const prevLayerIdsRef = useRef<Set<string>>(new Set());
  /** 属性表触发的选中需要回写回调，但会再次触发 select 事件造成循环，用标记跳过 */
  const programmaticRef = useRef(false);

  const styleFor = (id: string): ((feature: Feature<Geometry>) => Style) => {
    const color = colorFor(id);
    let styles = stylesRef.current.get(color);
    if (!styles) {
      styles = styleSet(color);
      stylesRef.current.set(color, styles);
    }
    const set = styles;
    return (feature) => {
      const type = feature.getGeometry()?.getType() ?? "Polygon";
      if (type === "Point" || type === "MultiPoint") return set.point;
      if (type === "LineString" || type === "MultiLineString") return set.line;
      return set.polygon;
    };
  };

  const featureOf = (layerId: string, featureId: string): Feature<Geometry> | undefined => {
    const entry = entriesRef.current.get(layerId);
    if (!entry) return undefined;
    const index = Number(featureId);
    return Number.isInteger(index) && index >= 0 && index < entry.features.length
      ? entry.features[index]
      : undefined;
  };

  const emitSelection = (feature: Feature<Geometry> | undefined) => {
    if (!feature) {
      selectCbRef.current(null);
      return;
    }
    const layerId = String(feature.get("__layerId") ?? "");
    const entry = entriesRef.current.get(layerId);
    const featureId = String(entry ? entry.features.indexOf(feature) : -1);
    selectCbRef.current({
      layerId,
      layerAlias: String(feature.get("__layerAlias") ?? ""),
      featureId,
      ...(feature.getGeometry()?.getType() ? { geometryType: feature.getGeometry()!.getType() } : {}),
      properties: readProperties(feature),
    });
  };

  const zoomToExtent = (layerIds?: string[]) => {
    const map = mapRef.current;
    if (!map) return;
    const ids = layerIds?.length ? layerIds : [...entriesRef.current.keys()];
    let extent: [number, number, number, number] | null = null;
    for (const id of ids) {
      const entry = entriesRef.current.get(id);
      if (!entry) continue;
      const ext = entry.source.getExtent() as [number, number, number, number];
      if (!Number.isFinite(ext[0])) continue;
      extent = extent
        ? [
            Math.min(extent[0], ext[0]),
            Math.min(extent[1], ext[1]),
            Math.max(extent[2], ext[2]),
            Math.max(extent[3], ext[3]),
          ]
        : ext;
    }
    if (extent) map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 18 });
  };

  const zoomBy = (delta: number) => {
    const view = mapRef.current?.getView();
    if (!view) return;
    const zoom = view.getZoom();
    if (typeof zoom === "number") view.setZoom(Math.max(0, Math.min(28, zoom + delta)));
  };

  const zoomToFeature = (layerId: string, featureId: string) => {
    const map = mapRef.current;
    const feature = featureOf(layerId, featureId);
    const extent = feature?.getGeometry()?.getExtent();
    if (!map || !extent) return;
    map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 20, duration: 260 });
  };

  const clearSelection = () => {
    const select = selectRef.current;
    if (!select) return;
    programmaticRef.current = true;
    select.getFeatures().clear();
    programmaticRef.current = false;
    // 程序化清空同样要通知上层（select 事件已被标记跳过）
    selectCbRef.current(null);
  };

  const selectFeature = (layerId: string, featureId: string) => {
    const select = selectRef.current;
    const feature = featureOf(layerId, featureId);
    if (!select || !feature) return;
    programmaticRef.current = true;
    select.getFeatures().clear();
    select.getFeatures().push(feature);
    programmaticRef.current = false;
    // 程序化选中同样要通知上层，否则属性表/信息面板收不到联动
    emitSelection(feature);
  };

  const apiRef = useRef<MapApi>({
    zoomToExtent,
    zoomBy,
    zoomToFeature,
    clearSelection,
    selectFeature,
  });

  // 初始化地图（仅一次）：View 的投影随后按 viewCrs 变化重建
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!ensureProjection(viewCrsRef.current)) viewCrsRef.current = "EPSG:4326";
    const map = new OlMap({
      target: container,
      controls: [],
      view: new View({
        projection: viewCrsRef.current as ProjectionLike,
        center: [0, 0],
        zoom: 2,
      }),
    });
    mapRef.current = map;

    const select = new Select({
      condition: click,
      style: new Style({
        fill: new Fill({ color: "rgba(37, 99, 235, 0.40)" }),
        stroke: new Stroke({ color: "#2563eb", width: 3 }),
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: "#2563eb" }),
          stroke: new Stroke({ color: "#fff", width: 2 }),
        }),
      }),
    });
    selectRef.current = select;
    map.addInteraction(select);
    select.on("select", (evt) => {
      if (programmaticRef.current) return;
      emitSelection(evt.selected[0]);
    });

    // 坐标条与可点击光标提示（坐标条直接写 DOM，避免鼠标移动触发 React 重渲染）
    map.on("pointermove", (evt) => {
      if (coordRef.current) {
        coordRef.current.textContent = `X: ${evt.coordinate[0].toFixed(2)}   Y: ${evt.coordinate[1].toFixed(2)}`;
      }
      if (evt.dragging) return;
      const el = map.getTargetElement();
      if (!el) return;
      const hit = map.hasFeatureAtPixel(evt.pixel, { layerFilter: (l) => l instanceof VectorLayer });
      el.style.cursor = hit ? "pointer" : "";
    });

    // flex 布局内尺寸变化不会触发 window resize，需强制重算，否则地图停留在 size=0
    const observer = new ResizeObserver(() => map.updateSize());
    observer.observe(container);
    // 页面从后台切回前台时（rAF 恢复）强制重算尺寸
    const onVisibility = () => {
      if (!document.hidden) map.updateSize();
    };
    document.addEventListener("visibilitychange", onVisibility);

    readyCbRef.current?.(apiRef.current);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const layer of baseLayersRef.current) {
        map.removeLayer(layer);
        layer.getSource()?.clear();
      }
      baseLayersRef.current = [];
      entriesRef.current.clear();
      map.setTarget(undefined);
      mapRef.current = null;
      selectRef.current = null;
    };
    // 仅初始化一次：viewCrs/basemap 变化由下方独立 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视图坐标系变化：重建 View（图层数据由下方同步 effect 按新投影重新读取）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (viewCrsRef.current === viewCrs) return;
    if (!ensureProjection(viewCrs)) return;
    viewCrsRef.current = viewCrs;
    map.setView(
      new View({
        projection: viewCrs as ProjectionLike,
        center: [0, 0],
        zoom: 2,
      })
    );
    // 已建图层需按新投影重读数据
    for (const entry of entriesRef.current.values()) {
      entry.loadedKey = "";
    }
  }, [viewCrs]);

  // 底图切换：天地图两层插到最底部；无密钥/无底图时移除并提示
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    basemapRef.current = basemap;
    tokenRef.current = tiandituToken;
    for (const layer of baseLayersRef.current) {
      map.removeLayer(layer);
      layer.getSource()?.clear();
    }
    baseLayersRef.current = [];
    if (basemap !== "tianditu") {
      noticeCbRef.current?.(null);
      return;
    }
    const token = tiandituToken?.trim();
    if (!token) {
      noticeCbRef.current?.("未配置天地图密钥，当前仅显示矢量图层（可在「设置 → 地图」中填写）");
      return;
    }
    noticeCbRef.current?.(null);
    const created: TileLayer<XYZ>[] = [];
    for (const kind of ["vec_w", "cva_w"] as const) {
      const layer = new TileLayer({
        source: new XYZ({
          url: tiandituUrl(kind, token),
          crossOrigin: "anonymous",
          attributions: "天地图",
        }),
        properties: { title: kind === "vec_w" ? "天地图底图" : "天地图注记" },
      });
      const source = layer.getSource();
      source?.on("tileloaderror", () => {
        noticeCbRef.current?.("天地图瓦片加载失败，请检查密钥与网络（矢量图层不受影响）");
      });
      // 底图始终位于矢量图层之下
      map.getLayers().insertAt(0, layer);
      created.push(layer);
    }
    baseLayersRef.current = created;
  }, [basemap, tiandituToken]);

  // 图层同步：新增/移除/显隐/数据版本变化
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const byId = new Map(layers.map((l) => [l.id, l]));
    for (const [id, entry] of entriesRef.current) {
      if (!byId.has(id)) {
        map.removeLayer(entry.layer);
        entriesRef.current.delete(id);
      }
    }
    const appeared: string[] = [];
    for (const item of layers) {
      if (!item.geojson) continue;
      let entry = entriesRef.current.get(item.id);
      if (!entry) {
        const source = new VectorSource();
        const layer = new VectorLayer({
          source,
          style: styleFor(item.id) as never,
          properties: { title: item.alias },
          updateWhileInteracting: true,
          updateWhileAnimating: true,
        });
        map.addLayer(layer);
        entry = { layer, source, loadedKey: "", features: [] };
        entriesRef.current.set(item.id, entry);
        if (!prevLayerIdsRef.current.has(item.id)) appeared.push(item.id);
      }
      if (entry.loadedKey !== `${item.loadKey}|${viewCrs}`) {
        entry.source.clear();
        entry.features = [];
        // 图层坐标系未知/不受支持时按视图坐标系直读（仅当两者一致才不会错位）
        const dataCrs = item.dataCrs && ensureProjection(item.dataCrs) ? item.dataCrs : viewCrs;
        try {
          const features = formatRef.current.readFeatures(item.geojson, {
            dataProjection: dataCrs as ProjectionLike,
            featureProjection: viewCrs as ProjectionLike,
          }) as Feature<Geometry>[];
          for (const feature of features) {
            feature.set("__layerId", item.id, true);
            feature.set("__layerAlias", item.alias, true);
          }
          entry.source.addFeatures(features);
          entry.features = features;
          entry.loadedKey = `${item.loadKey}|${viewCrs}`;
        } catch (err) {
          console.warn(`[map] 图层 ${item.name} 解析失败: ${(err as Error).message}`);
        }
      }
      entry.layer.setVisible(item.visible);
    }
    prevLayerIdsRef.current = new Set(layers.map((l) => l.id));
    if (appeared.length) zoomToExtent(appeared);
    // styleFor/zoomToExtent 每次渲染重建，语义稳定（仅依赖 ref），不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, viewCrs]);

  return (
    <div className="map-canvas-wrap">
      <div ref={containerRef} className="map-canvas" />
      <div ref={coordRef} className="map-coord-bar" />
    </div>
  );
}
