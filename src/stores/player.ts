import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import { VocalRecorder } from "@giamat90/mps-core/recorder";
import type { NamedLoop, Song, StemName, Take } from "../lib/types";
import { isChordDetail, type ChordDetail } from "../lib/chordNames";
import { saveTake, listTakes, deleteTakeApi, renameTakeApi, setTakeManualOffsetApi, setMetronomeOffsetApi, setSongLoopsApi, pitchShiftSong } from "../lib/tauri";
import { addLoop, removeLoop, renameLoop as renameLoopIn } from "@giamat90/mps-core/loops";
import {
  audibleTakes,
  hideTake,
  reconcileTakes,
  showTake,
  toggleTake,
  type TakePlayback,
  type TakeSelection,
} from "@giamat90/mps-core/takes";
import { metronome } from "@giamat90/mps-core/metronome";
import { countInDurationSeconds } from "@giamat90/mps-core/metronomeSync";

let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;
// Captured when recording starts so stopRecording can pass it to saveTake
let recordingStartPos = 0;
// Round-trip latency (output + input) measured at rec.start(); applied in stopRecording.
let _recordingLatencyS = 0;
// Takes shorter than this carry too little accumulated drift to be worth logging.
const DRIFT_CHECK_MIN_TAKE_S = 90;
// Count-in scheduling handles — module-level so cancelCountIn (a separate
// store action) can reach across and abort the setTimeout/interval that
// startRecording's in-flight promise is awaiting.
let _countInTimeoutId: number | null = null;
let _countInIntervalId: number | null = null;
let _countInResolve: ((completed: boolean) => void) | null = null;

export interface CalibrationEntry {
  offset: number; // ms
  // Set when a device-change event removed a device this calibration depends on.
  // Stale entries are kept (never deleted) but skipped at recording time.
  stale?: boolean;
  // Median absolute deviation of the clap measurements; absent for manual/legacy entries.
  madMs?: number;
  // Output device active during calibration. Unused here — SPS's calibration plays
  // through the default output — but kept schema-compatible with VPS.
  outputDeviceId?: string;
}

let _deviceWatcherInit = false;
let _knownDeviceIds: Set<string> | null = null;

export function getEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}

function getRecorder(): VocalRecorder {
  if (!recorder) recorder = new VocalRecorder();
  return recorder;
}

function _loadOffsets(): Record<string, CalibrationEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem("songpracticestudio_recording_offsets") ?? "{}") as Record<string, unknown>;
    const offsets: Record<string, CalibrationEntry> = {};
    for (const [deviceId, value] of Object.entries(raw)) {
      // Legacy schema stored a plain number per device.
      if (typeof value === "number") {
        offsets[deviceId] = { offset: value };
      } else if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as CalibrationEntry).offset === "number"
      ) {
        offsets[deviceId] = value as CalibrationEntry;
      } else {
        console.warn("[settings] Dropping malformed recording offset entry:", deviceId, value);
      }
    }
    return offsets;
  } catch (e) {
    console.warn("[settings] Could not load recording offsets:", e);
    return {};
  }
}

function _persistOffsets(offsets: Record<string, CalibrationEntry>): void {
  try {
    localStorage.setItem("songpracticestudio_recording_offsets", JSON.stringify(offsets));
  } catch (e) {
    console.warn("[settings] Could not persist recording offsets:", e);
  }
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
  // Key transpose (ported from VPS): active semitone shift, phase-vocoder
  // rendered per-stem and cached under {songDir}/pitched/{n}/.
  transpose: number;
  isTransposing: boolean;
  // Punch-in / punch-out region
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  // Recording state
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  // Playback output device
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string | null;
  isRecording: boolean;
  isSavingTake: boolean;
  takes: Take[];
  // Takes with a lane on screen (in the order they were shown), and the one that is heard.
  shownTakeIds: string[];
  activeTakeId: string | null;
  // Which of the shown takes are heard: all together, or only the selected one
  takePlayback: TakePlayback;
  // Takes the user silenced on their own lane
  mutedTakeIds: string[];
  // The take soloed on its lane (only meaningful while the take channel is soloed)
  soloedTakeId: string | null;
  // Each take's own volume (1 when absent), on top of the take channel's
  takeGains: Record<string, number>;
  // Keep the takes quiet while a new one is recorded
  muteTakesWhileRecording: boolean;
  takeVolume: number;
  // Per-device recording latency calibration, persisted to localStorage
  recordingOffsets: Record<string, CalibrationEntry>;
  // True when the last startRecording used the AudioContext estimate because the
  // stored calibration was missing or stale.
  usedLatencyFallback: boolean;
  // Timeline zoom/pan (ctrl+wheel / shift+wheel)
  minPxPerSec: number;
  scrollTime: number;
  // Metronome downbeat anchor — song time (s) where beat 1 lands, so the
  // click track can be aligned past any silence/pickup before the song's
  // actual downbeat. Persisted per song.
  metronomeOffset: number;
  // Count-in: bars of click played before startRecording actually starts
  // capturing (0 = off). Session-only, not persisted per song.
  countInBars: 0 | 1 | 2;
  isCountingIn: boolean;
  countInBeatsRemaining: number;
}

