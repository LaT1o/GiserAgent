import { useCallback, useId, useRef, useState } from "react";
import FloatingPanel from "./FloatingPanel";

export interface RowMenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export default function RowMenu({ label, actions }: { label: string; actions: RowMenuAction[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="row-menu-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        draggable={false}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        ⋯
      </button>
      {open && (
        <FloatingPanel anchorRef={anchorRef} id={menuId} className="row-menu" role="menu" label={label} align="right" onClose={close}>
          {actions.map((action) => (
            <button
              type="button"
              role="menuitem"
              className={`row-menu-item ${action.danger ? "danger" : ""}`}
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                close();
                anchorRef.current?.focus({ preventScroll: true });
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </FloatingPanel>
      )}
    </>
  );
}
