import { Fragment, useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import type { PanelDef, PanelStore } from "@giamat90/mps-core/panels";
import { useDetachedStore } from "../../stores/detached";

type VisibleStore = (select: (s: { visible: Record<string, boolean> }) => Record<string, boolean>) => Record<string, boolean>;

// Stands in when a menu has no fixed areas, so the store hook below is always called.
const NO_AREAS = create<{ visible: Record<string, boolean> }>(() => ({ visible: {} }));

/** An area that is hidden by collapsing it, with the tracks the user can also hide one by one. */
export interface PanelMenuItem {
  id: string;
  label: string;
  parts?: readonly { id: string; label: string }[];
}

interface FixedListProps {
  items: readonly PanelMenuItem[];
  visible: Readonly<Record<string, boolean>>;
  /** A short note on a track, e.g. why a hidden one is silent. */
  tags?: Readonly<Partial<Record<string, string>>>;
  onToggle: (id: string) => void;
}

interface PanelMenuListProps {
  panels: readonly PanelDef[];
  visible: Readonly<Record<string, boolean>>;
  /** Panels that are in a window of their own. */
  detached?: Readonly<Partial<Record<string, boolean>>>;
  /** Areas listed above the panels that cannot be moved. */
  fixed?: FixedListProps;
  /** Whether the panels can be dragged: the hint about the grip is only true then. */
  movable?: boolean;
  onToggle: (id: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onReset: () => void;
}

export function PanelMenuList({
  panels, visible, detached, fixed, movable = true, onToggle, onShowAll, onHideAll, onReset,
}: PanelMenuListProps) {
  return (
    <div className="panel-menu__list" role="group" aria-label="Visible panels">
      {fixed?.items.map((item) => (
        <Fragment key={item.id}>
          <label className="panel-menu__item">
            <input type="checkbox" checked={!!fixed.visible[item.id]} onChange={() => fixed.onToggle(item.id)} />
            <span>{item.label}</span>
          </label>
          {item.parts && (
            <div className="panel-menu__parts" role="group" aria-label={`${item.label}: tracks`}>
              {item.parts.map((part) => (
                <label key={part.id} className="panel-menu__item panel-menu__item--part">
                  <input
                    type="checkbox"
                    checked={!!fixed.visible[part.id]}
                    disabled={!fixed.visible[item.id]}
                    onChange={() => fixed.onToggle(part.id)}
                  />
                  <span>{part.label}</span>
                  {fixed.tags?.[part.id] && <span className="panel-menu__tag">{fixed.tags[part.id]}</span>}
                </label>
              ))}
            </div>
          )}
        </Fragment>
      ))}
      {panels.map((p) => (
        <label key={p.id} className="panel-menu__item">
          <input type="checkbox" checked={!!visible[p.id]} onChange={() => onToggle(p.id)} />
          <span>{p.label}</span>
          {detached?.[p.id] && <span className="panel-menu__tag">own window</span>}
        </label>
      ))}
      {movable && <p className="panel-menu__hint">Drag the &#8597; grip on a panel to move it.</p>}
      <div className="panel-menu__actions">
        <button type="button" onClick={onShowAll}>Show all</button>
        <button type="button" onClick={onHideAll}>Hide all</button>
        <button type="button" onClick={onReset} title="Show the default panels in the default order">Reset</button>
      </div>
    </div>
  );
}

interface PanelMenuProps<Id extends string, FixedId extends string> {
  store: PanelStore<Id>;
  panels: readonly PanelDef<Id>[];
  /** Areas that are collapsed, never unmounted, when hidden. They have a store of their own and are listed first. */
  fixed?: {
    store: PanelStore<FixedId>;
    items: readonly PanelMenuItem[];
    tags?: Readonly<Partial<Record<string, string>>>;
  };
  movable?: boolean;
}

function PanelMenu<Id extends string, FixedId extends string = never>({
  store, panels, fixed, movable,
}: PanelMenuProps<Id, FixedId>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const visible = store((s) => s.visible);
  const order = store((s) => s.order);
  const detached = useDetachedStore((s) => s.detached);
  const { toggle, showAll, hideAll, reset } = store.getState();
  const fixedVisible = ((fixed?.store ?? NO_AREAS) as unknown as VisibleStore)((s) => s.visible);
  const fixedItems = fixed?.items ?? [];
  const shown = panels.filter((p) => visible[p.id]).length + fixedItems.filter((i) => fixedVisible[i.id]).length;
  const total = panels.length + fixedItems.length;
  const ordered = [...panels].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

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
        Panels {shown}/{total}
      </button>
      {open && (
        <div className="panel-menu__popover" id={listId}>
          <PanelMenuList
            panels={ordered}
            visible={visible}
            detached={detached}
            movable={movable}
            fixed={
              fixed && {
                items: fixed.items,
                visible: fixedVisible,
                tags: fixed.tags,
                onToggle: (id) => fixed.store.getState().toggle(id as FixedId),
              }
            }
            onToggle={(id) => toggle(id as Id)}
            onShowAll={() => {
              showAll();
              fixed?.store.getState().showAll();
            }}
            onHideAll={() => {
              hideAll();
              // Only the areas go: the user's choice of tracks inside them comes back with them.
              for (const item of fixedItems) fixed?.store.getState().setVisible(item.id as FixedId, false);
            }}
            onReset={() => {
              reset();
              fixed?.store.getState().reset();
            }}
          />
        </div>
      )}
    </div>
  );
}

export default PanelMenu;
