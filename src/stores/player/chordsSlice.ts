import { clampCapo, persistChordDetail, readChordDetail, writeCapo } from "./prefs";
import type { ChordsSlice, Slice } from "./types";

export const createChordsSlice: Slice<ChordsSlice> = (set, get) => ({
  capo: 0,
  setCapo: (fret) => {
    const clamped = clampCapo(fret);
    set({ capo: clamped });
    const song = get().song;
    if (song) writeCapo(song.id, clamped);
  },

  chordDetail: readChordDetail(),
  setChordDetail: (detail) => {
    set({ chordDetail: detail });
    persistChordDetail(detail);
  },

  chordsRevision: 0,
  bumpChordsRevision: () => set((s) => ({ chordsRevision: s.chordsRevision + 1 })),
});
