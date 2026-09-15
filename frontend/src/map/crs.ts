/**
 * 地图坐标系注册（OpenLayers + proj4）。
 *
 * 数据侧 GeoJSON 坐标保持原始坐标系（图层元数据 dataCrs），前端把视图与数据
 * 统一到同一投影后渲染。内置投影（4326/3857）由 OpenLayers 自带；国内常用的
 * CGCS2000 3 度带高斯-克吕格投影（EPSG:4513~4554）由 proj4 现场注册：
 * - 4513~4533：带带号（假东 = 带号 * 1e6 + 500000），带号 25~45（中央经线 75E~135E）
 * - 4534~4554：不带带号（假东 500000），中央经线 75E~135E
 * 其余未知 EPSG 代码返回 false，由调用方提示用户（当前不做动态查询）。
 */

import proj4 from "proj4";
import { register } from "ol/proj/proj4";
import { get as getProjection } from "ol/proj";

const ZONE_WITH_PREFIX_MIN = 4513;
const ZONE_WITH_PREFIX_MAX = 4533;
const CM_ONLY_MIN = 4534;
const CM_ONLY_MAX = 4554;

/** 已注册标记（避免重复 defs） */
const registered = new Set<string>();

function defForEpsg(code: number): string | null {
  const ellps = "+ellps=GRS80 +units=m +no_defs";
  if (code >= ZONE_WITH_PREFIX_MIN && code <= ZONE_WITH_PREFIX_MAX) {
    const zone = 25 + (code - ZONE_WITH_PREFIX_MIN);
    const lon0 = zone * 3;
    const x0 = zone * 1_000_000 + 500_000;
    return `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 ${ellps}`;
  }
  if (code >= CM_ONLY_MIN && code <= CM_ONLY_MAX) {
    const lon0 = 75 + 3 * (code - CM_ONLY_MIN);
    return `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=500000 +y_0=0 ${ellps}`;
  }
  return null;
}

/**
 * 确保 EPSG 代码可用；返回 true 表示可用于 View/readFeatures 的投影参数。
 * 支持：内置投影（4326/3857）、CGCS2000 3 度带（4513~4554）。
 */
export function ensureProjection(code?: string): boolean {
  if (!code) return false;
  const normalized = code.trim().toUpperCase();
  if (!/^EPSG:\d+$/.test(normalized)) return false;
  if (getProjection(normalized)) return true;
  if (registered.has(normalized)) return true;
  const numeric = Number(normalized.slice(5));
  const def = defForEpsg(numeric);
  if (!def) return false;
  proj4.defs(normalized, def);
  register(proj4);
  registered.add(normalized);
  return Boolean(getProjection(normalized));
}

/** 取第一个可用坐标系（用于确定视图投影：项目显示坐标系 → 首个图层 → 4326） */
export function pickViewCrs(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && ensureProjection(candidate)) return candidate.trim().toUpperCase();
  }
  return "EPSG:4326";
}