interface PlayerActions {
  loadSong: (song: Song, containers: Record<string, HTMLElement>) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  skipToStart: () => void;
  skipToEnd: () => void;
  setPlaybackRate: (rate: number) => void;
  setStemVolume: (name: StemName | string, volume: number) => void;
  toggleMute: (name: string) => void;
  toggleSolo: (name: string) => void;
  setTranspose: (semitones: number) => Promise<void>;
  cleanup: () => void;
  // Punch region actions
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
  // Recording device actions
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  setRecordingOffset: (deviceId: string, offsetMs: number) => void;
  applyCalibration: (deviceId: string, entry: CalibrationEntry) => void;
  // Playback output device actions
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  // Recording actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  deleteAllTakes: () => Promise<void>;
  renameTake: (takeId: string, name: string) => Promise<void>;
  setTakeManualOffset: (takeId: string, offset: number) => void;
  setActiveTake: (takeId: string) => void;
  // A click in the takes list: show it, switch to it, or hide it when it is the active one
  toggleTake: (takeId: string) => void;
  hideTake: (takeId: string) => void;
  setTakePlayback: (mode: TakePlayback) => void;
  toggleTakeMute: (takeId: string) => void;
  toggleTakeSolo: (takeId: string) => void;
  setTakeGain: (takeId: string, gain: number) => void;
  setMuteTakesWhileRecording: (mute: boolean) => void;
  setTakeVolume: (v: number) => void;
  // Timeline zoom/pan actions
  setZoom: (minPxPerSec: number, scrollTime: number) => void;
  setScrollTime: (scrollTime: number) => void;
  // Capo fret for the open song (remembered per song) and a counter that makes
  // the chord displays fetch chords.json again after a re-detection
  capo: number;
  setCapo: (fret: number) => void;
  chordsRevision: number;
  bumpChordsRevision: () => void;
  // How much of each chord the displays and the sheet show (a preference, kept for every song)
  chordDetail: ChordDetail;
  setChordDetail: (detail: ChordDetail) => void;
  // Named loops: saved regions of the song
  saveLoop: (name: string) => Promise<void>;
  renameLoop: (id: string, name: string) => Promise<void>;
  deleteLoop: (id: string) => Promise<void>;
  applyLoopRegion: (start: number, end: number) => void;
  // Metronome downbeat anchor action
  setMetronomeOffset: (t: number) => void;
  // Count-in actions
  setCountInBars: (bars: 0 | 1 | 2) => void;
  cancelCountIn: () => void;
}

// Reserved mute/solo key for the recorded take track (shares the same
// mutedStems/soloedStem mechanism as the stems, so soloing either silences
// the rest — no stem is ever actually named this).
export const TAKE_TRACK_KEY = "__take__";

// Soloing a track silences every other track; muting silences only that
// track. Neither ever overwrites the stored slider value.
export function effectiveStemGain(
  name: string,
  rawVolume: number,
  mutedStems: Record<string, boolean>,
  soloedStem: string | null,
): number {
  if (soloedStem !== null) return name === soloedStem ? rawVolume : 0;
  if (mutedStems[name]) return 0;
  return rawVolume;
}

// Compute and push effective volume for every loaded stem, plus the take (if any).
function applyEffectiveVolumes(
  eng: AudioEngine,
  stems: readonly string[],
  stemVolumes: Record<string, number>,
  mutedStems: Record<string, boolean>,
  soloedStem: string | null,
  takeVolume: number,
) {
  for (const name of stems) {
    eng.setStemVolume(name, effectiveStemGain(name, stemVolumes[name] ?? 1.0, mutedStems, soloedStem));
  }
  eng.setTakeVolume(effectiveStemGain(TAKE_TRACK_KEY, takeVolume, mutedStems, soloedStem));
}

/**
 * Build the source list for an "export mix" render from the current store
 * state: one entry per stem/take with nonzero effective volume, resolved to
 * the underlying file path (and take alignment fields, if applicable).
 * Returns null if no track is currently audible.
 */
