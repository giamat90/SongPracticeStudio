import { createPanelStore } from "@giamat90/mps-core/panels";

// The cards of the pinned top bar, in the order they are drawn by default. The bar is one
// list that wraps with the window: there are no fixed lines, so any card can sit anywhere.
// The user orders and hides them (`sps_topbar`, the Cards menu), apart from the panels under
// the stems (`sps_panels`, the Panels menu): a different store, a different menu, a different
// drag, a different grip. The chord carousel is a card, and only a card.
export const TOPBAR_CARDS = [
  { id: "transport", label: "Transport", defaultVisible: true },
  { id: "loop", label: "Loop", defaultVisible: true },
  { id: "tempo", label: "Tempo", defaultVisible: true },
  { id: "devices", label: "Input and output", defaultVisible: true },
  { id: "transpose", label: "Transpose and capo", defaultVisible: true },
  { id: "chords", label: "Chords", defaultVisible: true },
] as const;

export type TopbarCardId = (typeof TOPBAR_CARDS)[number]["id"];

/** The words of the Cards menu in the header (the Panels menu's own are in `PanelMenu.tsx`). */
export const TOPBAR_MENU_LABELS = {
  button: "Cards",
  title: "Choose which cards of the top bar to show",
  group: "Visible cards",
  hint: "Drag the ⋮⋮ grip on a card to move it.",
  resetTitle: "Show every card in the usual order",
} as const;

export const useTopbarOrder = createPanelStore({ storageKey: "sps_topbar", panels: TOPBAR_CARDS });
