import { create } from "zustand";

/** A chord being tried on one chord of the song: heard and drawn over the spectrum, not yet the chord. */
export interface Candidate {
  /** Index, in the song's chord list, of the chord it is tried on. */
  index: number;
  chord: string;
}

interface ChordSelectionState {
  /** Index of the chord being corrected, in the song's chord list; null when none. */
  index: number | null;
  /** The chord being tried on a chord, shared by the editor's lists and the spectrum so both show the same one. */
  candidate: Candidate | null;
  select: (index: number) => void;
  /** Picks the chord, or puts it away when it is already the one being corrected. */
  toggle: (index: number) => void;
  clear: () => void;
  /** Tries `chord` on chord `index`; null puts the trial away. */
  setCandidate: (index: number, chord: string | null) => void;
}

export const useChordSelection = create<ChordSelectionState>((set, get) => ({
  index: null,
  candidate: null,
  select: (index) => set({ index, candidate: null }),
  toggle: (index) => set({ index: get().index === index ? null : index, candidate: null }),
  clear: () => set({ index: null, candidate: null }),
  setCandidate: (index, chord) => set({ candidate: chord === null ? null : { index, chord } }),
}));
