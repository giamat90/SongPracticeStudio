import { useEffect, useId, useRef, useState } from "react";
import type { PanelDef, PanelStore } from "@giamat90/mps-core/panels";

interface PanelMenuListProps {
  panels: readonly PanelDef[];
  visible: Readonly<Record<string, boolean>>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onReset: () => void;
}

export function PanelMenuList({ panels, visible, onToggle, onShowAll, onHideAll, onReset }: PanelMenuListProps) {
  return (
    <div className="panel-menu__list" role="group" aria-label="Visible panels">
      {panels.map((p) => (
        <label key={p.id} className="panel-menu__item">
          <input type="checkbox" checked={!!visible[p.id]} onChange={() => onToggle(p.id)} />
          <span>{p.label}</span>
        </label>
      ))}
      <div className="panel-menu__actions">
        <button type="button" onClick={onShowAll}>Show all</button>
        <button type="button" onClick={onHideAll}>Hide all</button>
        <button type="button" onClick={onReset}>Reset</button>
      </div>
    </div>
  );
}

interface PanelMenuProps<Id extends string> {
  store: PanelStore<Id>;
  panels: readonly PanelDef<Id>[];
}

function PanelMenu<Id extends string>({ store, panels }: PanelMenuProps<Id>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const visible = store((s) => s.visible);
  const { toggle, showAll, hideAll, reset } = store.getState();
  const shown = panels.filter((p) => visible[p.id]).length;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="panel-menu" ref={root}>
      <button
        type="button"
        className={`panel-menu__button${open ? " panel-menu__button--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        title="Choose which panels to show"
      >
        Panels {shown}/{panels.length}
      </button>
      {open && (
        <div className="panel-menu__popover" id={listId}>
          <PanelMenuList
            panels={panels}
            visible={visible}
            onToggle={(id) => toggle(id as Id)}
            onShowAll={showAll}
            onHideAll={hideAll}
            onReset={reset}
          />
        </div>
      )}
    </div>
  );
}

export default PanelMenu;
