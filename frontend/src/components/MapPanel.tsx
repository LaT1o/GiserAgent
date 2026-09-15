/**
 * WebGIS 地图列（位于会话列表与对话区之间）。
 *
 * 布局参照 ArcGIS/QGIS：顶部标题栏 + 分组工具栏 + 地图画布 + 底部只读属性表。
 * 图层数据与显隐由 App 的地图工作区状态统一持有（map/useMapWorkspace.ts），
 * 本组件只负责渲染、选择联动与视图操作。
 */

import { useState, type CSSProperties } from "react";
import type { MapWorkspace } from "../map/useMapWorkspace";
import { useVectorDrop } from "../map/useVectorDrop";
import type { BasemapMode } from "../types";
import MapView from "./MapView";
import MapAttributeTable from "./MapAttributeTable";
import RowSplitter from "./RowSplitter";
import { useVerticalSplit } from "../hooks/useVerticalSplit";

interface Props {
  workspace: MapWorkspace;
  /** 当前项目/临时目录名称（地图标题） */
  projectTitle: string;
  /** 底图模式与天地图密钥（来自应用设置） */
  basemap: BasemapMode;
  /** 天地图注记图层开关（来自应用设置） */
  annotations: boolean;
  tiandituToken?: string;
  /** 切换底图（写应用设置；「无底图」为纯矢量工作区） */
  onBasemapChange: (basemap: BasemapMode) => void;
  /** 切换天地图注记图层（写应用设置） */
  onAnnotationsChange: (annotations: boolean) => void;
  onClose: () => void;
}

