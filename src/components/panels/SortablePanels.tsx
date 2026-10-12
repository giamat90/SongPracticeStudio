import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PanelStore } from "@giamat90/mps-core/panels";

type Grip = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners" | "setActivatorNodeRef" | "isDragging">;

const GripContext = createContext<Grip | null>(null);

/**
 * The grip that moves the panel it is in. Renders nothing outside a
 * SortablePanels, so a panel shown in a window of its own has none.
 */
export function MoveGrip() {
  const grip = useContext(GripContext);
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

/** Dropping a panel on another puts it in that panel's place; anywhere else leaves the order alone. */
export function applyDrop<Id extends string>(store: PanelStore<Id>, { active, over }: Pick<DragEndEvent, "active" | "over">) {
  if (!over || active.id === over.id) return;
  store.getState().move(active.id as Id, over.id as Id);
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

interface SortablePanelProps {
  id: string;
  className?: string;
  children: ReactNode;
}

function SortablePanel({ id, className, children }: SortablePanelProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const classes = ["sortable-panel", isDragging && "sortable-panel--dragging", className].filter(Boolean).join(" ");
  return (
    <GripContext.Provider value={{ attributes, listeners, setActivatorNodeRef, isDragging }}>
      <div ref={setNodeRef} style={style} className={classes}>
        {children}
      </div>
    </GripContext.Provider>
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
  const panels = store((s) => s.panels);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const label = (id: string | number) => panels.find((p) => p.id === id)?.label ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${label(active.id)} is over ${label(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `${label(active.id)} was moved to the place of ${label(over.id)}.`
        : `${label(active.id)} was dropped where it was.`,
    onDragCancel: ({ active }) => `Moving ${label(active.id)} was cancelled.`,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={(event) => applyDrop(store, event)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: "Press space to pick this panel up, the up and down arrows to move it, space to drop it, escape to cancel.",
        },
      }}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
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
