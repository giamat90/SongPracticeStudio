import type { ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useSortableBar, useSortableBarCard } from "@giamat90/mps-core/hooks/dnd";
import { TOPBAR_CARDS, useTopbarOrder, type TopbarCardId } from "../../stores/topbar";

const labelOf = (id: string) => TOPBAR_CARDS.find((c) => c.id === id)?.label ?? id;

function TopbarCard({ id, children }: { id: TopbarCardId; children: ReactNode }) {
  const slot = useSortableBarCard(id);
  const label = labelOf(id);
  return (
    <div
      ref={slot.setNodeRef}
      style={slot.style}
      className={`topbar-section${slot.isDragging ? " topbar-section--dragging" : ""}`}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        ref={slot.grip.setActivatorNodeRef}
        className="topbar-grip"
        title="Drag to move this card anywhere in this bar (double-click to put the cards back in their usual order)"
        aria-label={`Move the ${label} card`}
        onDoubleClick={() => useTopbarOrder.getState().resetOrder()}
        {...slot.grip.attributes}
        {...slot.grip.listeners}
      >
        {"⋮⋮"}
      </button>
      {children}
    </div>
  );
}

interface SortableTopbarProps {
  /** The cards, in the order the user chose; the bar wraps them onto as many lines as the window needs. */
  ids: readonly TopbarCardId[];
  children: (id: TopbarCardId) => ReactNode;
}

/**
 * The top bar: its cards side by side, wrapping with the window, each with a grip that moves it anywhere in
 * the bar (or the arrow keys, once the grip has focus). The drag is the shared `useSortableBar`, with a
 * context of its own, so it never mixes with the drag of the panels under the stems.
 */
export default function SortableTopbar({ ids, children }: SortableTopbarProps) {
  const { dnd, strategy } = useSortableBar(useTopbarOrder);
  // A card with nothing to show (the chords of a song without chords) is not drawn, grip and all.
  const cards = ids.flatMap((id) => {
    const content = children(id);
    return content === null || content === undefined || content === false ? [] : [{ id, content }];
  });

  return (
    <DndContext {...dnd}>
      <SortableContext items={cards.map((c) => c.id)} strategy={strategy}>
        <div className="analyzer-page__topbar">
          {cards.map(({ id, content }) => (
            <TopbarCard key={id} id={id}>{content}</TopbarCard>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
