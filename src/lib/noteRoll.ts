import { computeMagnitudeSpectrumDb } from "@giamat90/mps-core/spectrum";
import { chordVoicing } from "./chordVoicing";

/** The notes the roll covers: E1 to E6, bass guitar to the top of a guitar. */
export const MIDI_LOW = 28;
export const MIDI_HIGH = 88;
export const NOTE_COUNT = MIDI_HIGH - MIDI_LOW + 1;
export const ROLL_FFT = 16384;
/** Seconds between two frames of the matrix. */
export const ROLL_HOP = 0.125;
/** A note this far above its neighbours is drawn at full strength. */
export const ROLL_RANGE_DB = 24;
/** A note's overtones are taken off the notes above it in these shares of its strength (partials 2 to 6). */
const OVERTONE_SHARE = [0, 0.55, 0.4, 0.3, 0.22, 0.16];
const BAND_CENTS = 45;

/** Strength of every note over time for one stem: 0 (silent) to 255 (as strong as the stem gets). */
export interface NoteMatrix {
  hop: number;
  frames: number;
  /** frames x NOTE_COUNT, row per frame. */
  data: Uint8Array;
}

export function midiFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Per-note [first, last] bin of an FFT, each note a band of +-BAND_CENTS around its pitch. */
export function noteBands(sampleRate: number, fftSize: number, cents = 0): Array<[number, number]> {
  const binHz = sampleRate / fftSize;
  const ratio = 2 ** (BAND_CENTS / 1200);
  const bands: Array<[number, number]> = [];
  for (let m = MIDI_LOW; m <= MIDI_HIGH; m++) {
    const f = midiFreq(m) * 2 ** (cents / 1200);
    const lo = Math.max(1, Math.ceil((f / ratio) / binHz));
    const hi = Math.max(lo, Math.floor((f * ratio) / binHz));
    bands.push([lo, hi]);
  }
  return bands;
}

/** How far a note must stand above the notes around it, in dB, to be drawn at all. */
export const MIN_CONTRAST_DB = 5;
/** Notes within this many semitones either side set the level a note is compared with. */
const NEIGHBOURS = 6;
const FLOOR_BELOW_TOP_DB = 30;
/** A note this far under the stem's loudest is silence, however clearly it stands out. */
const AUDIBLE_DB = 45;

/** One note's 0-255 strength from its contrast and level, `top` being the level of the loudest the signal gets. */
export function strengthOf(contrast: number, level: number, top: number): number {
  if (level < top - AUDIBLE_DB) return 0;
  return Math.min(255, Math.round((255 * contrast) / ROLL_RANGE_DB));
}

export interface FrameNotes {
  /** dB each note stands above the median of the notes around it (0 when it does not). */
  contrast: Float64Array;
  /** dB of each note's strength after its lower notes' overtones were taken off. */
  level: Float64Array;
}

function median(values: number[]): number {
  values.sort((x, y) => x - y);
  return values[values.length >> 1];
}

/**
 * One frame's notes from a magnitude spectrum in dB: the loudest bin in each note's band, the overtones of
 * each note (from the lowest up) taken off the notes where they land, so a low E does not also read as the B
 * and E above it, and then each note compared with the median of the notes around it. A distorted guitar
 * lights every band a little; only a note that stands clear of that level is a note being played.
 */
export function frameStrengths(db: Float32Array, bands: Array<[number, number]>): FrameNotes {
  const mag = new Float64Array(NOTE_COUNT);
  for (let n = 0; n < NOTE_COUNT; n++) {
    let peak = -Infinity;
    for (let i = bands[n][0]; i <= bands[n][1] && i < db.length; i++) if (db[i] > peak) peak = db[i];
    mag[n] = 10 ** (peak / 20);
  }
  for (let n = 0; n < NOTE_COUNT; n++) {
    const own = mag[n];
    if (own <= 0) continue;
    for (let h = 2; h <= 6; h++) {
      const at = n + Math.round(12 * Math.log2(h));
      if (at < NOTE_COUNT) mag[at] = Math.max(0, mag[at] - own * OVERTONE_SHARE[h - 1]);
    }
  }
  const level = new Float64Array(NOTE_COUNT);
  for (let n = 0; n < NOTE_COUNT; n++) level[n] = 20 * Math.log10(mag[n] + 1e-12);
  const contrast = new Float64Array(NOTE_COUNT);
  // Against a quiet neighbourhood a leftover of an overtone would look like a strong note, so the level
  // compared with never falls more than FLOOR_BELOW_TOP_DB under the frame's loudest note.
  const floorLimit = Math.max(...level) - FLOOR_BELOW_TOP_DB;
  for (let n = 0; n < NOTE_COUNT; n++) {
    const around: number[] = [];
    for (let k = Math.max(0, n - NEIGHBOURS); k <= Math.min(NOTE_COUNT - 1, n + NEIGHBOURS); k++) around.push(level[k]);
    const c = level[n] - Math.max(median(around), floorLimit);
    contrast[n] = c >= MIN_CONTRAST_DB ? c : 0;
  }
  return { contrast, level };
}

