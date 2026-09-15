import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** localStorage 键（各分割位置独立记忆） */
  storageKey: string;
  /** 上方/左侧块的默认高度占比 */
  defaultRatio: number;
  /** 两块各自的最小高度（px）：拖动时按容器实际高度换算成占比下限 */
  minFirst: number;
  minSecond: number;
}

/**
 * 容器内「上/下」两块的高度分配（比例制）。
 *
 * 比例制的好处是容器高度变化（窗口缩放、地图面板改宽）时两块自动等比跟随，
 * 不需要额外监听尺寸；拖动时再按容器实际高度把比例钳制在两块的最小高度之间。
 */
export function useVerticalSplit({ storageKey, defaultRatio, minFirst, minSecond }: Options) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : defaultRatio;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(ratio));
  }, [storageKey, ratio]);

  const clampRatio = useCallback(
    (value: number) => {
      const height = containerRef.current?.getBoundingClientRect().height ?? 0;
      if (height <= 0) return Math.min(0.9, Math.max(0.1, value));
      const min = minFirst / height;
      const max = 1 - minSecond / height;
      // 容器本身太矮：按两块最小高度的比例取中点，避免上下限互相打架
      if (min > max) return minFirst / (minFirst + minSecond);
      return Math.min(max, Math.max(min, value));
    },
    [minFirst, minSecond]
  );

  /** 键盘微调：deltaPx > 0 表示分隔条下移（上方变高） */
  const adjust = useCallback(
    (deltaPx: number) => {
      const height = containerRef.current?.getBoundingClientRect().height ?? 0;
      if (height <= 0) return;
      setRatio((previous) => clampRatio(previous + deltaPx / height));
    },
    [clampRatio]
  );

  const startResize = useCallback(
    (startY: number) => {
      const height = containerRef.current?.getBoundingClientRect().height ?? 0;
      if (height <= 0) return;
      const startRatio = ratio;
      const body = document.body;
      const previousCursor = body.style.cursor;
      const previousSelect = body.style.userSelect;
      body.style.cursor = "row-resize";
      body.style.userSelect = "none";
      const onMove = (event: PointerEvent) => {
        setRatio(clampRatio(startRatio + (event.clientY - startY) / height));
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
    [ratio, clampRatio]
  );

  return { ratio, containerRef, startResize, adjust };
}
