import type { StateCreator, StoreApi } from "zustand";
import type { Song, StemName, Take } from "../../lib/types";
import type { ChordDetail } from "../../lib/chordNames";
import type { TakePlayback } from "@giamat90/mps-core/takes";

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
  // Count-in: bars of click played before startRecording actually starts
  // capturing (0 = off). Session-only, not persisted per song.
  countInBars: 0 | 1 | 2;
  isCountingIn: boolean;
  countInBeatsRemaining: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  setCountInBars: (bars: 0 | 1 | 2) => void;
  cancelCountIn: () => void;
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

export type PlayerStore = TransportSlice &
  MixerSlice &
  TimelineSlice &
  DevicesSlice &
  RecordingSlice &
  TakesSlice &
  ChordsSlice;

export type Slice<T> = StateCreator<PlayerStore, [], [], T>;
export type Setter = StoreApi<PlayerStore>["setState"];
export type Getter = StoreApi<PlayerStore>["getState"];
