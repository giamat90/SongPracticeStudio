import type { ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { PanelGripProvider, usePanelGrip, useSortablePanel, useSortablePanels } from "@giamat90/mps-core/hooks/dnd";
import type { PanelStore } from "@giamat90/mps-core/panels";

/**
 * The grip that moves the panel it is in. Renders nothing outside a
 * SortablePanels, so a panel shown in a window of its own has none.
 */
export function MoveGrip() {
  const grip = usePanelGrip();
  if (!grip) return null;
  return (
    <button
      type="button"
      ref={grip.setActivatorNodeRef}
      className={`detach-handle__move${grip.isDragging ? " detach-handle__move--dragging" : ""}`}
      title="Drag to move this panel up or down"
      aria-label="Move this panel"
      {...grip.attributes}
      {...grip.listeners}
    >
      &#8597;
    </button>
  );
}

interface SortablePanelProps {
  id: string;
  className?: string;
  children: ReactNode;
}

function SortablePanel({ id, className, children }: SortablePanelProps) {
  const slot = useSortablePanel(id, className);
  return (
    <PanelGripProvider value={slot.grip}>
      <div ref={slot.setNodeRef} style={slot.style} className={slot.className}>
        {children}
      </div>
    </PanelGripProvider>
  );
}

interface SortablePanelsProps<Id extends string> {
  store: PanelStore<Id>;
  /** The panels on screen, in the order they are drawn. */
  ids: readonly Id[];
  /** Extra class for one panel's slot, so a page keeps the sizing it gave that panel. */
  className?: (id: Id) => string | undefined;
  children: (id: Id) => ReactNode;
}

/**
 * Draws the given panels one under another and lets the user drag each by its
 * grip (or by keyboard) into another place. Renders only the slots, so the
 * parent's layout is unchanged.
 */
function SortablePanels<Id extends string>({ store, ids, className, children }: SortablePanelsProps<Id>) {
  const { dnd, strategy } = useSortablePanels(store);

  return (
    <DndContext {...dnd}>
      <SortableContext items={[...ids]} strategy={strategy}>
        {ids.map((id) => (
          <SortablePanel key={id} id={id} className={className?.(id)}>
            {children(id)}
          </SortablePanel>
        ))}
      </SortableContext>
    </DndContext>
  );
}

export default SortablePanels;
