import { create } from "zustand";

interface ChordSelectionState {
  /** Index of the chord being corrected, in the song's chord list; null when none. */
  index: number | null;
  select: (index: number) => void;
  /** Picks the chord, or puts it away when it is already the one being corrected. */
  toggle: (index: number) => void;
  clear: () => void;
}

export const useChordSelection = create<ChordSelectionState>((set, get) => ({
  index: null,
  select: (index) => set({ index }),
  toggle: (index) => set({ index: get().index === index ? null : index }),
  clear: () => set({ index: null }),
}));
