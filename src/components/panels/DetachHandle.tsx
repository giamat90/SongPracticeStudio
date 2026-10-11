import { useState } from "react";
import { detachPanel } from "../../lib/tauri";
import { useDetachedStore } from "../../stores/detached";
import { decideDrop } from "@giamat90/mps-core/windows";
import type { DetachablePanel } from "../../windows/protocol";

interface DetachHandleProps {
  panel: DetachablePanel;
}

/**
 * Sits in a corner of a panel: drag it past the edge of the window to move the
 * panel into a window of its own, or press the button to pop it out beside the
 * main window.
 */
function DetachHandle({ panel }: DetachHandleProps) {
  const [dragging, setDragging] = useState(false);

  const detach = async (x?: number, y?: number) => {
    try {
      await detachPanel(panel, x, y);
      useDetachedStore.getState().markDetached(panel);
    } catch (e) {
      console.error(`[detach] could not open a window for ${panel}:`, e);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    const drop = decideDrop({
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
    if (drop.detach) void detach(drop.x, drop.y);
  };

  return (
    <div className={`detach-handle${dragging ? " detach-handle--dragging" : ""}`}>
      {dragging && <span className="detach-handle__hint">Release outside the window to detach</span>}
      <button
        type="button"
        className="detach-handle__grip"
        title="Drag out of the window to detach this panel"
        aria-label="Drag out of the window to detach this panel"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(false)}
      >
        &#8942;&#8942;
      </button>
      <button
        type="button"
        className="detach-handle__pop"
        title="Open this panel in its own window"
        aria-label="Open this panel in its own window"
        onClick={() => void detach()}
      >
        &#10530;
      </button>
    </div>
  );
}

export default DetachHandle;
