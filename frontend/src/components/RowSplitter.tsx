import type { KeyboardEvent, PointerEvent } from "react";

interface Props {
  /** 无障碍名称（说明这个分隔条调的是什么） */
  label: string;
  /** 按下时传入初始 Y 坐标（clientY） */
  onResizeStart: (startY: number) => void;
  /** 键盘微调：正值表示分隔条下移（上方变高） */
  onAdjust: (deltaPx: number) => void;
}

/** 水平分隔条（上下分块，如会话列表 / 图层列表、地图画布 / 属性表）。 */
export default function RowSplitter({ label, onResizeStart, onAdjust }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onAdjust(-8);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onAdjust(8);
    } else if (event.key === "Home") {
      event.preventDefault();
      onAdjust(-120);
    } else if (event.key === "End") {
      event.preventDefault();
      onAdjust(120);
    }
  };

  return (
    <div
      className="panel-splitter panel-splitter-horizontal"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        onResizeStart(event.clientY);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
