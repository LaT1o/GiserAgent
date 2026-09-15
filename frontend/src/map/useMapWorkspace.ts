/**
 * 地图工作区状态（由 App 持有，供中间地图列与侧栏图层列表共享）。
 *
 * 注册项目按项目读取共享 .latio/webgis；临时会话继续使用会话级入口。
 * 这样切换项目组时，左侧图层树和地图无需先打开某个会话即可同步。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  deleteProjectMapLayer,
  fetchMapLayerGeoJSON,
  fetchMapLayers,
  fetchProjectMapLayerGeoJSON,
  fetchProjectMapLayers,
  updateProjectMapLayer,
} from "../api/client";
import type { MapLayerInfo } from "../types";
import type { MapApi, MapFeatureSelection, MapLayerData } from "../components/MapView";
import { pickViewCrs } from "./crs";

export interface MapContext {
  key: string;
  projectId?: string;
  sessionId?: string;
  title: string;
}

export interface MapWorkspace {
  context: MapContext | null;
  layers: MapLayerInfo[];
  mapLayers: MapLayerData[];
  /** 图层 id → 已加载的 GeoJSON（属性表行数据源） */
  geojsonByLayer: Record<string, Record<string, unknown>>;
  viewCrs: string;
  totalFeatures: number;
  hidden: Record<string, boolean>;
  selected: MapFeatureSelection | null;
  error: string | null;
  loading: boolean;
  apiRef: RefObject<MapApi | null>;
  setSelected: (selection: MapFeatureSelection | null) => void;
  /** 图层当前是否隐藏（合并项目配置与本地操作） */
  isHidden: (layerId: string) => boolean;
  /** 切换显隐；注册项目会写入项目地图配置（持久化） */
  toggleHidden: (layerId: string) => void;
  renameLayer: (layerId: string, alias: string) => Promise<void>;
  removeLayer: (layerId: string, options?: { purgeArtifact?: boolean }) => Promise<void>;
  reload: () => Promise<void>;
}

function emptyContext(): MapContext {
  return { key: "none", title: "未选择项目" };
}

/**
 * @param context 当前项目上下文；注册项目优先使用项目 API，临时上下文回退会话 API
 * @param revision Agent 产出新图层后递增，触发刷新
 * @param basemap 当前底图模式（由 MapView 使用）
 */