export function buildMixSources(state: PlayerState): {
  sources: import("../lib/tauri").MixSource[];
  startSec: number;
  endSec: number;
} | null {
  const { song, stemVolumes, mutedStems, soloedStem, takeVolume, takes } = state;
  if (!song) return null;

  const sources: import("../lib/tauri").MixSource[] = [];

  for (const name of song.stems) {
    const gain = effectiveStemGain(name, stemVolumes[name] ?? 1.0, mutedStems, soloedStem);
    if (gain > 0) {
      sources.push({ path: `${song.directory}/${name}.wav`, gain, isTake: false });
    }
  }

  const takeGain = effectiveStemGain(TAKE_TRACK_KEY, takeVolume, mutedStems, soloedStem);
  if (takeGain > 0) {
    // What is heard is what is mixed: every take that is audible right now.
    const audible = audibleTakes({
      shown: state.shownTakeIds,
      active: state.activeTakeId,
      playback: state.takePlayback,
      muted: state.mutedTakeIds,
      recording: false,
      muteWhileRecording: false,
      soloed: soloedTakeOf(state),
      silenced: false,
    });
    for (const id of audible) {
      const take = takes.find((t) => t.id === id);
      if (!take) continue;
      sources.push({
        path: take.filepath,
        gain: takeGain * (state.takeGains[id] ?? 1),
        isTake: true,
        startPosition: take.startPosition,
        audioOffset: take.audioOffset ?? 0,
        manualOffset: take.manualOffset ?? 0,
      });
    }
  }

  if (sources.length === 0) return null;

  return {
    sources,
    startSec: state.punchIn ?? 0,
    endSec: state.punchOut ?? state.duration,
  };
}

// A take soloed on its own lane only chooses among the takes; it never touches the
// stems, and the take channel's own mute / solo state outranks it.
const soloedTakeOf = (s: { soloedTakeId: string | null }): string | null => s.soloedTakeId;

/** The takes as a whole are silent: the main take mute is on, or another track is soloed. */
export function takesSilenced(s: { mutedStems: Record<string, boolean>; soloedStem: string | null }): boolean {
  return effectiveStemGain(TAKE_TRACK_KEY, 1, s.mutedStems, s.soloedStem) === 0;
}

const selectionOf = (s: { shownTakeIds: string[]; activeTakeId: string | null }): TakeSelection => ({
  shown: s.shownTakeIds,
  active: s.activeTakeId,
});

// The two choices about takes that outlive a session: how shown takes are heard,
// and whether they are muted while a new one is recorded.
const TAKE_PREFS_KEY = "sps_take_prefs";
const DEFAULT_TAKE_PREFS: { takePlayback: TakePlayback; muteTakesWhileRecording: boolean } = {
  takePlayback: "all",
  muteTakesWhileRecording: true,
};

function _loadTakePrefs(): typeof DEFAULT_TAKE_PREFS {
  try {
    const raw = localStorage.getItem(TAKE_PREFS_KEY);
    if (raw === null) return DEFAULT_TAKE_PREFS;
    const v = JSON.parse(raw) as { takePlayback?: unknown; muteTakesWhileRecording?: unknown } | null;
    return {
      takePlayback: v?.takePlayback === "selected" ? "selected" : "all",
      muteTakesWhileRecording:
        typeof v?.muteTakesWhileRecording === "boolean" ? v.muteTakesWhileRecording : DEFAULT_TAKE_PREFS.muteTakesWhileRecording,
    };
  } catch (e) {
    console.warn("[player] could not read the take preferences:", e);
    return DEFAULT_TAKE_PREFS;
  }
}

function _persistTakePrefs(prefs: typeof DEFAULT_TAKE_PREFS): void {
  try {
    localStorage.setItem(TAKE_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("[player] could not save the take preferences:", e);
  }
}

const CHORD_DETAIL_KEY = "sps_chord_detail";

function _readChordDetail(): ChordDetail {
  try {
    const raw = localStorage.getItem(CHORD_DETAIL_KEY);
    return isChordDetail(raw) ? raw : "advanced";
  } catch (e) {
    console.warn("[player] could not read the saved chord detail:", e);
    return "advanced";
  }
}

const CAPO_KEY = "sps_capo_by_song";
export const MAX_CAPO_FRET = 7;

function _readCapos(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CAPO_KEY);
    if (raw === null) return {};
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch (e) {
    console.warn("[player] could not read the saved capo frets:", e);
    return {};
  }
}

