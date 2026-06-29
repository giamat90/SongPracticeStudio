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
  sourceFile?: string;
  bassTab?: boolean;
}

export interface BassNote {
  time: number;
  duration: number;
  pitch: number;
  string: number;  // 0=E, 1=A, 2=D, 3=G
  fret: number;    // 0–24
}

export interface BassTabData {
  version: number;
  duration: number;
  notes: BassNote[];
}

export interface ProcessingStatus {
  songId: string;
  progress: number;
  stage: string;
  isComplete: boolean;
  error?: string;
}
