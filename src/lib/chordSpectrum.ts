import { computeMagnitudeSpectrumDb } from "@giamat90/mps-core/spectrum";
import { chordVoicing, type ChordVoicing } from "./chordVoicing";

/** Window of the spectra: about 0.37 s at 44.1 kHz, 2.7 Hz per bin, enough to tell semitones apart down to the low guitar E. */
export const FFT_SIZE = 16384;
export const F_MIN = 55;
export const F_MAX = 3500;
/** Curves are drawn this far below their own highest peak. */
export const DB_RANGE = 60;
/** A note within this many cents of a frequency counts as being that frequency. */
const TOLERANCE_CENTS = 35;
/** A note this far under the strongest peak is called weak, not present. */
export const PRESENT_DB = -18;
const OVERTONES = 8;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** How the candidate chord is built: two partials like the Hear button, or eight falling off like a real instrument. */
export type Overtones = "pure" | "rich";

function toDb(power: number): number {
  return 10 * Math.log10(power + 1e-20);
}

/**
 * The mean spectrum of `samples` in dB: Blackman-windowed frames a quarter window apart, averaged as power
 * (so a note that rings through the stretch stands out from a pick noise that does not). Shorter than one
 * window is zero-padded.
 */
export function meanSpectrumDb(samples: Float32Array, fftSize = FFT_SIZE): Float32Array {
  const bins = fftSize / 2;
  const power = new Float64Array(bins);
  const hop = fftSize / 4;
  let frames = 0;
  const frame = new Float32Array(fftSize);
  for (let start = 0; start === 0 || start + fftSize <= samples.length; start += hop) {
    frame.fill(0);
    frame.set(samples.subarray(start, Math.min(start + fftSize, samples.length)));
    const db = computeMagnitudeSpectrumDb(frame, fftSize);
    for (let i = 0; i < bins; i++) power[i] += 10 ** (db[i] / 10);
    frames++;
  }
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) out[i] = toDb(power[i] / frames);
  return out;
}

/** The sound of `chord` as samples: its tones (and the bass) with `overtones` partials each. */
export function renderChord(
  voicing: ChordVoicing,
  sampleRate: number,
  length: number,
  overtones: Overtones,
): Float32Array {
  const out = new Float32Array(length);
  const notes = [voicing.bass, ...voicing.upper];
  const partials = overtones === "pure" ? [1, 0.3] : Array.from({ length: OVERTONES }, (_, h) => (h + 1) ** -0.9);
  for (const freq of notes) {
    partials.forEach((level, h) => {
      const f = freq * (h + 1);
      if (f >= sampleRate / 2) return;
      const step = (2 * Math.PI * f) / sampleRate;
      for (let i = 0; i < length; i++) out[i] += level * Math.sin(step * i);
    });
  }
  return out;
}

/** The spectrum of a synthetic chord, or null for a chord the synth does not know. */
export function candidateSpectrumDb(
  chord: string,
  bass: string | null | undefined,
  semitones: number,
  cents: number,
  sampleRate: number,
  overtones: Overtones,
): Float32Array | null {
  const voicing = chordVoicing(chord, bass, semitones, cents);
  if (voicing === null) return null;
  return meanSpectrumDb(renderChord(voicing, sampleRate, FFT_SIZE, overtones));
}

/**
 * One dB value per pixel column on a log-frequency axis, each the highest bin under the column (peaks
 * must not vanish when the curve is thinned), then moved so the curve's own highest point is 0 dB.
 */
export function columnCurve(db: Float32Array, sampleRate: number, columns: number): Float32Array {
  const binHz = sampleRate / (db.length * 2);
  const logMin = Math.log(F_MIN);
  const logMax = Math.log(F_MAX);
  const out = new Float32Array(columns);
  let top = -Infinity;
  for (let x = 0; x < columns; x++) {
    const lo = Math.exp(logMin + ((x - 0.5) / columns) * (logMax - logMin)) / binHz;
    const hi = Math.exp(logMin + ((x + 0.5) / columns) * (logMax - logMin)) / binHz;
    const from = Math.max(1, Math.floor(lo));
    const to = Math.min(db.length - 1, Math.max(from, Math.ceil(hi)));
    let peak = -Infinity;
    for (let i = from; i <= to; i++) if (db[i] > peak) peak = db[i];
    out[x] = peak;
    if (peak > top) top = peak;
  }
  for (let x = 0; x < columns; x++) out[x] -= top;
  return out;
}

export function noteName(freq: number, cents = 0): string {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440) - cents / 100);
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

interface Peak {
  freq: number;
  db: number;
}

