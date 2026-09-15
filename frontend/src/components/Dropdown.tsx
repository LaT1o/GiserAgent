import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import FloatingPanel from "./FloatingPanel";

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface DropdownGroup {
  label?: string;
  options: DropdownOption[];
}

interface Props {
  groups: DropdownGroup[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  icon?: ReactNode;
  align?: "left" | "right";
  minWidth?: number;
}

export default function Dropdown({
  groups, value, onChange, placeholder, disabled, title,
  className = "", icon, align = "left", minWidth,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  const current = groups.flatMap((group) => group.options).find((option) => option.value === value);
  const selectable = groups.some((group) => group.options.some((option) => !option.disabled));

  return (
    <div className={`dd-root ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`dd-trigger ${disabled ? "disabled" : ""} ${open ? "open" : ""}`}
        title={title}
        aria-label={title ?? placeholder ?? "选择选项"}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? menuId : undefined}
        disabled={disabled || !selectable}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        <span className="dd-trigger-label">{current?.label ?? placeholder ?? "—"}</span>
        {current?.hint && <span className="dd-trigger-hint">{current.hint}</span>}
        <span className="dd-caret" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && !disabled && (
        <FloatingPanel
          anchorRef={triggerRef}
          className="dd-pop"
          id={menuId}
          label={title ?? placeholder ?? "可选项"}
          role="listbox"
          minWidth={minWidth}
          align={align}
          placement="top"
          onClose={close}
        >
          {groups.map((group, index) => (
            <div key={group.label ?? index} className="dd-group" role="group" aria-label={group.label}>
              {group.label && <div className="dd-group-label">{group.label}</div>}
              {group.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`dd-option ${option.value === value ? "selected" : ""}`}
                  disabled={option.disabled}
                  onClick={() => {
                    close();
                    triggerRef.current?.focus({ preventScroll: true });
                    if (option.value !== value) onChange(option.value);
                  }}
                >
                  <span className="dd-option-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
                  <span className="dd-option-label">{option.label}</span>
                  {option.hint && <span className="dd-option-hint">{option.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </FloatingPanel>
      )}
    </div>
  );
}
