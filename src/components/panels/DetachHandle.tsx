import { useDetachHandle } from "@giamat90/mps-core/hooks";
import { detachPanel } from "../../lib/tauri";
import { useDetachedStore } from "../../stores/detached";
import type { DetachablePanel } from "../../windows/protocol";
import { MoveGrip } from "./SortablePanels";

interface DetachHandleProps {
  panel: DetachablePanel;
}

const markDetached = (panel: DetachablePanel) => useDetachedStore.getState().markDetached(panel);

/**
 * Sits in a corner of a panel: the arrows move the panel within the window (when
 * it is in a SortablePanels), the dots drag it past the edge of the window into
 * a window of its own, and the button pops it out beside the main window.
 */
function DetachHandle({ panel }: DetachHandleProps) {
  const { dragging, popOut, gripProps } = useDetachHandle({ panel, detach: detachPanel, onDetached: markDetached });

  return (
    <div className={`detach-handle${dragging ? " detach-handle--dragging" : ""}`}>
      {dragging && <span className="detach-handle__hint">Release outside the window to detach</span>}
      <MoveGrip />
      <button
        type="button"
        className="detach-handle__grip"
        title="Drag out of the window to detach this panel"
        aria-label="Drag out of the window to detach this panel"
        {...gripProps}
      >
        &#8942;&#8942;
      </button>
      <button
        type="button"
        className="detach-handle__pop"
        title="Open this panel in its own window"
        aria-label="Open this panel in its own window"
        onClick={popOut}
      >
        &#10530;
      </button>
    </div>
  );
}

export default DetachHandle;
