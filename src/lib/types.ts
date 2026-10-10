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
  folderId?: string | null;
  sortIndex: number;
}

/** User-named, flat (non-nested) grouping of songs in the library */
export interface Folder {
  id: string;
  name: string;
  sortIndex: number;
}

export interface ChordSegment {
  start: number;
  end: number;
  chord: string;
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