function _writeCapo(songId: string, fret: number): void {
  const all = _readCapos();
  if (fret > 0) all[songId] = fret;
  else delete all[songId];
  try {
    localStorage.setItem(CAPO_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn("[player] could not save the capo fret:", e);
  }
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => {
  const applySelection = (next: TakeSelection) => {
    const s = get();
    const lost = s.soloedTakeId !== null && !next.shown.includes(s.soloedTakeId);
    set({
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...(lost ? { soloedTakeId: null } : {}),
    });
  };

  const persistLoops = async (songId: string, loops: NamedLoop[]) => {
    const saved = await setSongLoopsApi(songId, loops);
    const current = get().song;
    if (current && current.id === songId) set({ song: { ...current, loops: saved.loops ?? [] } });
  };

  return {
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  stemVolumes: {},
  mutedStems: {},
  soloedStem: null,
  transpose: 0,
  isTransposing: false,
  punchIn: null,
  punchOut: null,
  punchLoop: false,
  audioDevices: [],
  selectedDeviceId: null,
  outputDevices: [],
  selectedOutputDeviceId: null,
  isRecording: false,
  isSavingTake: false,
  takes: [],
  shownTakeIds: [],
  activeTakeId: null,
  mutedTakeIds: [],
  soloedTakeId: null,
  takeGains: {},
  ..._loadTakePrefs(),
  takeVolume: 1.0,
  recordingOffsets: _loadOffsets(),
  usedLatencyFallback: false,
  minPxPerSec: 1,
  scrollTime: 0,
  metronomeOffset: 0,
  countInBars: 0,
  isCountingIn: false,
  countInBeatsRemaining: 0,

  loadSong: async (song, containers) => {
    const eng = getEngine();
    if (!(await eng.load(song.directory, song.stems, containers))) return;
    eng.onScrollChange((minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }));
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
      const s = get();
      if (s.punchOut !== null && time >= s.punchOut) {
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
    });
    eng.onFinish(() => {
      set({ isPlaying: false });
      if (get().isRecording) {
        get().stopRecording().catch((e: unknown) =>
          console.error("[player] auto-stop recording failed:", e)
        );
      }
    });
    const initialVolumes = Object.fromEntries(song.stems.map((n) => [n, 1.0]));
    const baselinePxPerSec = eng.getMinPxPerSec();
    eng.zoomAll(baselinePxPerSec, 0);
    set({
      song,
      duration: eng.getDuration(),
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      stemVolumes: initialVolumes,
      mutedStems: {},
      soloedStem: null,
      punchIn: null,
      punchOut: null,
      punchLoop: false,
      transpose: 0,
      isTransposing: false,
      takes: [],
      shownTakeIds: [],
      activeTakeId: null,
      mutedTakeIds: [],
      soloedTakeId: null,
      takeGains: {},
      takeVolume: 1.0,
      isRecording: false,
      isSavingTake: false,
      minPxPerSec: baselinePxPerSec,
      scrollTime: 0,
      metronomeOffset: Math.max(0, Math.min(eng.getDuration(), song.metronomeOffset ?? 0)),
      capo: Math.max(0, Math.min(MAX_CAPO_FRET, Math.round(Number(_readCapos()[song.id]) || 0))),
    });
    get().fetchTakes();
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

  setStemVolume: (name, volume) => {
    const { mutedStems, soloedStem, stemVolumes, song, takeVolume } = get();
    const newVolumes = { ...stemVolumes, [name]: volume };
    set({ stemVolumes: newVolumes });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, newVolumes, mutedStems, soloedStem, takeVolume);
    }
  },

  toggleMute: (name) => {
    const { mutedStems, soloedStem, stemVolumes, song, takeVolume } = get();
    const newMuted = { ...mutedStems, [name]: !mutedStems[name] };
    set({ mutedStems: newMuted });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, stemVolumes, newMuted, soloedStem, takeVolume);
    }
  },

  toggleSolo: (name) => {
    const { soloedStem, mutedStems, stemVolumes, song, takeVolume } = get();
    const newSolo = soloedStem === name ? null : name;
    set({ soloedStem: newSolo });
    if (song) {
      applyEffectiveVolumes(getEngine(), song.stems, stemVolumes, mutedStems, newSolo, takeVolume);
    }
  },

  setTranspose: async (semitones) => {
    const { song, transpose } = get();
    if (!song || semitones === transpose) return;

    getEngine().pause();
    set({ isTransposing: true, isPlaying: false });

    try {
      let paths: Record<string, string>;
      if (semitones === 0) {
        const dir = song.directory.replace(/\\/g, "/");
        paths = Object.fromEntries(song.stems.map((name) => [name, `${dir}/${name}.wav`]));
      } else {
        const result = await pitchShiftSong(song.directory, song.stems, semitones);
        paths = result.stems;
      }

      await getEngine().reloadStemsFromPaths(paths);
      set({ transpose: semitones, isTransposing: false });
    } catch (e) {
      set({ isTransposing: false });
      throw e;
    }
  },

  cleanup: () => {
    getEngine().destroy();
    recorder?.dispose();
    set({
      song: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      stemVolumes: {},
      mutedStems: {},
      soloedStem: null,
      transpose: 0,
      isTransposing: false,
      isRecording: false,
      isSavingTake: false,
      takes: [],
      shownTakeIds: [],
      activeTakeId: null,
      mutedTakeIds: [],
      soloedTakeId: null,
      takeGains: {},
      takeVolume: 1.0,
    });
  },

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set({ punchIn: null, punchOut: null, punchLoop: false }),
  setPunchLoop: (v) => set({ punchLoop: v }),

  fetchAudioDevices: async () => {
    // WebView2 on the installed tauri:// origin returns empty device labels until mic
    // permission has been granted for this session. A brief probe unlocks the full list.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("Mic permission probe failed — device list may be incomplete:", e);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    _knownDeviceIds = new Set(devices.map((d) => d.deviceId));

    if (!_deviceWatcherInit) {
      _deviceWatcherInit = true;
      navigator.mediaDevices.addEventListener("devicechange", () => {
        void (async () => {
          const current = await navigator.mediaDevices.enumerateDevices();
          const currentIds = new Set(current.map((d) => d.deviceId));
          const prev = _knownDeviceIds;
          _knownDeviceIds = currentIds;
          // devicechange also fires for irrelevant changes (e.g. default-device
          // switches) — only act when the enumerated set actually differs.
          if (
            prev !== null &&
            prev.size === currentIds.size &&
            [...prev].every((id) => currentIds.has(id))
          ) {
            return;
          }

          set({
            audioDevices: current.filter((d) => d.kind === "audioinput"),
            outputDevices: current.filter((d) => d.kind === "audiooutput"),
          });

          const offsets = { ...get().recordingOffsets };
          let changed = false;
          for (const [inputId, entry] of Object.entries(offsets)) {
            if (entry.stale) continue;
            // "" is the default-microphone key, never present in enumerated ids.
            const inputGone = inputId !== "" && !currentIds.has(inputId);
            const outputGone = entry.outputDeviceId !== undefined && !currentIds.has(entry.outputDeviceId);
            if (inputGone || outputGone) {
              offsets[inputId] = { ...entry, stale: true };
              changed = true;
            }
          }
          if (changed) {
            set({ recordingOffsets: offsets });
            _persistOffsets(offsets);
            console.warn("[calibration] audio device set changed — affected calibrations marked stale");
          }
        })().catch((e: unknown) => console.warn("[calibration] devicechange handling failed:", e));
      });
    }
  },

  setAudioDevice: (deviceId) => {
    set({ selectedDeviceId: deviceId });
  },

  setRecordingOffset: (deviceId, offsetMs) => {
    // A hand-typed value has no measured confidence — store it bare, which also
    // clears any stale flag from a previous calibration.
    const offsets = { ...get().recordingOffsets, [deviceId]: { offset: offsetMs } };
    set({ recordingOffsets: offsets });
    _persistOffsets(offsets);
  },

  applyCalibration: (deviceId, entry) => {
    const offsets = { ...get().recordingOffsets, [deviceId]: entry };
    set({ recordingOffsets: offsets });
    _persistOffsets(offsets);
  },

  fetchOutputDevices: async () => {
    // Same WebView2 permission issue as fetchAudioDevices — probe before enumerating.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("Mic permission probe failed — output device list may be incomplete:", e);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ outputDevices: devices.filter((d) => d.kind === "audiooutput") });
  },

  setOutputDevice: async (deviceId) => {
    await getEngine().setOutputDevice(deviceId ?? "");
    set({ selectedOutputDeviceId: deviceId });
  },

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    // With "mute takes while recording" on (the default), drop the selected take
    // before recording a new one: every take stays saved (takes.json is never
    // touched) and shown, but none is heard, so the performer records against the
    // stem mix alone — not their last attempt. With it off the takes keep playing
    // and the selection is left alone.
    if (get().muteTakesWhileRecording && get().activeTakeId) {
      set({ activeTakeId: null });
    }

    const eng = getEngine();
    // Honour punch-in: start recording from the punch point, not the playhead
    recordingStartPos = get().punchIn ?? eng.getCurrentTime();
    eng.pause();
    // eng.pause() only touches the engine, not the store — flip isPlaying
    // synchronously so TempoControl's metronome effect releases the shared
    // `metronome` singleton before the count-in below claims it.
    set({ isPlaying: false });

    const rec = getRecorder();
    let inputLatencyS = 0;
    try {
      await rec.init(get().selectedDeviceId);
      // Re-enumerate after getUserMedia succeeds — browser now populates device labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
      inputLatencyS = (rec.getStream()?.getAudioTracks()[0].getSettings() as MediaTrackSettings & { latency?: number })?.latency ?? 0;
    } catch (e) {
      eng.setInteract(true);
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    // Count-in: play N bars of click at the song's tempo before capture
    // actually begins, so the performer can settle into the beat (tap or
    // mute-strum along) before the take starts — which also means the take
    // lands beat-aligned by construction, making the manual take-repositioning
    // drag afterward a simple constant shift instead of an arbitrary one.
    // Click stops the instant recording starts; a second Record click during
    // the countdown aborts it via cancelCountIn().
    const countInBars = get().countInBars;
    if (countInBars > 0) {
      const bpm = (song.detectedBpm ?? 120) * get().playbackRate;
      const totalBeats = countInBars * 4;
      const beatIntervalMs = (60 / bpm) * 1000;
      const completed = await new Promise<boolean>((resolve) => {
        let remaining = totalBeats;
        _countInResolve = resolve;
        set({ isCountingIn: true, countInBeatsRemaining: remaining });
        metronome.start(bpm, 0.05, 0);
        _countInIntervalId = window.setInterval(() => {
          remaining -= 1;
          set({ countInBeatsRemaining: Math.max(0, remaining) });
        }, beatIntervalMs);
        _countInTimeoutId = window.setTimeout(() => {
          _countInTimeoutId = null;
          if (_countInIntervalId !== null) {
            window.clearInterval(_countInIntervalId);
            _countInIntervalId = null;
          }
          metronome.stop();
          set({ isCountingIn: false, countInBeatsRemaining: 0 });
          _countInResolve = null;
          resolve(true);
        }, countInDurationSeconds(bpm, countInBars) * 1000);
      });
      if (!completed) {
        // Cancelled mid-count — abandon this recording attempt, releasing
        // the mic already opened above.
        rec.releaseStream();
        eng.setInteract(true);
        return;
      }
    }

    eng.setInteract(false);
    // isRecording only flips below; silence the takes first so none is heard in between.
    if (get().muteTakesWhileRecording) eng.setAudibleTakeTracks([]);
    try {
      eng.seekTo(recordingStartPos);
      eng.play();
      rec.start();
    } catch (e) {
      // The takes were silenced above for a recording that did not start.
      pushTakeAudio(get());
      throw e;
    }

    // Calibrated value takes full priority — skip AudioContext measurement when present.
    // Stale entries (a device they were measured with disappeared) are not trusted.
    const calib = get().recordingOffsets[get().selectedDeviceId ?? ""];
    const calibUsable = calib !== undefined && calib.offset > 0 && !calib.stale;
    if (calibUsable) {
      set({ usedLatencyFallback: false });
      _recordingLatencyS = calib.offset / 1000;
      console.log("[recording] using calibrated compensation:", calib.offset, "ms");
    } else {
      if (calib !== undefined && calib.offset > 0) {
        console.warn("[recording] stored calibration is stale — falling back to AudioContext estimate");
      }
      set({ usedLatencyFallback: true });
      // No calibration: fall back to AudioContext round-trip estimate.
      try {
        const latencyCtx = new AudioContext();
        const outputLatencyS = (latencyCtx.outputLatency ?? 0) + (latencyCtx.baseLatency ?? 0);
        latencyCtx.close().catch((e: unknown) => console.warn("[latency] ctx close:", e));
        _recordingLatencyS = outputLatencyS + inputLatencyS;
        console.log("[recording] latency — output:", outputLatencyS, "input:", inputLatencyS, "total:", _recordingLatencyS);
      } catch (e) {
        console.warn("[recording] latency measurement failed, compensation disabled:", e);
        _recordingLatencyS = 0;
      }
    }

    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    const takeDurationS = eng.getCurrentTime() - recordingStartPos;
    eng.stop();
    eng.setInteract(true);

    // Immediately flip recording off so the button stops pulsing,
    // then show a saving indicator while the blob is flushed to disk.
    set({ isRecording: false, isPlaying: false, isSavingTake: true });

    try {
      const blob = await rec.stop();
      rec.releaseStream();

      // Convert blob to byte array for Tauri
      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      // Shift startPosition back by round-trip latency.
      // When that pushes startPos below 0 (recording from song start), keep startPos at 0
      // and store the remainder as audioOffset so a future consumer can skip that many
      // seconds into the audio file to align take[audioOffset] with song position 0.
      const rawCompensated = recordingStartPos - _recordingLatencyS;
      const compensatedStartPos = Math.max(0, rawCompensated);
      const audioOffset = rawCompensated < 0 ? -rawCompensated : 0;
      const take = await saveTake(song.id, audioData, compensatedStartPos, audioOffset);

      // Instrumentation only: correlate future misalignment reports with take length
      // before deciding whether within-take clock drift is worth correcting.
      if (takeDurationS > DRIFT_CHECK_MIN_TAKE_S) {
        console.info(
          `[drift-check] takeDuration=${takeDurationS.toFixed(1)}s input=${get().selectedDeviceId ?? "default"} output=${get().selectedOutputDeviceId ?? "default"}`,
        );
      }

      // Show and select the new take — StemView loads it into a lane of its
      // own; the takes already shown stay where they are.
      const next = showTake(selectionOf(get()), take.id);
      set((state) => ({
        isSavingTake: false,
        currentTime: 0,
        takes: [...state.takes, take],
        shownTakeIds: [...next.shown],
        activeTakeId: next.active,
      }));
    } catch (e) {
      rec.releaseStream();
      set({ isSavingTake: false, currentTime: 0 });
      throw e;
    }
  },

  fetchTakes: async () => {
    const { song } = get();
    if (!song) return;
    const takes = await listTakes(song.id);
    const ids = takes.map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), ids);
    set((state) => ({
      takes,
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      mutedTakeIds: state.mutedTakeIds.filter((id) => ids.includes(id)),
      takeGains: Object.fromEntries(Object.entries(state.takeGains).filter(([id]) => ids.includes(id))),
      ...(state.soloedTakeId !== null && !ids.includes(state.soloedTakeId) ? { soloedTakeId: null } : {}),
    }));
  },

  deleteTake: async (takeId) => {
    const { song } = get();
    if (!song) return;
    await deleteTakeApi(song.id, takeId);
    const next = hideTake(selectionOf(get()), takeId);
    set((state) => ({
      takes: state.takes.filter((t) => t.id !== takeId),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      mutedTakeIds: state.mutedTakeIds.filter((id) => id !== takeId),
      takeGains: Object.fromEntries(Object.entries(state.takeGains).filter(([id]) => id !== takeId)),
      ...(state.soloedTakeId === takeId ? { soloedTakeId: null } : {}),
    }));
  },

  deleteAllTakes: async () => {
    const { song, takes } = get();
    if (!song || takes.length === 0) return;
    const deleted = new Set<string>();
    let failure: unknown = null;
    for (const t of takes) {
      try {
        await deleteTakeApi(song.id, t.id);
        deleted.add(t.id);
      } catch (e) {
        failure = e;
        break;
      }
    }
    const remaining = takes.filter((t) => !deleted.has(t.id)).map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), remaining);
    set((state) => ({
      takes: state.takes.filter((t) => !deleted.has(t.id)),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      mutedTakeIds: state.mutedTakeIds.filter((id) => !deleted.has(id)),
      takeGains: Object.fromEntries(Object.entries(state.takeGains).filter(([id]) => !deleted.has(id))),
      ...(state.soloedTakeId !== null && deleted.has(state.soloedTakeId) ? { soloedTakeId: null } : {}),
    }));
    if (failure) throw failure;
  },

  renameTake: async (takeId, name) => {
    const { song } = get();
    if (!song) return;
    const updated = await renameTakeApi(song.id, takeId, name);
    set((state) => ({
      takes: state.takes.map((t) => (t.id === takeId ? updated : t)),
    }));
  },

  setTakeManualOffset: (takeId, offset) => {
    const { song, takes } = get();
    if (!song) return;
    const take = takes.find((t) => t.id === takeId);
    if (!take) return;
    // Unclamped — a take can be dragged to start before song time 0. Its
    // leading edge just becomes unreachable during playback; the recorded
    // file itself is never trimmed or otherwise modified.
    const rounded = Math.round(offset * 100) / 100;
    const updated = { ...take, manualOffset: rounded || undefined };
    set({ takes: takes.map((t) => (t.id === takeId ? updated : t)) });
    getEngine().setTakeManualOffset(takeId, rounded);
    setTakeManualOffsetApi(song.id, takeId, rounded).catch((e: unknown) =>
      console.error("[player] failed to persist take manual offset:", e)
    );
  },

  toggleTakeSolo: (takeId) => {
    set((s) => ({ soloedTakeId: s.soloedTakeId === takeId ? null : takeId }));
  },

  setTakeGain: (takeId, gain) => {
    set((s) => ({ takeGains: { ...s.takeGains, [takeId]: Math.max(0, Math.min(1, gain)) } }));
  },

  setActiveTake: (takeId) => applySelection(showTake(selectionOf(get()), takeId)),

  toggleTake: (takeId) => applySelection(toggleTake(selectionOf(get()), takeId)),

  hideTake: (takeId) => applySelection(hideTake(selectionOf(get()), takeId)),

  setTakePlayback: (mode) => {
    set({ takePlayback: mode });
    _persistTakePrefs({ takePlayback: mode, muteTakesWhileRecording: get().muteTakesWhileRecording });
  },

  toggleTakeMute: (takeId) => {
    set((state) => ({
      mutedTakeIds: state.mutedTakeIds.includes(takeId)
        ? state.mutedTakeIds.filter((id) => id !== takeId)
        : [...state.mutedTakeIds, takeId],
    }));
  },

  setMuteTakesWhileRecording: (mute) => {
    set({ muteTakesWhileRecording: mute });
    _persistTakePrefs({ takePlayback: get().takePlayback, muteTakesWhileRecording: mute });
  },

  setTakeVolume: (v) => {
    set({ takeVolume: v });
    const { mutedStems, soloedStem } = get();
    let vol = v;
    if (soloedStem !== null) {
      vol = soloedStem === TAKE_TRACK_KEY ? vol : 0;
    } else if (mutedStems[TAKE_TRACK_KEY]) {
      vol = 0;
    }
    getEngine().setTakeVolume(vol);
  },

  setZoom: (minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }),
  setScrollTime: (scrollTime) => set({ scrollTime }),

  setMetronomeOffset: (t) => {
    const { song, duration } = get();
    if (!song) return;
    const clamped = Math.max(0, Math.min(duration > 0 ? duration : Math.max(0, t), t));
    set({ metronomeOffset: clamped, song: { ...song, metronomeOffset: clamped } });
    setMetronomeOffsetApi(song.id, clamped).catch((e: unknown) =>
      console.error("[player] failed to persist metronome offset:", e)
    );
  },

  capo: 0,
  setCapo: (fret) => {
    const clamped = Math.max(0, Math.min(MAX_CAPO_FRET, Math.round(fret)));
    set({ capo: clamped });
    const song = get().song;
    if (song) _writeCapo(song.id, clamped);
  },

  chordDetail: _readChordDetail(),
  setChordDetail: (detail) => {
    set({ chordDetail: detail });
    try {
      localStorage.setItem(CHORD_DETAIL_KEY, detail);
    } catch (e) {
      console.warn("[player] could not save the chord detail:", e);
    }
  },

  chordsRevision: 0,
  bumpChordsRevision: () => set((s) => ({ chordsRevision: s.chordsRevision + 1 })),

  saveLoop: async (name) => {
    const { song, punchIn, punchOut, duration } = get();
    if (!song) return;
    if (punchIn === null || punchOut === null) throw new Error("Set a punch region first");
    const next = addLoop(song.loops ?? [], { id: crypto.randomUUID(), name, start: punchIn, end: punchOut }, duration);
    await persistLoops(song.id, next);
  },

  renameLoop: async (id, name) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(song.id, renameLoopIn(song.loops ?? [], id, name));
  },

  deleteLoop: async (id) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(song.id, removeLoop(song.loops ?? [], id));
  },

  applyLoopRegion: (start, end) => {
    set({ punchIn: start, punchOut: end, punchLoop: true });
    get().seek(start);
  },

  setCountInBars: (bars) => {
    if (get().isCountingIn || get().isRecording) return;
    set({ countInBars: bars });
  },

  cancelCountIn: () => {
    if (_countInResolve === null) return;
    if (_countInTimeoutId !== null) {
      window.clearTimeout(_countInTimeoutId);
      _countInTimeoutId = null;
    }
    if (_countInIntervalId !== null) {
      window.clearInterval(_countInIntervalId);
      _countInIntervalId = null;
    }
    metronome.stop();
    set({ isCountingIn: false, countInBeatsRemaining: 0 });
    const resolve = _countInResolve;
    _countInResolve = null;
    resolve(false);
  },
  };
});

