import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import type { Song, StemName } from "../lib/types";

let engine: AudioEngine | null = null;

export function getEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}

interface PlayerState {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  stemVolumes: Record<string, number>;
  mutedStems: Record<string, boolean>;
  soloedStem: string | null;
  // Punch-in / punch-out region
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
}

interface PlayerActions {
  loadSong: (song: Song, containers: Record<string, HTMLElement>) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  setStemVolume: (name: StemName | string, volume: number) => void;
  toggleMute: (name: string) => void;
  toggleSolo: (name: string) => void;
  cleanup: () => void;
  // Punch region actions
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
}

// Compute and push effective volume for every loaded stem.
function applyEffectiveVolumes(
  eng: AudioEngine,
  stems: readonly string[],
  stemVolumes: Record<string, number>,
  mutedStems: Record<string, boolean>,
  soloedStem: string | null,
) {
  for (const name of stems) {
    let vol = stemVolumes[name] ?? 1.0;
    if (soloedStem !== null) {
      vol = name === soloedStem ? vol : 0;
    } else if (mutedStems[name]) {
      vol = 0;
    }
    eng.setStemVolume(name, vol);
  }
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  stemVolumes: {},
  mutedStems: {},
  soloedStem: null,
  punchIn: null,
  punchOut: null,
  punchLoop: false,

  loadSong: async (song, containers) => {
    const eng = getEngine();
    await eng.load(song.directory, song.stems, containers);
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
      const s = get();
      if (s.punchOut !== null && time >= s.punchOut && s.isPlaying) {
        if (s.punchLoop && s.punchIn !== null) {
          eng.seekTo(s.punchIn);
          set({ currentTime: s.punchIn });
        } else {
          eng.pause();
          const backTo = s.punchIn ?? 0;
          eng.seekTo(backTo);
          set({ isPlaying: false, currentTime: backTo });
        }
      }
    });
    eng.onFinish(() => set({ isPlaying: false }));
    const initialVolumes = Object.fromEntries(song.stems.map((n) => [n, 1.0]));
    set({
      song,
      duration: eng.getDuration(),
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      stemVolumes: initialVolumes,
      mutedStems: {},
      soloedStem: null,
    });
  },

  play: () => {
    const eng = getEngine();
    const { punchIn } = get();
    if (punchIn !== null) {
      eng.seekTo(punchIn);
      set({ currentTime: punchIn });
    }
    eng.play();
    set({ isPlaying: true });
  },

  pause: () => {
    getEngine().pause();
    set({ isPlaying: false });
  },

  togglePlay: () => {
    if (get().isPlaying) get().pause();
    else get().play();
  },

  stop: () => {
    getEngine().stop();
    set({ isPlaying: false, currentTime: 0 });
  },

  seek: (time) => {
    getEngine().seekTo(time);
    set({ currentTime: time });
  },

  setPlaybackRate: (rate) => {
    getEngine().setPlaybackRate(rate);
    set({ playbackRate: rate });
  },

  setStemVolume: (name, volume) => {
    const { mutedStems, soloedStem, stemVolumes, song } = get();
    const newVolumes = { ...stemVolumes, [name]: volume };
    set({ stemVolumes: newVolumes });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, newVolumes, mutedStems, soloedStem);
    }
  },

  toggleMute: (name) => {
    const { mutedStems, soloedStem, stemVolumes, song } = get();
    const newMuted = { ...mutedStems, [name]: !mutedStems[name] };
    set({ mutedStems: newMuted });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, stemVolumes, newMuted, soloedStem);
    }
  },

  toggleSolo: (name) => {
    const { soloedStem, mutedStems, stemVolumes, song } = get();
    const newSolo = soloedStem === name ? null : name;
    set({ soloedStem: newSolo });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, stemVolumes, mutedStems, newSolo);
    }
  },

  cleanup: () => {
    getEngine().destroy();
    set({
      song: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      stemVolumes: {},
      mutedStems: {},
      soloedStem: null,
    });
  },

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set({ punchIn: null, punchOut: null, punchLoop: false }),
  setPunchLoop: (v) => set({ punchLoop: v }),
}));
