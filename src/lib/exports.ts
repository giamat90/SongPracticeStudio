import { bassTabToMidi, type BassNote } from "./bassTab";
import { buildChordChart, type ChordChartInput } from "./chordChart";
import { exportFile } from "./tauri";

const FILE_NAME_FORBIDDEN = /[\/:*?"<>|]/g;

/** A song title made safe to use inside a file name. */
export function safeFileName(title: string): string {
  const cleaned = title.replace(FILE_NAME_FORBIDDEN, "_").trim();
  return cleaned.length > 0 ? cleaned : "Song";
}

export function exportChordChart(input: ChordChartInput): Promise<void> {
  const bytes = new TextEncoder().encode(buildChordChart(input));
  return exportFile(Array.from(bytes), `${safeFileName(input.title)} - Chords.txt`);
}

export function exportBassMidi(title: string, notes: BassNote[], bpm: number): Promise<void> {
  return exportFile(Array.from(bassTabToMidi(notes, bpm)), `${safeFileName(title)} - Bass.mid`);
}
