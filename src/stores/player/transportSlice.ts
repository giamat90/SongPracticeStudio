import type { AudioEngine } from "../../audio/engine";
import { clampCapo, readCapos } from "./prefs";
import { disposeRecorder, getEngine } from "./singletons";
import { meterReset } from "./meterSlice";
import { mixerReset } from "./mixerSlice";
import { punchReset } from "./timelineSlice";
import { recordingReset } from "./recordingSlice";
import { takesReset } from "./takesSlice";
import type { Getter, Setter, Slice, TransportSlice } from "./types";

// Playback reached the end of the punch region: stop the recording, loop, or rewind.
function handlePunchOut(eng: AudioEngine, set: Setter, get: Getter): void {
  const s = get();
  if (s.isRecording) {
    s.stopRecording().catch((e: unknown) =>
      console.error("[player] punch-out auto-stop failed:", e)
    );
  } else if (s.isPlaying) {
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
}

function attachEngineHandlers(eng: AudioEngine, set: Setter, get: Getter): void {
  eng.onScrollChange((minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }));
  eng.onTimeUpdate((time) => {
    set({ currentTime: time, isPlaying: eng.isPlaying });
    const { punchOut } = get();
    if (punchOut !== null && time >= punchOut) handlePunchOut(eng, set, get);
  });
  eng.onFinish(() => {
    set({ isPlaying: false });
    if (get().isRecording) {
      get().stopRecording().catch((e: unknown) =>
        console.error("[player] auto-stop recording failed:", e)
      );
    }
  });
}

export const createTransportSlice: Slice<TransportSlice> = (set, get) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,

  loadSong: async (song, containers) => {
    const eng = getEngine();
    if (!(await eng.load(song.directory, song.stems, containers))) return;
    attachEngineHandlers(eng, set, get);
    const initialVolumes = Object.fromEntries(song.stems.map((n) => [n, 1.0]));
    const baselinePxPerSec = eng.getMinPxPerSec();
    eng.zoomAll(baselinePxPerSec, 0);
    set({
      song,
      duration: eng.getDuration(),
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      ...mixerReset(initialVolumes),
      ...punchReset(),
      ...takesReset(),
      ...recordingReset(),
      ...meterReset(),
      minPxPerSec: baselinePxPerSec,
      scrollTime: 0,
      metronomeOffset: Math.max(0, Math.min(eng.getDuration(), song.metronomeOffset ?? 0)),
      capo: clampCapo(Number(readCapos()[song.id]) || 0),
    });
    get().fetchTakes();
    get().loadMeter(song.id).catch((e: unknown) => console.error("[player] loading the bars failed:", e));
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

  skipToStart: () => get().seek(0),

  skipToEnd: () => {
    // Landing exactly on `duration` would push the master WaveSurfer stem's
    // underlying <audio> element into "ended", firing the engine's "finish"
    // handler (which reports playback as complete) even though this is a
    // seek, not actual end-of-song playback.
    const { duration } = get();
    get().seek(Math.max(0, duration - 0.05));
  },

  setPlaybackRate: (rate) => {
    getEngine().setPlaybackRate(rate);
    set({ playbackRate: rate });
  },

  cleanup: () => {
    getEngine().destroy();
    disposeRecorder();
    set({
      song: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      ...mixerReset({}),
      ...recordingReset(),
      ...takesReset(),
      ...meterReset(),
    });
  },
});
