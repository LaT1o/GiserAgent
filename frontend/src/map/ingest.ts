/**
 * 拖拽矢量文件上图（用户操作入口，与 Agent 的 map_add_layer 共用服务端登记管线）。
 *
 * 前端只做三件事：收集拖拽的文件（含 .gdb 目录遍历）、按相对路径保留
 * sidecar 分组信息装进 FormData、调上传接口后触发工作区刷新。数据集分组、
 * 源数据保护、坐标系解析、GeoJSON 制品生成都由服务端 webgis 管线完成。
 */

import { uploadProjectMapLayers, uploadSessionMapLayers, type UploadMapLayersResult } from "../api/client";
import type { MapContext } from "./useMapWorkspace";

/** 拖拽进来的一个待上传文件：File 对象 + 用于分组的相对路径 */
export interface IngestFileEntry {
  file: File;
  /** 相对路径（.gdb 目录会带目录前缀；普通文件就是文件名） */
  relativePath: string;
}

/** 可识别的矢量扩展名（与服务端 planUploadDatasets 对齐，仅用于拖拽前的友好提示） */
const VECTOR_EXTS = [".shp", ".dbf", ".shx", ".prj", ".cpg", ".sbn", ".sbx", ".qix", ".gpkg", ".geojson", ".json", ".kml"];

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** 收集 DataTransfer 里的全部文件（递归展开 .gdb 等目录），返回相对路径形式 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<IngestFileEntry[]> {
  const entries: IngestFileEntry[] = [];
  const items = Array.from(dataTransfer.items);

  // 目录遍历（webkitGetAsEntry 是浏览器拖拽目录的标准入口）
  const walkEntry = (entry: FileSystemEntry, prefix: string): Promise<void> =>
    new Promise((resolveWalk, reject) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(
          (file) => {
            entries.push({ file, relativePath: prefix + file.name });
            resolveWalk();
          },
          reject
        );
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const dirPrefix = `${prefix}${entry.name}/`;
        const readBatch = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) {
              resolveWalk();
              return;
            }
            try {
              await Promise.all(batch.map((child) => walkEntry(child, dirPrefix)));
              readBatch();
            } catch (err) {
              reject(err as Error);
            }
          }, reject);
        };
        readBatch();
      } else {
        resolveWalk();
      }
    });

  const dirItems = items.filter((item) => item.kind === "file" && typeof item.webkitGetAsEntry === "function");
  const entryList = dirItems
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entryList.length) {
    await Promise.all(entryList.map((entry) => walkEntry(entry, "")));
    return entries;
  }

  // 回退：entry 不可用（如合成拖拽事件）时直接取文件（无法表达目录结构）
  for (const file of Array.from(dataTransfer.files)) {
    entries.push({ file, relativePath: file.name });
  }
  return entries;
}

/** 上传结果的用户可读摘要（成功 N 个 / 失败与忽略的文件提示） */
export function summarizeUpload(result: UploadMapLayersResult): string {
  const parts: string[] = [];
  if (result.layers.length) parts.push(`已登记 ${result.layers.length} 个图层`);
  if (result.failed.length) {
    parts.push(`失败 ${result.failed.length} 个：${result.failed.map((f) => `${f.dataset}（${f.error ?? "?"}）`).join("；")}`);
  }
  if (result.ignored.length) {
    parts.push(`已忽略 ${result.ignored.length} 个无法识别的文件：${result.ignored.slice(0, 5).join("、")}${result.ignored.length > 5 ? "…" : ""}`);
  }
  return parts.join("；") || "未登记任何图层";
}

/**
 * 把拖拽的文件上传到当前地图上下文并登记为图层。
 * 返回用户可读摘要；任何数据集都没登记成功时抛出错误（调用方据此提示）。
 */
export async function ingestDroppedFiles(context: MapContext, files: IngestFileEntry[]): Promise<string> {
  if (!files.length) throw new Error("未检测到可上传的文件");
  const recognized = files.filter((entry) => {
    const name = entry.relativePath.replace(/\\/g, "/");
    if (/\.gdb(\/|$)/i.test(name)) return true;
    return VECTOR_EXTS.includes(extOf(name));
  });
  if (!recognized.length) {
    throw new Error("未识别到支持的矢量数据（shp/gpkg/geojson/json/kml/gdb）");
  }
  const form = new FormData();
  for (const entry of recognized) {
    // 第三个参数携带相对路径，服务端据此还原文名并把 shp sidecar / gdb 目录归组
    form.append("files", entry.file, entry.relativePath);
  }
  const result = context.projectId
    ? await uploadProjectMapLayers(context.projectId, form)
    : context.sessionId
      ? await uploadSessionMapLayers(context.sessionId, form)
      : (() => { throw new Error("当前没有可接收图层的项目或会话"); })();
  const summary = summarizeUpload(result);
  if (!result.layers.length) throw new Error(summary || "未登记任何图层");
  return summary;
}
