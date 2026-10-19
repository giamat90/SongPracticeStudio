import type { ChordSegment } from "./types";

export interface DetectedSection {
  start: number;
  end: number;
  /** "Intro" before the first chord, otherwise a letter: sections with the same letter play the same chords. */
  label: string;
}

export interface SectionOptions {
  duration: number;
  bpm: number;
  beatsPerBar?: number;
  /** Song time of a downbeat; bars are counted from it. */
  offset?: number;
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHORD_KINDS = 24;
const BLOCK_BARS = 4;
const MIN_BARS = 8;
const MIN_INTRO_BARS = 2;
const MIN_BAR_COVERAGE = 0.25;
/** Two stretches play the same progression when this share of their chord steps agree (cosine). */
const SAME_PROGRESSION = 0.6;

/** The qualities whose third is minor, for telling a chord's two kinds apart. */
const MINOR_QUALITIES = new Set(["min", "min7", "min6", "min9", "minmaj7"]);

/** A chord collapsed to 24 kinds (root and major / minor), or -1 for no chord. */
function chordKind(chord: string): number {
  const [root, quality] = chord.split(":");
  const i = NOTES.indexOf(root);
  if (i < 0) return -1;
  return i * 2 + (MINOR_QUALITIES.has(quality) ? 1 : 0);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The chord kind that fills most of each bar, or -1 where there is none to speak of. */
function chordPerBar(segments: ChordSegment[], origin: number, barSeconds: number, bars: number): number[] {
  const weight: number[][] = Array.from({ length: bars }, () => new Array<number>(CHORD_KINDS).fill(0));
  for (const seg of segments) {
    const kind = chordKind(seg.chord);
    if (kind < 0) continue;
    const first = Math.max(0, Math.floor((seg.start - origin) / barSeconds));
    const last = Math.min(bars - 1, Math.floor((seg.end - origin - 1e-9) / barSeconds));
    for (let b = first; b <= last; b++) {
      const from = Math.max(seg.start, origin + b * barSeconds);
      const to = Math.min(seg.end, origin + (b + 1) * barSeconds);
      if (to > from) weight[b][kind] += to - from;
    }
  }
  return weight.map((w) => {
    let best = -1;
    let bestWeight = 0;
    w.forEach((v, k) => {
      if (v > bestWeight) {
        bestWeight = v;
        best = k;
      }
    });
    return bestWeight >= MIN_BAR_COVERAGE * barSeconds ? best : -1;
  });
}

/** How often each chord-to-chord step occurs from bar `from` up to, not including, bar `to`. */
function stepHistogram(kinds: number[], from: number, to: number): Float32Array {
  const h = new Float32Array(CHORD_KINDS * CHORD_KINDS);
  for (let b = from; b < to - 1; b++) {
    if (kinds[b] >= 0 && kinds[b + 1] >= 0) h[kinds[b] * CHORD_KINDS + kinds[b + 1]] += 1;
  }
  return h;
}

/**
 * Cuts a song into sections from its chords. The song is read in blocks of four
 * bars from the first downbeat; a block that plays the same progression as the
 * section before it joins that section, otherwise it starts a new one. Sections
 * playing the same progression share a letter.
 *
 * Chords alone cannot tell apart a verse and a chorus that loop the same
 * chords, and the boundaries land on the four-bar grid.
 */
export function detectSections(segments: ChordSegment[], options: SectionOptions): DetectedSection[] {
  const { duration, bpm, beatsPerBar = 4, offset = 0 } = options;
  if (!(duration > 0) || !(bpm > 0) || !(beatsPerBar > 0) || segments.length === 0) return [];

  const barSeconds = (beatsPerBar * 60) / bpm;
  const origin = ((offset % barSeconds) + barSeconds) % barSeconds;
  const bars = Math.floor((duration - origin) / barSeconds + 1e-9);
  if (bars < MIN_BARS) return [];

  const kinds = chordPerBar(segments, origin, barSeconds, bars);
  const timeOf = (bar: number) => (bar <= 0 ? 0 : bar >= bars ? duration : origin + bar * barSeconds);

  let intro = 0;
  while (intro < bars && kinds[intro] < 0) intro++;
  if (intro < MIN_INTRO_BARS) intro = 0;
  if (bars - intro < MIN_BARS) return [];

  const blocks = Math.floor((bars - intro) / BLOCK_BARS);
  const runs: { from: number; to: number; hist: Float32Array }[] = [];
  for (let k = 0; k < blocks; k++) {
    const from = intro + k * BLOCK_BARS;
    const to = k === blocks - 1 ? bars : from + BLOCK_BARS;
    const hist = stepHistogram(kinds, from, to);
    const last = runs[runs.length - 1];
    if (last && cosine(last.hist, hist) >= SAME_PROGRESSION) {
      last.to = to;
      last.hist = stepHistogram(kinds, last.from, last.to);
    } else {
      runs.push({ from, to, hist });
    }
  }

  const sections: DetectedSection[] = [];
  if (intro > 0) sections.push({ start: 0, end: timeOf(intro), label: "Intro" });

  const centroids: Float32Array[] = [];
  runs.forEach((run, i) => {
    let letter = centroids.findIndex((c) => cosine(c, run.hist) >= SAME_PROGRESSION);
    if (letter < 0) {
      centroids.push(run.hist);
      letter = centroids.length - 1;
    }
    sections.push({
      start: i === 0 && intro === 0 ? 0 : timeOf(run.from),
      end: timeOf(run.to),
      label: String.fromCharCode(65 + (letter % 26)),
    });
  });
  return sections;
}
