import { computeMagnitudeSpectrumDb } from "@giamat90/mps-core/spectrum";

/** The notes the roll covers: E1 to E6, bass guitar to the top of a guitar. */
export const MIDI_LOW = 28;
export const MIDI_HIGH = 88;
export const NOTE_COUNT = MIDI_HIGH - MIDI_LOW + 1;
export const ROLL_FFT = 16384;
/** Seconds between two frames of the matrix. */
export const ROLL_HOP = 0.125;
/** A note this far under the stem's strong notes is not drawn. */
export const ROLL_RANGE_DB = 40;
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

/**
 * One frame's note strengths from a magnitude spectrum in dB: the loudest bin in each note's band,
 * then the overtones of each note (from the lowest up) taken off the notes where they land, so a low
 * E does not also read as the B and E above it.
 */
export function frameStrengths(db: Float32Array, bands: Array<[number, number]>): Float64Array {
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
  return mag;
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
  const strengths = new Float64Array(frames * NOTE_COUNT);
  const frame = new Float32Array(ROLL_FFT);
  for (let f = 0; f < frames; f++) {
    const centre = f * hopSamples + hopSamples / 2;
    const from = Math.round(centre - ROLL_FFT / 2);
    frame.fill(0);
    for (let i = 0; i < ROLL_FFT; i++) {
      const at = from + i;
      if (at >= 0 && at < samples.length) frame[i] = samples[at];
    }
    strengths.set(frameStrengths(computeMagnitudeSpectrumDb(frame, ROLL_FFT), bands), f * NOTE_COUNT);
    if (f % 64 === 63) {
      onProgress?.(f / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const sorted = Float64Array.from(strengths).sort();
  const top = sorted[Math.floor(sorted.length * 0.995)] || 1e-9;
  const data = new Uint8Array(strengths.length);
  for (let i = 0; i < data.length; i++) {
    const db = 20 * Math.log10(Math.max(strengths[i], 1e-12) / top);
    data[i] = Math.max(0, Math.min(255, Math.round(255 * (1 + db / ROLL_RANGE_DB))));
  }
  onProgress?.(1);
  return { hop: ROLL_HOP, frames, data };
}

export function noteStrength(matrix: NoteMatrix, frame: number, midi: number): number {
  if (frame < 0 || frame >= matrix.frames || midi < MIDI_LOW || midi > MIDI_HIGH) return 0;
  return matrix.data[frame * NOTE_COUNT + (midi - MIDI_LOW)];
}
