/** Song in the library */
export interface Song {
  id: string;
  title: string;
  artist?: string;
  duration: number;
  detectedKey?: string;
  detectedBpm?: number;
  processedAt: string;
  directory: string;
}

/** Processing status */
export interface ProcessingStatus {
  songId: string;
  progress: number;
  stage: string;
  isComplete: boolean;
  error?: string;
}

/** Raw pitch output from pYIN — parallel arrays, one entry per analysis frame */
export interface PitchData {
  times: number[];
  f0: number[];        // Hz; 0.0 for unvoiced frames
  voiced: boolean[];
  confidence: number[];
}

/** Pitch data point used internally by the frontend */
export interface PitchPoint {
  time: number;
  frequency: number;
  confidence: number;
}

/** A single practice take */
export interface Take {
  id: string;
  songId: string;
  recordedAt: string;
  filepath: string;
  /** Song position (seconds) where recording started; 0 for full-song takes. */
  startPosition: number;
  pitchData?: PitchData;
  onsets?: number[];
  dynamics?: DynamicsPoint[];
  vibrato?: VibratoMetrics;
}

/** Dynamics data point */
export interface DynamicsPoint {
  time: number;
  rms: number;
}

/** Vibrato metrics (computed client-side from pitch data) */
export interface VibratoMetrics {
  rate: number;
  depth: number;
  regularity: number;
}

/** Timing accuracy (computed client-side) */
export interface TimingDeviation {
  noteIndex: number;
  referenceTime: number;
  userTime: number;
  deltaMs: number;
}

/** AI coaching response */
export interface CoachingResponse {
  tips: CoachingTip[];
  generatedAt: string;
}

export interface CoachingTip {
  category: "pitch" | "timing" | "vibrato" | "dynamics" | "general";
  title: string;
  detail: string;
}
