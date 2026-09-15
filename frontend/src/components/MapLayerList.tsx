/**
 * 侧栏下半部的图层列表：当前项目（或临时会话）的 WebGIS 图层。
 *
 * 常驻显示：只要选择了项目/会话即出现，不依赖地图窗口开关。
 * 与地图列共享同一份地图工作区状态（map/useMapWorkspace.ts）：
 * 显隐、定位、改名与移除都会立即反映到地图上，注册项目还会写回项目地图配置。
 */

import { useState } from "react";
import type { MapWorkspace } from "../map/useMapWorkspace";
import { ensureProjection } from "../map/crs";
import { useVectorDrop } from "../map/useVectorDrop";
import RowMenu from "./RowMenu";

/** 旧图层条目的 sourceTool 可能是工具改名前的 `gis_*`（仅影响显示） */
const legacyToolLabel = (tool: string) => tool.replace(/^gis_/, "map_");

export default function MapLayerList({ workspace }: { workspace: MapWorkspace }) {
  const {
    context, layers, error, loading, isHidden,
    toggleHidden, renameLayer, removeLayer, reload, apiRef,
  } = workspace;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const drop = useVectorDrop(context, () => void reload());

  const submitRename = async (layerId: string) => {
    const alias = draft.trim();
    setRenamingId(null);
    setDraft("");
    if (alias) await renameLayer(layerId, alias);
  };

  return (
    <section
      className={`sidebar-layers${drop.dragOver ? " drag-over" : ""}`}
      aria-label="地图图层"
      {...drop.handlers}
    >
      <div className="sidebar-layers-header">
        <span className="sidebar-layers-title">地图图层</span>
        <span className="sidebar-layers-count">{layers.length ? `${layers.length} 个` : ""}</span>
        <button
          type="button"
          className="sidebar-layers-btn"
          title="刷新图层"
          disabled={loading}
          onClick={() => void reload()}
        >
          ⟳
        </button>
      </div>
      {context && (
        <div className="sidebar-layers-context" title={context.title}>
          {context.projectId ? "项目" : "临时"}：{context.title}
        </div>
      )}
      {error && <div className="sidebar-layers-error">{error}</div>}
      {drop.message && (
        <div className={drop.isError ? "sidebar-layers-error" : "sidebar-layers-drop-msg"}>{drop.message}</div>
      )}
      {drop.dragOver && <div className="sidebar-layers-drop-hint">松开以加载矢量数据</div>}
      {drop.busy && <div className="sidebar-layers-drop-hint busy">正在登记图层…</div>}
      <div className="sidebar-layers-body">
        {layers.length === 0 ? (
          <div className="sidebar-layers-empty">
            暂无图层。把 shp / gpkg / geojson / kml / gdb 拖到这里或地图上即可上图；
            也可以让 Agent 用 <code>map_inspect</code> / <code>map_add_layer</code> 登记。
          </div>
        ) : (
          layers.map((layer) => {
            const hidden = isHidden(layer.id);
            const unsupported = !!layer.dataCrs && !ensureProjection(layer.dataCrs);
            return (
              <div key={layer.id} className={`map-layer-row ${hidden ? "is-hidden" : ""}`}>
                <button
                  type="button"
                  className="map-layer-eye"
                  onClick={() => toggleHidden(layer.id)}
                  title={hidden ? "显示图层" : "隐藏图层"}
                >
                  {hidden ? "○" : "●"}
                </button>
                {renamingId === layer.id ? (
                  <input
                    className="map-layer-rename"
                    value={draft}
                    autoFocus
                    aria-label="图层显示名"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") void submitRename(layer.id);
                      if (event.key === "Escape") { setRenamingId(null); setDraft(""); }
                    }}
                    onBlur={() => void submitRename(layer.id)}
                  />
                ) : (
                  <span
                    className="map-layer-name"
                    title={`${layer.name}（${layer.geometryTypes?.join("/") ?? ""}）${layer.sourceTool ? ` · ${legacyToolLabel(layer.sourceTool)}` : ""}`}
                  >
                    {layer.alias}
                    {unsupported && <em className="map-layer-warn">坐标系未支持</em>}
                  </span>
                )}
                <span className="map-layer-meta">
                  {layer.featureCount ?? "?"} 要素
                  {layer.dataCrs ? ` · ${layer.dataCrs}` : ""}
                </span>
                <button
                  type="button"
                  className="map-layer-zoom"
                  onClick={() => apiRef.current?.zoomToExtent([layer.id])}
                  title="缩放到该图层"
                >
                  定位
                </button>
                <RowMenu
                  label={`图层「${layer.alias}」的操作`}
                  actions={[
                    { label: "重命名", onSelect: () => { setDraft(layer.alias); setRenamingId(layer.id); } },
                    { label: hidden ? "显示" : "隐藏", onSelect: () => toggleHidden(layer.id) },
                    {
                      label: "从地图移除",
                      danger: true,
                      disabled: !context?.projectId,
                      onSelect: () => void removeLayer(layer.id),
                    },
                    {
                      label: "移除并删除制品",
                      danger: true,
                      disabled: !context?.projectId,
                      onSelect: () => void removeLayer(layer.id, { purgeArtifact: true }),
                    },
                  ]}
                />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
