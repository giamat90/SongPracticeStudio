import { useMemo, useState } from "react";
import { createDockGesture } from "@giamat90/mps-core/windows";
import { cursorOverMain, dockPanel } from "../../lib/tauri";

/**
 * In a detached window: carry the grip over the main window and let go to put
 * the panel back. Moving the window by its title bar never docks it, so a panel
 * can still sit on top of the main window.
 */
function DockHandle() {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);

  const gesture = useMemo(
    () => createDockGesture({ isOverMain: cursorOverMain, dock: dockPanel, onHover: setOver, now: () => performance.now() }),
    [],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    gesture.start();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    void gesture.end();
  };

  const onPointerCancel = () => {
    setDragging(false);
    gesture.cancel();
  };

  return (
    <div className={`dock-handle${dragging ? " dock-handle--dragging" : ""}${over ? " dock-handle--over" : ""}`}>
      {dragging && (
        <span className="dock-handle__hint">{over ? "Release to dock" : "Carry onto the main window to dock"}</span>
      )}
      <button
        type="button"
        className="dock-handle__grip"
        title="Drag onto the main window to dock this panel"
        aria-label="Drag onto the main window to dock this panel"
        onPointerDown={onPointerDown}
        onPointerMove={() => gesture.move()}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        &#8942;&#8942;
      </button>
    </div>
  );
}

export default DockHandle;