/** Local maxima of the spectrum between F_MIN and F_MAX, strongest first, as dB under the strongest of them. */
export function spectrumPeaks(db: Float32Array, sampleRate: number): Peak[] {
  const binHz = sampleRate / (db.length * 2);
  const from = Math.max(2, Math.floor(F_MIN / binHz));
  const to = Math.min(db.length - 2, Math.ceil(F_MAX / binHz));
  const peaks: Peak[] = [];
  let top = -Infinity;
  for (let i = from; i <= to; i++) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1]) {
      const left = db[i - 1];
      const right = db[i + 1];
      const denom = left - 2 * db[i] + right;
      const shift = denom === 0 ? 0 : (0.5 * (left - right)) / denom;
      peaks.push({ freq: (i + shift) * binHz, db: db[i] });
      if (db[i] > top) top = db[i];
    }
  }
  return peaks.map((p) => ({ ...p, db: p.db - top })).sort((a, b) => b.db - a.db);
}

/** A peak this far under the tone it could be an overtone of is taken to be that overtone. */
const OVERTONE_MARGIN_DB = 8;
/** Overtones that can hide a note: the octave, fifth, double octave, third and fifth again. */
const HIDING_PARTIALS = [2, 3, 4, 5, 6];

/** Distance in semitones from `midi` to the nearest pitch that is `offset` semitones above the pitch class `pc`. */
function semitonesFrom(midi: number, pc: number, offset: number): number {
  const d = (((midi - pc - offset) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
}

export interface ToneReading {
  note: string;
  freq: number;
  /** The strongest peak within a third of a semitone of the note, in dB under the spectrum's strongest; null when there is none. */
  db: number | null;
  /** The note whose overtone this peak could be (it sits where one falls and is weaker by the usual amount), or null. */
  overtoneOf: string | null;
}

/** Whether a reading found the note itself, not nothing and not just an overtone of another note of the chord. */
export function isPresent(tone: ToneReading): boolean {
  return tone.db !== null && tone.db >= PRESENT_DB && !tone.overtoneOf;
}

/** For each tone of the chord (the bass and the notes above it, once each), how strongly the stretch has it. */
export function readTones(db: Float32Array, sampleRate: number, voicing: ChordVoicing, tuning: number): ToneReading[] {
  const peaks = spectrumPeaks(db, sampleRate);
  const seen = new Set<string>();
  const tones: ToneReading[] = [];
  for (const freq of [voicing.bass, ...voicing.upper]) {
    const note = noteName(freq, tuning);
    if (seen.has(note.replace(/\d+$/, ""))) continue;
    seen.add(note.replace(/\d+$/, ""));
    // The chord's tone in any octave: the loudest peak that lands on this pitch class.
    let best: number | null = null;
    for (const peak of peaks) {
      const nearest = noteName(peak.freq, tuning).replace(/\d+$/, "");
      if (nearest !== note.replace(/\d+$/, "")) continue;
      const midi = 69 + 12 * Math.log2(peak.freq / 440) - tuning / 100;
      if (Math.abs(midi - Math.round(midi)) > TOLERANCE_CENTS / 100) continue;
      if (best === null || peak.db > best) best = peak.db;
    }
    tones.push({ note: note.replace(/\d+$/, ""), freq, db: best, overtoneOf: null });
  }
  const pcs = tones.map((t) => NOTE_NAMES.indexOf(t.note));
  return tones.map((tone, i) => {
    if (tone.db === null) return tone;
    const host = tones.find((other, j) =>
      j !== i && other.db !== null && tone.db! <= other.db - OVERTONE_MARGIN_DB
      && HIDING_PARTIALS.some((h) => semitonesFrom(pcs[i], pcs[j], 12 * Math.log2(h)) <= TOLERANCE_CENTS / 100));
    return host ? { ...tone, overtoneOf: host.note } : tone;
  });
}

/**
 * The strongest peak the chord does not explain: not on one of its notes (in any octave) and not a weak
 * overtone of one. A note left over here is a note the candidate is missing (a B flat over C minor reads
 * as C minor 7, a D over C as sus2 or add9). `tones` are the readings of the chord's own notes.
 */
export function strongestExtra(
  db: Float32Array,
  sampleRate: number,
  tuning: number,
  tones: ToneReading[],
  floorDb = -24,
): { note: string; freq: number; db: number } | null {
  const pcs = tones.map((t) => NOTE_NAMES.indexOf(t.note));
  for (const peak of spectrumPeaks(db, sampleRate)) {
    if (peak.db < floorDb) return null;
    const midi = 69 + 12 * Math.log2(peak.freq / 440) - tuning / 100;
    if (Math.abs(midi - Math.round(midi)) > TOLERANCE_CENTS / 100) continue;
    if (pcs.some((pc) => semitonesFrom(midi, pc, 0) < 0.5)) continue;
    const overtone = tones.some((tone, i) =>
      tone.db !== null
      && peak.db <= tone.db - OVERTONE_MARGIN_DB
      && HIDING_PARTIALS.some((h) => semitonesFrom(midi, pcs[i], 12 * Math.log2(h)) <= TOLERANCE_CENTS / 100));
    if (!overtone) return { note: noteName(peak.freq, tuning), freq: peak.freq, db: peak.db };
  }
  return null;
}