export function useMapWorkspace(
  context: MapContext | null,
  revision = 0,
  basemap: "tianditu" | "none" = "tianditu"
): MapWorkspace {
  const [layers, setLayers] = useState<MapLayerInfo[]>([]);
  const [data, setData] = useState<Record<string, Record<string, unknown>>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<MapFeatureSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const apiRef = useRef<MapApi | null>(null);
  /** 已加载 GeoJSON 与对应 loadKey：轮询刷新时命中缓存则不重复下载 */
  const dataRef = useRef<Record<string, Record<string, unknown>>>({});
  const cacheKeysRef = useRef<Record<string, string | undefined>>({});
  const effectiveContext = context ?? emptyContext();

  const reload = useCallback(async () => {
    if (!context) {
      setLayers([]);
      setData({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = context.projectId
        ? await fetchProjectMapLayers(context.projectId)
        : context.sessionId
          ? await fetchMapLayers(context.sessionId)
          : { layers: [] };
      const list = response.layers;
      setLayers(list);
      // 只对新增或内容版本变化的图层重取 GeoJSON：轮询刷新时避免重复下载大图层
      const previous = dataRef.current;
      const loaded: Record<string, Record<string, unknown>> = {};
      await Promise.all(
        list.map(async (layer) => {
          const cached = previous[layer.id];
          const cacheKey = cacheKeysRef.current[layer.id];
          if (cached && cacheKey === layer.loadKey) {
            loaded[layer.id] = cached;
            return;
          }
          try {
            if (context.projectId) {
              loaded[layer.id] = await fetchProjectMapLayerGeoJSON(context.projectId, layer.id);
            } else if (context.sessionId) {
              loaded[layer.id] = await fetchMapLayerGeoJSON(context.sessionId, layer.id);
            }
          } catch (err) {
            setError(`图层「${layer.alias}」加载失败：${(err as Error).message}`);
          }
        })
      );
      dataRef.current = loaded;
      cacheKeysRef.current = Object.fromEntries(
        list.filter((layer) => loaded[layer.id]).map((layer) => [layer.id, layer.loadKey])
      );
      setData(loaded);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [context]);

  useEffect(() => {
    setLayers([]);
    setData({});
    dataRef.current = {};
    cacheKeysRef.current = {};
    setHidden({});
    setSelected(null);
    setError(null);
    apiRef.current?.clearSelection();
  }, [context?.key]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  // 项目级图层可能由另一个会话写入；低频轮询仅在有地图上下文时启用。
  useEffect(() => {
    if (!context) return;
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [context?.key, reload]);

  const viewCrs = useMemo(() => pickViewCrs(layers.map((l) => l.dataCrs)), [layers]);

  const mapLayers = useMemo<MapLayerData[]>(
    () => layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      alias: layer.alias,
      // 显隐优先级：用户本次操作 > 项目地图配置 > 默认显示
      visible: hidden[layer.id] !== undefined ? !hidden[layer.id] : layer.visible !== false,
      ...(data[layer.id] ? { geojson: data[layer.id] } : {}),
      loadKey: layer.loadKey,
      ...(layer.dataCrs ? { dataCrs: layer.dataCrs } : {}),
      basemap,
    })),
    [layers, data, hidden, basemap]
  );

  const totalFeatures = layers.reduce((sum, layer) => sum + (layer.featureCount ?? 0), 0);

  /** 图层是否隐藏（用户本次操作 > 项目地图配置 > 默认显示） */
  const isHidden = useCallback(
    (layerId: string): boolean => {
      if (hidden[layerId] !== undefined) return hidden[layerId];
      return layers.find((layer) => layer.id === layerId)?.visible === false;
    },
    [hidden, layers]
  );

  /** 显隐：先本地立即生效，注册项目再写回项目地图配置 */
  const toggleHidden = useCallback((layerId: string) => {
    setHidden((previous) => {
      const layer = layers.find((item) => item.id === layerId);
      const current = previous[layerId] ?? layer?.visible === false;
      const next = !current;
      if (context?.projectId) {
        void updateProjectMapLayer(context.projectId, layerId, { visible: !next }).catch(() => {
          /* 写入失败保持本地状态，下次刷新回归服务端值 */
        });
      }
      return { ...previous, [layerId]: next };
    });
  }, [context?.projectId, layers]);

  /** 图层显示名（写入项目图层注册表） */
  const renameLayer = useCallback(async (layerId: string, alias: string) => {
    const name = alias.trim();
    if (!name) return;
    if (!context?.projectId) {
      setError("临时会话的图层暂不支持改名，请先绑定注册项目");
      return;
    }
    try {
      const { layer } = await updateProjectMapLayer(context.projectId, layerId, { alias: name });
      setLayers((previous) => previous.map((item) => (item.id === layer.id ? { ...item, ...layer } : item)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [context?.projectId]);

  /** 解除图层挂载（默认保留 GeoJSON 制品） */
  const removeLayer = useCallback(async (layerId: string, options?: { purgeArtifact?: boolean }) => {
    if (!context?.projectId) {
      setError("临时会话的图层暂不支持移除，请先绑定注册项目");
      return;
    }
    try {
      await deleteProjectMapLayer(context.projectId, layerId, options?.purgeArtifact === true);
      setLayers((previous) => previous.filter((item) => item.id !== layerId));
      setData((previous) => {
        const next = { ...previous };
        delete next[layerId];
        return next;
      });
      delete dataRef.current[layerId];
      delete cacheKeysRef.current[layerId];
      setSelected((current) => (current?.layerId === layerId ? null : current));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [context?.projectId]);

  return {
    context,
    layers,
    mapLayers,
    geojsonByLayer: data,
    viewCrs,
    totalFeatures,
    hidden,
    selected,
    error,
    loading,
    apiRef,
    setSelected,
    isHidden,
    toggleHidden,
    renameLayer,
    removeLayer,
    reload,
  };
}
