import type { ChordSegment } from "./types";
import { formatChordName, transposeChord, transposeKey, transposeNote } from "./chordNames";

export interface ChordChartInput {
  title: string;
  key?: string;
  bpm?: number;
  segments: ChordSegment[];
  /** Semitones the song is currently shifted by. */
  transpose: number;
  /** Fret the capo is on; the chords become the shapes to play, the key stays the sounding one. */
  capo: number;
}

const CHORDS_PER_LINE = 4;
const CELL_WIDTH = 13;

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A plain-text chord sheet: a start time and chord name per chord, four to a line. */
export function buildChordChart(input: ChordChartInput): string {
  const { title, key, bpm, segments, transpose, capo } = input;
  const lines: string[] = [title];

  const facts: string[] = [];
  if (key) facts.push(`Key: ${transposeKey(key, transpose)}`);
  if (bpm) facts.push(`Tempo: ${Math.round(bpm)} BPM`);
  if (facts.length > 0) lines.push(facts.join("   "));
  if (transpose !== 0) lines.push(`Transposed ${transpose > 0 ? "+" : ""}${transpose} semitones`);
  if (capo > 0) lines.push(`Capo ${capo}: the chords below are the shapes to play`);
  lines.push("");

  const shown: { start: number; name: string }[] = [];
  for (const seg of segments) {
    const shift = transpose - capo;
    const name = formatChordName(
      transposeChord(seg.chord, shift),
      seg.bass ? transposeNote(seg.bass, shift) : null,
    );
    if (shown.length > 0 && shown[shown.length - 1].name === name) continue;
    shown.push({ start: seg.start, name });
  }

  if (shown.length === 0) {
    lines.push("No chords were detected for this song.");
  } else {
    for (let i = 0; i < shown.length; i += CHORDS_PER_LINE) {
      const cells = shown.slice(i, i + CHORDS_PER_LINE).map((c) => `${formatClock(c.start)}  ${c.name}`);
      lines.push(cells.map((c) => c.padEnd(CELL_WIDTH)).join("").trimEnd());
    }
  }
  return lines.join("\n") + "\n";
}
