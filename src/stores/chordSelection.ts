import { create } from "zustand";

/** Where the chord was picked: the editor opens there, so only one editor is ever on screen. */
export type ChordSurface = "row" | "roll";

interface ChordSelectionState {
  /** Index of the chord being corrected, in the song's chord list; null when none. */
  index: number | null;
  surface: ChordSurface | null;
  select: (index: number, surface: ChordSurface) => void;
  /** Picks the chord, or puts it away when it is already the one being corrected where it was clicked. */
  toggle: (index: number, surface: ChordSurface) => void;
  clear: () => void;
}

export const useChordSelection = create<ChordSelectionState>((set, get) => ({
  index: null,
  surface: null,
  select: (index, surface) => set({ index, surface }),
  toggle: (index, surface) => {
    const { index: now, surface: where } = get();
    if (now === index && where === surface) set({ index: null, surface: null });
    else set({ index, surface });
  },
  clear: () => set({ index: null, surface: null }),
}));
