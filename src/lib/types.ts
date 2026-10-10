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

/** One word of a lyric line, timed against the song (seconds) */
export interface LyricWord {
  text: string;
  start: number;
  end: number;
  /** Alignment confidence 0..1; 0 for words the model could not place */
  score: number;
}

export interface LyricLine {
  text: string;
  start: number;
  end: number;
  score: number;
  words: LyricWord[];
}

/** A song's lyrics aligned to its vocals stem (stored as `lyrics.json`) */
export interface Lyrics {
  version: number;
  source: "paste" | "lrclib";
  /** The text exactly as supplied, kept for editing and re-syncing */
  text: string;
  aligner: string;
  alignedAt: string;
  meanScore: number;
  /** Set when the text probably does not fit the recording */
  warning?: string | null;
  lines: LyricLine[];
}

/** Lyrics found online, for the user to review before syncing */
export interface FoundLyrics {
  text: string;
  synced: boolean;
  title: string;
  artist: string;
  source: string;
}

export interface LyricsProgress {
  songId: string;
  progress: number;
  stage: string;
}
