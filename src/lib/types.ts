import type { NamedLoop } from "@giamat90/mps-core/loops";

export type { NamedLoop };

export type StemName = "vocals" | "drums" | "bass" | "guitar" | "piano" | "other";

export interface Song {
  id: string;
  title: string;
  duration: number;
  detectedKey?: string;
  detectedBpm?: number;
  processedAt: string;
  directory: string;
  stems: StemName[];
  metronomeOffset?: number;
  hasChords?: boolean;
  loops?: NamedLoop[];
  folderId?: string | null;
  sortIndex: number;
  /** What the song is called in the world; online lookups use these instead of `title`, which the user renames to tell versions apart */
  officialTitle?: string;
  officialArtist?: string;
}

/** User-named, flat (non-nested) grouping of songs in the library */
export interface Folder {
  id: string;
  name: string;
  sortIndex: number;
}

/** A chord the audio of a segment looked like, and how well it fit (0-1). */
export interface ChordAlternative {
  chord: string;
  fit: number;
}

export interface ChordSegment {
  start: number;
  end: number;
  /** "C:maj", "A:min", "G:7", "C:maj7", "A:min7" */
  chord: string;
  /** The bass note when it is a chord tone other than the root (a slash chord). */
  bass?: string;
  /** 0-1, how well the chord's notes matched the audio; absent on older detections and on chords set by hand. */
  confidence?: number;
  /** The other chords the audio looked most like, best first; written by the detector. */
  alternatives?: ChordAlternative[];
}

export interface ProcessingStatus {
  songId: string;
  progress: number;
  stage: string;
  isComplete: boolean;
  error?: string;
}

/** A recorded track (take) — no pitch/vocal analysis, just the raw recording. */
export interface Take {
  id: string;
  songId: string;
  recordedAt: string;
  filepath: string;
  /** User-assigned display name; falls back to "Take N" in the UI when absent. */
  name?: string;
  /** Song position (seconds) where recording started; 0 for full-song takes. */
  startPosition: number;
  /** Seconds into the audio file to skip on playback (non-zero when latency
   *  compensation exceeds startPosition). */
  audioOffset?: number;
  /** Seconds, signed; user drag nudge applied on top of startPosition to fine-tune sync
   *  after the fact. undefined/0 means untouched (auto-detected position stands). */
  manualOffset?: number;
}

/** One played bar of a song's tab placed on its recording. */
export interface TabBar {
  /** Index of the bar in the tab (its master bar); a repeated bar appears once per pass. */
  index: number;
  occurrence: number;
  /** Seconds into the recording at which the bar starts. */
  time: number;
}

export interface TabSync {
  version: number;
  algorithm: string;
  alignedAt: string;
  offset: number;
  /** Semitones the recording sounds above the tab. */
  transpose: number;
  usedDrums: boolean;
  peak: number;
  meanCost: number;
  steadiness: number;
  /** "good" | "check" | "poor" */
  quality: string;
  /** True once the user has moved a bar line. */
  edited: boolean;
  bars: TabBar[];
}

/** A song's stored tab and, once aligned, where its bars fall in the recording. */
export interface TabRecord {
  fileName: string;
  originalName: string;
  /** Absolute path of the stored file. */
  path: string;
  sync: TabSync | null;
}