export default function MapPanel({
  workspace,
  projectTitle,
  basemap,
  annotations,
  tiandituToken,
  onBasemapChange,
  onAnnotationsChange,
  onClose,
}: Props) {
  const {
    context,
    layers,
    mapLayers,
    viewCrs,
    totalFeatures,
    selected,
    setSelected,
    error,
    loading,
    reload,
    apiRef,
  } = workspace;
  const [attrOpen, setAttrOpen] = useState(true);
  const drop = useVectorDrop(context, () => void reload());
  /** 画布与属性表的高度分配（ratio 为上方画布占比，属性表默认占 38%，可拖动，独立记忆） */
  const attrSplit = useVerticalSplit({
    storageKey: "giser-map-split-v2",
    defaultRatio: 0.62,
    minFirst: 180,
    minSecond: 120,
  });
  /** 底图状态提示（缺少密钥/瓦片失败），不阻塞矢量图层使用 */
  const [basemapNotice, setBasemapNotice] = useState<string | null>(null);

  const selectFeature = (layerId: string, featureId: string) => {
    apiRef.current?.selectFeature(layerId, featureId);
    apiRef.current?.zoomToFeature(layerId, featureId);
  };

  return (
    <aside
      className="map-panel"
      ref={attrSplit.containerRef}
      style={{ "--map-attr-height": `${((1 - attrSplit.ratio) * 100).toFixed(2)}%` } as CSSProperties}
    >
      <div className="map-panel-header">
        <span className="map-panel-title" title={projectTitle}>{projectTitle}</span>
        <span className="map-panel-count">
          {layers.length} 图层 · {totalFeatures} 要素
        </span>
        <div className="map-panel-spacer" />
        <button className="map-panel-btn" onClick={onClose} title="关闭地图">
          ✕
        </button>
      </div>

      {/* 分组工具栏（ArcGIS/QGIS 习惯：导航 / 查询 / 数据） */}
      <div className="map-toolbar" role="toolbar" aria-label="地图工具">
        <div className="map-tool-group" role="group" aria-label="导航">
          <button
            type="button"
            className="map-tool-btn"
            title="全图（缩放到全部图层）"
            onClick={() => apiRef.current?.zoomToExtent()}
          >
            ⤢
          </button>
          <button
            type="button"
            className="map-tool-btn"
            title="放大"
            onClick={() => apiRef.current?.zoomBy(1)}
          >
            ＋
          </button>
          <button
            type="button"
            className="map-tool-btn"
            title="缩小"
            onClick={() => apiRef.current?.zoomBy(-1)}
          >
            －
          </button>
        </div>
        <div className="map-tool-group" role="group" aria-label="查询">
          <button
            type="button"
            className="map-tool-btn"
            title="清除选择"
            disabled={!selected}
            onClick={() => apiRef.current?.clearSelection()}
          >
            ⊘
          </button>
          <button
            type="button"
            className={`map-tool-btn ${attrOpen ? "active" : ""}`}
            title={attrOpen ? "关闭属性表" : "打开属性表"}
            aria-pressed={attrOpen}
            onClick={() => setAttrOpen((open) => !open)}
          >
            ▤
          </button>
        </div>
        <div className="map-tool-group" role="group" aria-label="数据">
          <button
            type="button"
            className="map-tool-btn"
            title="刷新图层"
            disabled={loading}
            onClick={() => void reload()}
          >
            ⟳
          </button>
          <span className="map-tool-note" title="测距、测面与导出在后续版本接入 command 契约">
            测距 / 导出后续接入
          </span>
        </div>
        <div className="map-tool-group" role="group" aria-label="底图">
          <span className="map-tool-label">底图</span>
          <button
            type="button"
            className={`map-tool-btn ${basemap === "tianditu_vec" ? "active" : ""}`}
            title="天地图矢量底图（密钥在「设置 → 地图」中填写）"
            aria-pressed={basemap === "tianditu_vec"}
            onClick={() => onBasemapChange("tianditu_vec")}
          >
            矢量
          </button>
          <button
            type="button"
            className={`map-tool-btn ${basemap === "tianditu_img" ? "active" : ""}`}
            title="天地图影像底图（密钥在「设置 → 地图」中填写）"
            aria-pressed={basemap === "tianditu_img"}
            onClick={() => onBasemapChange("tianditu_img")}
          >
            影像
          </button>
          <button
            type="button"
            className={`map-tool-btn ${basemap === "none" ? "active" : ""}`}
            title="无底图（纯矢量工作区，不请求外部瓦片）"
            aria-pressed={basemap === "none"}
            onClick={() => onBasemapChange("none")}
          >
            无
          </button>
          <button
            type="button"
            className={`map-tool-btn ${annotations ? "active" : ""}`}
            title={basemap === "none" ? "注记图层需配合天地图底图使用" : "天地图注记图层（地名/道路标注）"}
            aria-pressed={annotations}
            disabled={basemap === "none"}
            onClick={() => onAnnotationsChange(!annotations)}
          >
            注记
          </button>
        </div>
      </div>

      {error && <div className="map-panel-error">{error}</div>}
      {basemapNotice && <div className="map-panel-notice">{basemapNotice}</div>}
      {drop.message && (
        <div className={drop.isError ? "map-panel-error" : "map-panel-notice"}>{drop.message}</div>
      )}

      <div
        className={`map-drop-zone${drop.dragOver ? " drag-over" : ""}`}
        {...drop.handlers}
      >
        <MapView
          layers={mapLayers}
          viewCrs={viewCrs}
          basemap={basemap}
          annotations={annotations}
          tiandituToken={tiandituToken}
          onFeatureSelect={setSelected}
          onBasemapNotice={setBasemapNotice}
          onReady={(api) => {
            apiRef.current = api;
          }}
        />
        {drop.dragOver && (
          <div className="map-drop-hint">松开以加载矢量数据（shp / gpkg / geojson / kml / gdb）</div>
        )}
        {drop.busy && <div className="map-drop-hint busy">正在登记图层…</div>}
      </div>

      {selected && (
        <div className="map-feature-info">
          <div className="map-feature-header">
            <span>当前要素 · {selected.layerAlias}</span>
            <span className="map-feature-geom">{selected.geometryType}</span>
            <button className="map-panel-btn" onClick={() => apiRef.current?.clearSelection()} title="清除选择">
              ✕
            </button>
          </div>
          <div className="map-feature-body">
            <table className="map-feature-table">
              <tbody>
                {Object.entries(selected.properties).map(([key, value]) => (
                  <tr key={key}>
                    <th>{key}</th>
                    <td>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {attrOpen && (
        <>
          <RowSplitter
            label="调整属性表高度"
            onResizeStart={attrSplit.startResize}
            onAdjust={attrSplit.adjust}
          />
          <MapAttributeTable
            layers={layers}
            mapLayers={mapLayers}
            selected={selected}
            onSelectFeature={selectFeature}
            onClose={() => setAttrOpen(false)}
          />
        </>
      )}
    </aside>
  );
}
