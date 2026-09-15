/**
 * 矢量文件拖拽上图 hook：给地图画布 / 图层列表挂 HTML5 drag&drop，
 * 把拖进来的 shp/gpkg/geojson/json/kml/gdb 交给 map/ingest 登记为图层。
 *
 * 只负责事件接线与加载态/反馈，数据集分组与登记由 map/ingest + 服务端完成。
 */

import { useCallback, useRef, useState, type DragEvent } from "react";
import { collectDroppedFiles, ingestDroppedFiles, type IngestFileEntry } from "./ingest";
import type { MapContext } from "./useMapWorkspace";

export interface VectorDropState {
  /** 是否有可识别文件正悬在放置区上方（用于高亮） */
  dragOver: boolean;
  /** 是否正在上传/登记 */
  busy: boolean;
  /** 最近一次登记结果摘要（成功/失败/忽略） */
  message: string | null;
  /** 是否为错误反馈（成功为 false） */
  isError: boolean;
  handlers: {
    onDragOver: (event: DragEvent) => void;
    onDragEnter: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}

/** 绑定到一个可接收矢量文件拖拽的容器（地图画布 / 图层列表） */
export function useVectorDrop(context: MapContext | null, onIngested: () => void): VectorDropState {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  // 计数器避免子元素 dragenter/dragleave 交替造成高亮闪烁
  const depthRef = useRef(0);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    depthRef.current += 1;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      depthRef.current = 0;
      setDragOver(false);
      if (!context || (!context.projectId && !context.sessionId)) {
        setIsError(true);
        setMessage("请先选择一个项目或会话再拖入数据");
        return;
      }
      setBusy(true);
      setMessage(null);
      setIsError(false);
      void (async () => {
        try {
          const files: IngestFileEntry[] = await collectDroppedFiles(event.dataTransfer);
          const summary = await ingestDroppedFiles(context, files);
          setIsError(false);
          setMessage(summary);
          onIngested();
        } catch (err) {
          setIsError(true);
          setMessage((err as Error).message);
        } finally {
          setBusy(false);
        }
      })();
    },
    [context, onIngested]
  );

  return { dragOver, busy, message, isError, handlers: { onDragOver, onDragEnter, onDragLeave, onDrop } };
}
