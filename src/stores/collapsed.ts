import { useCollapsiblePanel } from "@giamat90/mps-core/hooks";
import { createCollapseStore } from "@giamat90/mps-core/panels";

// Which panels the user has folded down to their title (`sps_collapsed`). Keyed by
// the panel's own id, so the practice room, the Free Exercise page and a panel in a
// window of its own agree. Separate from `panels.ts`: that decides whether a panel is
// mounted at all, this only whether its body is.
export const useCollapsedPanels = createCollapseStore({ storageKey: "sps_collapsed" });

export const usePanelCollapse = (id: string) => useCollapsiblePanel(useCollapsedPanels, id);
