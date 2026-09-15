import { useCallback, useEffect, useState } from "react";

export type ResizablePanel = "sidebar" | "chat";

export interface PanelSizes {
  sidebar: number;
  /**
   * 对话区宽度（固定档）。
   * 地图列是网格里的弹性轨道：用户拖动只改侧栏/对话区，窗口缩放时增减量全部由地图列吸收。
   */
  chat: number;
}

const STORAGE_KEY = "giser-panel-sizes";
/** 地图列默认宽度：仅用于首次运行推算对话区宽度，之后不再固定地图列 */
const MAP_DEFAULT = 380;
const DEFAULTS: PanelSizes = { sidebar: 260, chat: 780 };
const LIMITS = {
  sidebar: { min: 216, max: 420 },
  chat: { min: 360, max: 1600 },
  /** 地图列允许压缩到的下限（窗口过窄时先压它） */
  mapMin: 300,
  splitter: 6,
};

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** 读取本地记忆的宽度（旧数据里的 map 字段忽略：地图列已改为弹性轨道） */
function readSizes(): Partial<PanelSizes> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return {};
    const stored: Partial<PanelSizes> = {};
    if (Number.isFinite(raw.sidebar)) stored.sidebar = Number(raw.sidebar);
    if (Number.isFinite(raw.chat)) stored.chat = Number(raw.chat);
    return stored;
  } catch {
    return {};
  }
}

/** 窗口过窄时按 地图 → 对话区 → 侧栏 的顺序让位（侧栏与对话区优先保持不变） */
function fitToWindow(sizes: PanelSizes): PanelSizes {
  const available = window.innerWidth - LIMITS.splitter * 2;
  let { sidebar, chat } = sizes;
  const overflow = () => sidebar + chat + LIMITS.mapMin - available;
  if (overflow() > 0) chat = Math.max(LIMITS.chat.min, chat - overflow());
  if (overflow() > 0) sidebar = Math.max(LIMITS.sidebar.min, sidebar - overflow());
  return { sidebar: Math.round(sidebar), chat: Math.round(chat) };
}

function initialSizes(): PanelSizes {
  const stored = readSizes();
  const sidebar = clamp(stored.sidebar ?? DEFAULTS.sidebar, LIMITS.sidebar.min, LIMITS.sidebar.max);
  const derivedChat = window.innerWidth - sidebar - MAP_DEFAULT - LIMITS.splitter * 2;
  const chat = clamp(
    stored.chat ?? Math.max(LIMITS.chat.min, derivedChat),
    LIMITS.chat.min,
    LIMITS.chat.max
  );
  return fitToWindow({ sidebar, chat });
}

/**
 * 三栏宽度状态。
 *
 * - 左侧分隔条：调整会话列表宽度，地图列吸收变化。
 * - 右侧分隔条：调整对话区宽度（`delta > 0` 表示分隔条右移 = 对话区变窄、地图变宽）。
 * - 窗口缩放：侧栏与对话区保持不变，地图列吸收增减；窗口过窄时按上面的优先级让位。
 * 任何操作都不改变窗口总宽度。
 */
export function useResizablePanels(mapOpen: boolean) {
  const [sizes, setSizes] = useState<PanelSizes>(initialSizes);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  }, [sizes]);

  useEffect(() => {
    const onResize = () => setSizes((previous) => fitToWindow(previous));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 按分隔条位移重算尺寸（delta > 0 为分隔条右移） */
  const resize = useCallback(
    (panel: ResizablePanel, delta: number, from: PanelSizes): PanelSizes => {
      const available = window.innerWidth - LIMITS.splitter * 2;
      if (panel === "sidebar") {
        const reserved = (mapOpen ? from.chat + LIMITS.mapMin : LIMITS.chat.min);
        const max = Math.max(LIMITS.sidebar.min, Math.min(LIMITS.sidebar.max, available - reserved));
        return { ...from, sidebar: clamp(from.sidebar + delta, LIMITS.sidebar.min, max) };
      }
      const max = Math.max(LIMITS.chat.min, available - from.sidebar - LIMITS.mapMin);
      return { ...from, chat: clamp(from.chat - delta, LIMITS.chat.min, Math.min(LIMITS.chat.max, max)) };
    },
    [mapOpen]
  );

  const adjust = useCallback(
    (panel: ResizablePanel, delta: number) => {
      setSizes((previous) => resize(panel, delta, previous));
    },
    [resize]
  );

  const startResize = useCallback(
    (panel: ResizablePanel, startX: number) => {
      const from = sizes;
      const body = document.body;
      const previousCursor = body.style.cursor;
      const previousSelect = body.style.userSelect;
      body.style.cursor = "col-resize";
      body.style.userSelect = "none";

      const onMove = (event: PointerEvent) => {
        setSizes((previous) => resize(panel, event.clientX - startX, { ...previous, ...from }));
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        body.style.cursor = previousCursor;
        body.style.userSelect = previousSelect;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop, { once: true });
    },
    [resize, sizes]
  );

  return { sizes, startResize, adjust };
}
