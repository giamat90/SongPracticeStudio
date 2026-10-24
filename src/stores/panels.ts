import { createPanelStore } from "@giamat90/mps-core/panels";

// Order is the order of the Panels menu. Everything starts visible: this is
// how the page looked before the menu, and the user hides what they do not need.
// The chord carousel is not one of them: it sits in the top bar and is a card
// (`topbar.ts`, the Cards menu), so it is listed in one place only.
export const ANALYZER_PANELS = [
  { id: "roll", label: "Chord roll", defaultVisible: true },
  { id: "meter", label: "Meter", defaultVisible: true },
  { id: "lyrics", label: "Lyrics", defaultVisible: true },
  { id: "takes", label: "Takes", defaultVisible: true },
] as const;

export type AnalyzerPanelId = (typeof ANALYZER_PANELS)[number]["id"];

export const useAnalyzerPanels = createPanelStore({ storageKey: "sps_panels", panels: ANALYZER_PANELS });
