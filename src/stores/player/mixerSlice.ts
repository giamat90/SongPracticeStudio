import { pitchShiftSong } from "../../lib/tauri";
import type { Song } from "../../lib/types";
import { applyEffectiveVolumes } from "./audioMix";
import { getEngine } from "./singletons";
import type { Getter, MixerSlice, Slice } from "./types";

export function mixerReset(stemVolumes: Record<string, number>) {
  return { stemVolumes, mutedStems: {}, soloedStem: null, transpose: 0, isTransposing: false };
}

function pushVolumes(get: Getter): void {
  const { song, stemVolumes, mutedStems, soloedStem, takeVolume } = get();
  if (song) applyEffectiveVolumes(getEngine(), song.stems, stemVolumes, mutedStems, soloedStem, takeVolume);
}

async function transposedPaths(song: Song, semitones: number): Promise<Record<string, string>> {
  if (semitones === 0) {
    const dir = song.directory.replace(/\\/g, "/");
    return Object.fromEntries(song.stems.map((name) => [name, `${dir}/${name}.wav`]));
  }
  return (await pitchShiftSong(song.directory, song.stems, semitones)).stems;
}

export const createMixerSlice: Slice<MixerSlice> = (set, get) => ({
  stemVolumes: {},
  mutedStems: {},
  soloedStem: null,
  transpose: 0,
  isTransposing: false,

  setStemVolume: (name, volume) => {
    set({ stemVolumes: { ...get().stemVolumes, [name]: volume } });
    pushVolumes(get);
  },

  toggleMute: (name) => {
    const { mutedStems } = get();
    set({ mutedStems: { ...mutedStems, [name]: !mutedStems[name] } });
    pushVolumes(get);
  },

  toggleSolo: (name) => {
    set({ soloedStem: get().soloedStem === name ? null : name });
    pushVolumes(get);
  },

  setTranspose: async (semitones) => {
    const { song, transpose } = get();
    if (!song || semitones === transpose) return;

    getEngine().pause();
    set({ isTransposing: true, isPlaying: false });

    try {
      await getEngine().reloadStemsFromPaths(await transposedPaths(song, semitones));
      set({ transpose: semitones, isTransposing: false });
    } catch (e) {
      set({ isTransposing: false });
      throw e;
    }
  },
});
