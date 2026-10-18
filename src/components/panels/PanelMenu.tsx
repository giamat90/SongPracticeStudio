import { Fragment } from "react";
import { usePanelMenu, type PanelMenuItem, type PanelMenuListProps, type UsePanelMenuOptions } from "@giamat90/mps-core/hooks";
import { useDetachedStore } from "../../stores/detached";

export type { PanelMenuItem };

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

const useDetached = () => useDetachedStore((s) => s.detached);

function PanelMenu<Id extends string, FixedId extends string = never>(
  props: Omit<UsePanelMenuOptions<Id, FixedId>, "useDetached">,
) {
  const menu = usePanelMenu<Id, FixedId>({ ...props, useDetached });

  return (
    <div className="panel-menu" ref={menu.rootRef}>
      <button
        type="button"
        className={`panel-menu__button${menu.open ? " panel-menu__button--active" : ""}`}
        onClick={menu.toggle}
        aria-expanded={menu.open}
        aria-controls={menu.listId}
        title="Choose which panels to show"
      >
        Panels {menu.shown}/{menu.total}
      </button>
      {menu.open && (
        <div className="panel-menu__popover" id={menu.listId}>
          <PanelMenuList {...menu.list} />
        </div>
      )}
    </div>
  );
}

export default PanelMenu;