/** The note matrix of a mono signal. Calls `onProgress(0..1)` and yields to the UI now and then. */
export async function computeNoteMatrix(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (done: number) => void,
  cents = 0,
): Promise<NoteMatrix> {
  const hopSamples = Math.round(ROLL_HOP * sampleRate);
  const frames = Math.max(1, Math.floor(samples.length / hopSamples));
  const bands = noteBands(sampleRate, ROLL_FFT, cents);
  const contrast = new Float64Array(frames * NOTE_COUNT);
  const level = new Float64Array(frames * NOTE_COUNT);
  const frame = new Float32Array(ROLL_FFT);
  for (let f = 0; f < frames; f++) {
    const centre = f * hopSamples + hopSamples / 2;
    const from = Math.round(centre - ROLL_FFT / 2);
    frame.fill(0);
    for (let i = 0; i < ROLL_FFT; i++) {
      const at = from + i;
      if (at >= 0 && at < samples.length) frame[i] = samples[at];
    }
    const notes = frameStrengths(computeMagnitudeSpectrumDb(frame, ROLL_FFT), bands);
    contrast.set(notes.contrast, f * NOTE_COUNT);
    level.set(notes.level, f * NOTE_COUNT);
    if (f % 64 === 63) {
      onProgress?.(f / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const sorted = Float64Array.from(level).sort();
  const top = sorted[Math.floor(sorted.length * 0.995)];
  const data = new Uint8Array(contrast.length);
  for (let i = 0; i < data.length; i++) data[i] = strengthOf(contrast[i], level[i], top);
  onProgress?.(1);
  return { hop: ROLL_HOP, frames, data };
}

export function noteStrength(matrix: NoteMatrix, frame: number, midi: number): number {
  if (frame < 0 || frame >= matrix.frames || midi < MIDI_LOW || midi > MIDI_HIGH) return 0;
  return matrix.data[frame * NOTE_COUNT + (midi - MIDI_LOW)];
}

/** The pitch classes (0 = C) of a chord's notes and its slash bass, as they sound `shift` semitones higher; empty for a chord the synth does not know. */
export function chordPitchClasses(chord: string, bass: string | null | undefined, shift = 0): Set<number> {
  const voicing = chordVoicing(chord, bass, shift);
  if (!voicing) return new Set();
  return new Set([voicing.bass, ...voicing.upper].map((f) => (((Math.round(69 + 12 * Math.log2(f / 440))) % 12) + 12) % 12));
}

/** Bumped whenever the analysis changes, so a saved one from the older analysis is made again. */
export const NOTE_ROLL_VERSION = 1;

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface SavedRoll {
  /** Semitones the stems were shifted by when they were analysed; the roll moves its notes by the difference to the shift now. */
  transpose: number;
  matrices: Record<string, NoteMatrix>;
}

/** The analysed notes of every stem as the JSON text kept with the song. */
export function encodeRoll(matrices: Record<string, NoteMatrix>, transpose: number): string {
  const stems: Record<string, { frames: number; data: string }> = {};
  for (const [name, matrix] of Object.entries(matrices)) stems[name] = { frames: matrix.frames, data: toBase64(matrix.data) };
  return JSON.stringify({ version: NOTE_ROLL_VERSION, hop: ROLL_HOP, notes: NOTE_COUNT, transpose, stems });
}

/** The notes saved with a song, or null when the text is not a roll of this analysis (another version, hop or range, or damaged). */
export function decodeRoll(text: string): SavedRoll | null {
  try {
    const doc = JSON.parse(text) as {
      version?: number; hop?: number; notes?: number; transpose?: number;
      stems?: Record<string, { frames?: number; data?: string }>;
    };
    if (doc.version !== NOTE_ROLL_VERSION || doc.hop !== ROLL_HOP || doc.notes !== NOTE_COUNT) return null;
    if (typeof doc.transpose !== "number" || !doc.stems) return null;
    const matrices: Record<string, NoteMatrix> = {};
    for (const [name, stem] of Object.entries(doc.stems)) {
      if (typeof stem.frames !== "number" || typeof stem.data !== "string") return null;
      const data = fromBase64(stem.data);
      if (data.length !== stem.frames * NOTE_COUNT) return null;
      matrices[name] = { hop: ROLL_HOP, frames: stem.frames, data };
    }
    return Object.keys(matrices).length > 0 ? { transpose: doc.transpose, matrices } : null;
  } catch (e) {
    console.warn("[noteRoll] the saved notes could not be read:", e);
    return null;
  }
}
