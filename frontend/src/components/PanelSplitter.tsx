import type { KeyboardEvent, PointerEvent } from "react";
import type { ResizablePanel } from "../hooks/useResizablePanels";

interface Props {
  panel: ResizablePanel;
  onResizeStart: (panel: ResizablePanel, startX: number) => void;
  onAdjust: (panel: ResizablePanel, delta: number) => void;
}

export default function PanelSplitter({ panel, onResizeStart, onAdjust }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onAdjust(panel, -8);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onAdjust(panel, 8);
    } else if (event.key === "Home") {
      event.preventDefault();
      onAdjust(panel, -120);
    } else if (event.key === "End") {
      event.preventDefault();
      onAdjust(panel, 120);
    }
  };

  return (
    <div
      className={`panel-splitter panel-splitter-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={panel === "sidebar" ? "调整会话列表宽度" : "调整对话区宽度"}
      tabIndex={0}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        onResizeStart(panel, event.clientX);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
