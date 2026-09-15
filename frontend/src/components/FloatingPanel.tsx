import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  role: "menu" | "listbox";
  label: string;
  id?: string;
  minWidth?: number;
  align?: "left" | "right";
  placement?: "top" | "bottom";
  onClose: () => void;
}

/** 挂在根层，避免被输入区、侧栏等滚动容器裁剪。 */
export default function FloatingPanel({
  anchorRef, children, className = "", role, label, id,
  minWidth = 180, align = "left", placement = "bottom", onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const updatePosition = () => {
      const bounds = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.min(Math.max(bounds.width, minWidth), window.innerWidth - margin * 2);
      const above = Math.max(0, bounds.top - margin - gap);
      const below = Math.max(0, window.innerHeight - bounds.bottom - margin - gap);
      const needed = Math.min(panel.scrollHeight, 360);
      const useTop = placement === "top"
        ? above >= needed || above > below
        : below < needed && above > below;
      const maxHeight = Math.max(40, Math.min(360, useTop ? above : below));
      const height = Math.min(panel.scrollHeight, maxHeight);
      const left = Math.max(margin, Math.min(
        align === "right" ? bounds.right - width : bounds.left,
        window.innerWidth - margin - width,
      ));
      const top = Math.max(margin, Math.min(
        useTop ? bounds.top - gap - height : bounds.bottom + gap,
        window.innerHeight - margin - height,
      ));
      setPosition((previous) => previous?.top === top && previous.left === left && previous.width === width && previous.maxHeight === maxHeight
        ? previous : { top, left, width, maxHeight });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    observer.observe(panel);
    const onScroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) updatePosition();
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchorRef, minWidth, align, placement]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    if (!positioned) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLButtonElement>("button[aria-selected='true']:not(:disabled), button[aria-checked='true']:not(:disabled)")
      ?? panel?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anchorRef, onClose, positioned]);

  return createPortal(
    <div
      id={id}
      ref={panelRef}
      className={`floating-panel ${className}`}
      role={role}
      aria-label={label}
      style={{ ...position, position: "fixed", visibility: position ? "visible" : "hidden", overflowY: "auto" }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
        if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = buttons.length - 1;
        if (next !== undefined && buttons.length) {
          event.preventDefault();
          event.stopPropagation();
          buttons[next].focus();
        }
        if (event.key === "Escape" || event.key === "Tab") {
          event.stopPropagation();
          if (event.key === "Escape") event.preventDefault();
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
