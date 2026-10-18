import { useDockHandle } from "@giamat90/mps-core/hooks";
import { cursorOverMain, dockPanel } from "../../lib/tauri";

/**
 * In a detached window: carry the grip over the main window and let go to put
 * the panel back. Moving the window by its title bar never docks it, so a panel
 * can still sit on top of the main window.
 */
function DockHandle() {
  const { dragging, over, gripProps } = useDockHandle({ isOverMain: cursorOverMain, dock: dockPanel });

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
        {...gripProps}
      >
        &#8942;&#8942;
      </button>
    </div>
  );
}

export default DockHandle;
