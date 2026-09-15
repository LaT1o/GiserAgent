/**
 * 地图只读属性表（地图画布下方，ArcGIS/QGIS 风格）。
 *
 * 数据源为工作区已加载的 GeoJSON；行点击与地图选中状态双向联动。
 * 本轮只读：不写回原始数据，也不提供编辑入口。
 */

import { useEffect, useMemo, useState } from "react";
import type { MapFeatureSelection, MapLayerData } from "./MapView";
import type { MapLayerInfo } from "../types";

interface Props {
  layers: MapLayerInfo[];
  mapLayers: MapLayerData[];
  selected: MapFeatureSelection | null;
  /** 行点击：选中并定位（由 App/MapPanel 转发到地图 API） */
  onSelectFeature: (layerId: string, featureId: string) => void;
  onClose: () => void;
}

const PAGE_SIZE = 50;

interface TableRow {
  featureId: string;
  properties: Record<string, unknown>;
}

/** 从 GeoJSON FeatureCollection 取要素属性（与 MapView 的 featureId=索引 对齐） */
function rowsOf(geojson: Record<string, unknown> | undefined): TableRow[] {
  const features = (geojson as { features?: unknown } | undefined)?.features;
  if (!Array.isArray(features)) return [];
  return features.map((feature, index) => {
    const properties = (feature as { properties?: unknown })?.properties;
    return {
      featureId: String(index),
      properties: properties && typeof properties === "object"
        ? (properties as Record<string, unknown>)
        : {},
    };
  });
}

export default function MapAttributeTable({
  layers,
  mapLayers,
  selected,
  onSelectFeature,
  onClose,
}: Props) {
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);

  // 当前选中要素所属图层优先；否则取首个有数据的图层
  const dataLayers = useMemo(
    () => mapLayers.filter((layer) => layer.geojson),
    [mapLayers]
  );

  useEffect(() => {
    if (selected && dataLayers.some((layer) => layer.id === selected.layerId)) {
      setActiveLayerId(selected.layerId);
      return;
    }
    setActiveLayerId((current) =>
      current && dataLayers.some((layer) => layer.id === current)
        ? current
        : dataLayers[0]?.id ?? null
    );
  }, [dataLayers, selected]);

  useEffect(() => {
    setPage(0);
  }, [activeLayerId, keyword]);

  const activeLayer = dataLayers.find((layer) => layer.id === activeLayerId) ?? null;
  const meta = layers.find((layer) => layer.id === activeLayerId);
  const allRows = useMemo(() => rowsOf(activeLayer?.geojson), [activeLayer]);

  const columns = useMemo(() => {
    const declared = meta?.fields?.map((field) => field.name) ?? [];
    if (declared.length) return declared;
    const seen = new Set<string>();
    for (const row of allRows) {
      for (const key of Object.keys(row.properties)) seen.add(key);
      if (seen.size > 24) break;
    }
    return [...seen];
  }, [meta, allRows]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter((row) =>
      Object.values(row.properties).some((value) =>
        String(value ?? "").toLowerCase().includes(query)
      )
    );
  }, [allRows, keyword]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <section className="map-attr" aria-label="图层属性表">
      <div className="map-attr-head">
        <span className="map-attr-title">属性表</span>
        <div className="map-attr-tabs" role="tablist" aria-label="属性表图层">
          {dataLayers.length === 0 && <span className="map-attr-empty-hint">暂无可展示的图层数据</span>}
          {dataLayers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              role="tab"
              aria-selected={layer.id === activeLayerId}
              className={`map-attr-tab ${layer.id === activeLayerId ? "active" : ""}`}
              title={layer.name}
              onClick={() => setActiveLayerId(layer.id)}
            >
              {layer.alias}
              <span className="map-attr-tab-count">{rowsOf(layer.geojson).length}</span>
            </button>
          ))}
        </div>
        <button type="button" className="map-panel-btn" title="关闭属性表" onClick={onClose}>
          ✕
        </button>
      </div>

      {activeLayer && (
        <>
          <div className="map-attr-toolbar">
            <input
              className="map-attr-search"
              value={keyword}
              placeholder="筛选要素（任意字段包含关键字）"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <span className="map-attr-summary">
              {keyword.trim() ? `${filtered.length} / ${allRows.length}` : `${allRows.length}`} 个要素
              {meta?.dataCrs ? ` · ${meta.dataCrs}` : ""}
            </span>
            <span className="map-attr-readonly" title="本轮属性表只读，不修改原始数据">
              只读
            </span>
          </div>

          <div className="map-attr-body">
            <table className="map-attr-table">
              <thead>
                <tr>
                  <th className="map-attr-index">#</th>
                  {columns.map((column) => (
                    <th key={column} title={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const isSelected =
                    selected?.layerId === activeLayer.id && selected?.featureId === row.featureId;
                  return (
                    <tr
                      key={row.featureId}
                      className={isSelected ? "active" : ""}
                      onClick={() => onSelectFeature(activeLayer.id, row.featureId)}
                      title="点击选中并在地图上定位"
                    >
                      <td className="map-attr-index">{Number(row.featureId) + 1}</td>
                      {columns.map((column) => {
                        const text = String(row.properties[column] ?? "");
                        return <td key={column} title={text}>{text}</td>;
                      })}
                    </tr>
                  );
                })}
                {!pageRows.length && (
                  <tr>
                    <td className="map-attr-none" colSpan={columns.length + 1}>
                      {keyword.trim() ? "没有匹配的要素" : "该图层没有要素"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="map-attr-pager">
              <button type="button" className="map-panel-btn" disabled={currentPage <= 0} onClick={() => setPage(currentPage - 1)}>
                ‹ 上一页
              </button>
              <span className="map-attr-page-info">
                {currentPage + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="map-panel-btn"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页 ›
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
