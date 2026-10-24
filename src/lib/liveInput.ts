import { computeMagnitudeSpectrumDb } from "@giamat90/mps-core/spectrum";
import { FFT_SIZE } from "./chordSpectrum";
import { NOTE_COUNT, ROLL_HOP, frameStrengths, noteBands, strengthOf } from "./noteRoll";

/** Input quieter than this (RMS, dBFS) is room noise and a hum: nothing is drawn for it. */
export const GATE_DB = -60;
/** A sample this close to full scale means the interface is clipping. */
export const CLIP_LEVEL = 0.98;
/** Share of the previous spectrum kept in each new one (as power), so the curve settles instead of flickering. */
const KEEP = 0.5;
/** How fast the reference level of the notes falls when playing gets quieter, in dB per reading. */
const TOP_DECAY_DB = 0.4;

/** One look at the input: what the spectrum and the notes show for the last window of sound. */
export interface LiveReading {
  /** Smoothed spectrum in dB, FFT_SIZE / 2 bins; null while the input is under the gate. */
  db: Float32Array | null;
  sampleRate: number;
  /** NOTE_COUNT strengths, 0-255 like the saved notes of a stem; all zero under the gate. */
  notes: Uint8Array;
  levelDb: number;
  clipped: boolean;
}

export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
}

export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Index of the channel with the most sound: an instrument plugged into one input of a two-input interface leaves the other silent. */
export function loudestChannel(channels: readonly Float32Array[]): number {
  let best = 0;
  let bestDb = -Infinity;
  channels.forEach((samples, i) => {
    const db = rmsDb(samples);
    if (db > bestDb) {
      bestDb = db;
      best = i;
    }
  });
  return best;
}

/** `next` blended into `previous` as power, `keep` being the share of `previous`; with no previous spectrum, `next` itself. */
export function smoothSpectrum(previous: Float32Array | null, next: Float32Array, keep = KEEP): Float32Array {
  if (!previous || previous.length !== next.length) return Float32Array.from(next);
  const out = new Float32Array(next.length);
  for (let i = 0; i < next.length; i++) {
    out[i] = 10 * Math.log10(keep * 10 ** (previous[i] / 10) + (1 - keep) * 10 ** (next[i] / 10) + 1e-20);
  }
  return out;
}

/**
 * Turns successive windows of the input into readings. It remembers the last spectrum (to smooth it) and how loud
 * the playing has been (the notes are drawn against that, as a saved stem's are against its loudest).
 */
export class LiveAnalyser {
  private smoothed: Float32Array | null = null;
  private top = -Infinity;
  private bands: { sampleRate: number; table: Array<[number, number]> } | null = null;

  constructor(private readonly gateDb = GATE_DB) {}

  reset(): void {
    this.smoothed = null;
    this.top = -Infinity;
  }

  process(samples: Float32Array, sampleRate: number): LiveReading {
    const levelDb = rmsDb(samples);
    const clipped = peakOf(samples) >= CLIP_LEVEL;
    if (levelDb < this.gateDb) {
      this.reset();
      return { db: null, sampleRate, notes: new Uint8Array(NOTE_COUNT), levelDb, clipped };
    }
    // The newest FFT_SIZE samples: a longer buffer is read from its end, a shorter one is zero-padded by the FFT.
    const window = samples.length > FFT_SIZE ? samples.subarray(samples.length - FFT_SIZE) : samples;
    const raw = computeMagnitudeSpectrumDb(window, FFT_SIZE);
    if (this.bands?.sampleRate !== sampleRate) this.bands = { sampleRate, table: noteBands(sampleRate, FFT_SIZE) };
    const found = frameStrengths(raw, this.bands.table);
    this.top = Math.max(Math.max(...found.level), this.top - TOP_DECAY_DB);
    const notes = new Uint8Array(NOTE_COUNT);
    for (let n = 0; n < NOTE_COUNT; n++) notes[n] = strengthOf(found.contrast[n], found.level[n], this.top);
    this.smoothed = smoothSpectrum(this.smoothed, raw);
    return { db: this.smoothed, sampleRate, notes, levelDb, clipped };
  }
}

/**
 * The notes heard on the input, by frame of song time (the roll's own frames). Frames are written where the sound
 * belongs in the song, so a note played in time with the recording lands under the recording's note.
 */
export class LiveTrace {
  private readonly frames = new Map<number, Uint8Array>();

  constructor(private readonly maxFrames = 4800) {}

  get size(): number {
    return this.frames.size;
  }

  write(time: number, notes: Uint8Array): void {
    const frame = Math.floor(time / ROLL_HOP);
    if (frame < 0) return;
    this.frames.delete(frame);
    this.frames.set(frame, notes);
    if (this.frames.size > this.maxFrames) this.frames.delete(this.frames.keys().next().value as number);
  }

  /** Strength of note `index` (0 = the roll's lowest) in `frame`; 0 where nothing was heard. */
  strength(frame: number, index: number): number {
    return this.frames.get(frame)?.[index] ?? 0;
  }

  frame(frame: number): Uint8Array | undefined {
    return this.frames.get(frame);
  }

  clear(): void {
    this.frames.clear();
  }
}

/**
 * Where in the song the window just read belongs. While the song plays, what reaches the app now was played one
 * round trip ago (heard on the way out, played, and captured on the way in), and the window's sound is centred
 * half a window back. Paused, there is no timeline to be early or late on: it is the playhead.
 */
export function liveFrameTime(playing: boolean, playhead: number, sampleRate: number, latencyS: number): number {
  if (!playing) return playhead;
  return Math.max(0, playhead - latencyS - FFT_SIZE / 2 / sampleRate);
}

/** The recording latency calibrated for `deviceId`, in seconds; 0 when there is none or it no longer applies. */
export function calibratedLatencyS(
  offsets: Record<string, { offset: number; stale?: boolean }>,
  deviceId: string | null,
): number {
  const entry = offsets[deviceId ?? ""];
  return entry && !entry.stale && entry.offset > 0 ? entry.offset / 1000 : 0;
}

/** The colour of what the player plays, in the notes and on the spectrum: none of the stems' colours. */
export const LIVE_RGB = "244, 114, 182";

/** How full the level meter is for an RMS level: empty at the gate, full at 0 dBFS. */
export function levelFraction(levelDb: number): number {
  return Math.min(1, Math.max(0, (levelDb - GATE_DB) / -GATE_DB));
}

export interface InputNote {
  text: string;
  /** "bad" when the player has to do something (play, turn the level down), "info" otherwise. */
  tone: "info" | "bad";
}

/** What the monitor says about the input, or null when it is off. */
export function describeInput(
  status: "off" | "starting" | "on" | "error",
  label: string | null,
  error: string | null,
  reading: Pick<LiveReading, "levelDb" | "clipped"> | null,
): InputNote | null {
  if (status === "off") return null;
  if (status === "error") return { text: error ?? "The input could not be opened.", tone: "bad" };
  if (status === "starting") return { text: "Opening the input...", tone: "info" };
  if (!reading) return { text: `Listening to ${label || "the input"}`, tone: "info" };
  if (reading.clipped) return { text: "Too loud: the input is clipping. Turn the level down on the interface.", tone: "bad" };
  if (reading.levelDb < GATE_DB) return { text: "No sound on the input. Play something.", tone: "info" };
  return { text: `Listening to ${label || "the input"}`, tone: "info" };
}