function pushTakeAudio(state: PlayerState): void {
  const eng = getEngine();
  eng.setActiveTakeTrack(state.activeTakeId);
  eng.setTakeGains(state.takeGains);
  eng.setAudibleTakeTracks(
    audibleTakes({
      shown: state.shownTakeIds,
      active: state.activeTakeId,
      playback: state.takePlayback,
      muted: state.mutedTakeIds,
      recording: state.isRecording,
      muteWhileRecording: state.muteTakesWhileRecording,
      soloed: soloedTakeOf(state),
      silenced: takesSilenced(state),
    }),
  );
}

// What is heard follows from the takes shown, the selection, the playback mode,
// the lane mutes and whether a recording is under way. Derived here, once, so no
// action has to remember to tell the engine.
usePlayerStore.subscribe((state, prev) => {
  if (
    state.shownTakeIds === prev.shownTakeIds &&
    state.activeTakeId === prev.activeTakeId &&
    state.takePlayback === prev.takePlayback &&
    state.mutedTakeIds === prev.mutedTakeIds &&
    state.soloedTakeId === prev.soloedTakeId &&
    state.soloedStem === prev.soloedStem &&
    state.mutedStems === prev.mutedStems &&
    state.takeGains === prev.takeGains &&
    state.isRecording === prev.isRecording &&
    state.muteTakesWhileRecording === prev.muteTakesWhileRecording
  ) {
    return;
  }
  pushTakeAudio(state);
});
