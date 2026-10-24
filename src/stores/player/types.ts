import type { StateCreator, StoreApi } from "zustand";
import type { Song, StemName, Take } from "../../lib/types";
import type { ChordDetail } from "../../lib/chordNames";
import type { TakePlayback } from "@giamat90/mps-core/takes";
import type { BarMap, ClickDensity } from "@giamat90/mps-core/meter";
import type { CountInSlice } from "@giamat90/mps-core/countIn";

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

export interface TransportSlice {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  loadSong: (song: Song, containers: Record<string, HTMLElement>) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  skipToStart: () => void;
  skipToEnd: () => void;
  setPlaybackRate: (rate: number) => void;
  cleanup: () => void;
}

export interface MixerSlice {
  stemVolumes: Record<string, number>;
  mutedStems: Record<string, boolean>;
  soloedStem: string | null;
  // Key transpose (ported from VPS): active semitone shift, phase-vocoder
  // rendered per-stem and cached under {songDir}/pitched/{n}/.
  transpose: number;
  isTransposing: boolean;
  setStemVolume: (name: StemName | string, volume: number) => void;
  toggleMute: (name: string) => void;
  toggleSolo: (name: string) => void;
  setTranspose: (semitones: number) => Promise<void>;
}

export interface TimelineSlice {
  // Punch-in / punch-out region
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  // Timeline zoom/pan (ctrl+wheel / shift+wheel)
  minPxPerSec: number;
  scrollTime: number;
  // Metronome downbeat anchor — song time (s) where beat 1 lands, so the
  // click track can be aligned past any silence/pickup before the song's
  // actual downbeat. Persisted per song.
  metronomeOffset: number;
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
  setZoom: (minPxPerSec: number, scrollTime: number) => void;
  setScrollTime: (scrollTime: number) => void;
  setMetronomeOffset: (t: number) => void;
  // Named loops: saved regions of the song
  saveLoop: (name: string) => Promise<void>;
  renameLoop: (id: string, name: string) => Promise<void>;
  deleteLoop: (id: string) => Promise<void>;
  applyLoopRegion: (start: number, end: number) => void;
}

export interface DevicesSlice {
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  // Playback output device
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string | null;
  // Per-device recording latency calibration, persisted to localStorage
  recordingOffsets: Record<string, CalibrationEntry>;
  // True when the last startRecording used the AudioContext estimate because the
  // stored calibration was missing or stale.
  usedLatencyFallback: boolean;
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  setRecordingOffset: (deviceId: string, offsetMs: number) => void;
  applyCalibration: (deviceId: string, entry: CalibrationEntry) => void;
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
}

export interface RecordingSlice {
  isRecording: boolean;
  isSavingTake: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

export interface TakesSlice {
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
}

export interface ChordsSlice {
  // Capo fret for the open song (remembered per song) and a counter that makes
  // the chord displays fetch chords.json again after a re-detection
  capo: number;
  setCapo: (fret: number) => void;
  chordsRevision: number;
  bumpChordsRevision: () => void;
  // How much of each chord the displays and the sheet show (a preference, kept for every song)
  chordDetail: ChordDetail;
  setChordDetail: (detail: ChordDetail) => void;
}

/** A run of taps being recorded: on the first beat of each bar, or on every beat. */
export interface TapSession {
  kind: "bars" | "beats";
  den: number;
  /** Beats per bar, for taps on every beat. */
  perBar: number;
  /** Seconds per pulse, for taps on the first beat of each bar: how many pulses fit between two taps. */
  pulse: number;
  taps: number[];
}

/** A state the bars can be put back to: what was shown, and whether it was the user's own. */
export interface MeterEntry {
  map: BarMap | null;
  edited: boolean;
}

export interface MeterSlice {
  // The song's bars: the user's own when there are any, otherwise what the detector found; null when never analysed
  meterMap: BarMap | null;
  meterEdited: boolean;
  meterHistory: MeterEntry[];
  meterSelected: number | null;
  meterBusy: boolean;
  meterError: string | null;
  // Which pulses of the bars click (a preference, kept for every song)
  clickDensity: ClickDensity;
  tapSession: TapSession | null;
  loadMeter: (songId: string) => Promise<void>;
  // Stores a new bar map as the user's own; null (an edit that did not fit) only reports the problem
  applyMeter: (next: BarMap | null, select?: number | null) => Promise<void>;
  undoMeter: () => Promise<void>;
  resetMeter: () => Promise<void>;
  detectMeter: () => Promise<void>;
  startMeterFromGrid: () => Promise<void>;
  selectBar: (index: number | null) => void;
  setClickDensity: (density: ClickDensity) => void;
  startTapping: (session: Omit<TapSession, "taps">) => void;
  tapNow: () => void;
  finishTapping: () => Promise<void>;
  cancelTapping: () => void;
  clearMeterError: () => void;
}

export type PlayerStore = TransportSlice &
  MixerSlice &
  TimelineSlice &
  DevicesSlice &
  CountInSlice &
  RecordingSlice &
  TakesSlice &
  ChordsSlice &
  MeterSlice;

export type Slice<T> = StateCreator<PlayerStore, [], [], T>;
export type Setter = StoreApi<PlayerStore>["setState"];
export type Getter = StoreApi<PlayerStore>["getState"];
