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
}

export interface ProcessingStatus {
  songId: string;
  progress: number;
  stage: string;
  isComplete: boolean;
  error?: string;
}
