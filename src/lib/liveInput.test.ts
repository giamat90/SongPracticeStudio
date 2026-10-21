import { describe, expect, it } from "vitest";
import { FFT_SIZE, renderChord } from "./chordSpectrum";
import { chordVoicing } from "./chordVoicing";
import {
  CLIP_LEVEL, GATE_DB, LiveAnalyser, LiveTrace, calibratedLatencyS, describeInput, levelFraction, liveFrameTime, loudestChannel,
  peakOf, rmsDb, smoothSpectrum,
} from "./liveInput";
import { MIDI_LOW, NOTE_COUNT, ROLL_HOP, chordPitchClasses, strengthOf } from "./noteRoll";

const SR = 44100;

function sine(freq: number, length = FFT_SIZE, amplitude = 0.3): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function chord(name: string, amplitude = 0.05): Float32Array {
  const voicing = chordVoicing(name, null, 0, 0)!;
  const out = renderChord(voicing, SR, FFT_SIZE, "rich");
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  return out.map((v) => (v / peak) * amplitude);
}

/** Pitch classes of the notes above C3 stronger than `over`: below that a semitone is only a few Hz wide and neighbours blur into each other. */
const litPitchClasses = (notes: Uint8Array, over: number) =>
  new Set(Array.from(notes).flatMap((v, i) => (v > over && MIDI_LOW + i >= 48 ? [(MIDI_LOW + i) % 12] : [])));

describe("levels", () => {
  it("measures a sine's RMS in dBFS", () => {
    expect(rmsDb(sine(220, FFT_SIZE, 1))).toBeCloseTo(-3.01, 1);
  });

  it("measures silence as far under the gate", () => {
    expect(rmsDb(new Float32Array(FFT_SIZE))).toBeLessThan(GATE_DB);
    expect(rmsDb(new Float32Array(0))).toBe(-Infinity);
  });

  it("finds the peak of either sign", () => {
    expect(peakOf(Float32Array.of(0.1, -0.7, 0.4))).toBeCloseTo(0.7);
  });

  it("picks the channel that carries the sound", () => {
    const silent = new Float32Array(FFT_SIZE);
    expect(loudestChannel([silent, sine(220)])).toBe(1);
    expect(loudestChannel([sine(220), silent])).toBe(0);
    expect(loudestChannel([silent, silent])).toBe(0);
  });
});

describe("smoothSpectrum", () => {
  it("starts from the first spectrum and returns a copy", () => {
    const first = Float32Array.of(-20, -30);
    const out = smoothSpectrum(null, first);
    expect(Array.from(out)).toEqual([-20, -30]);
    expect(out).not.toBe(first);
  });

  it("blends as power: equal spectra stay put, a jump is met half way in power", () => {
    expect(smoothSpectrum(Float32Array.of(-20), Float32Array.of(-20))[0]).toBeCloseTo(-20, 5);
    const blended = smoothSpectrum(Float32Array.of(0), Float32Array.of(-100), 0.5)[0];
    expect(blended).toBeCloseTo(10 * Math.log10(0.5), 3);
  });

  it("restarts when the length changes", () => {
    expect(smoothSpectrum(Float32Array.of(0, 0, 0), Float32Array.of(-10, -10)).length).toBe(2);
  });
});

describe("LiveAnalyser", () => {
  it("gives an empty reading under the gate and forgets what came before", () => {
    const analyser = new LiveAnalyser();
    expect(analyser.process(chord("C:maj"), SR).db).not.toBeNull();
    const quiet = analyser.process(new Float32Array(FFT_SIZE), SR);
    expect(quiet.db).toBeNull();
    expect(Array.from(quiet.notes).every((v) => v === 0)).toBe(true);
    expect(quiet.levelDb).toBeLessThan(GATE_DB);
  });

  it("lights the note of a single played string", () => {
    const reading = new LiveAnalyser().process(sine(220), SR);
    const a3 = 57 - MIDI_LOW;
    expect(reading.notes[a3]).toBeGreaterThan(200);
    expect(Array.from(reading.notes).filter((v) => v > 100)).toHaveLength(1);
  });

  it("lights every note of a strummed chord at full strength, and its overtones fainter", () => {
    const reading = new LiveAnalyser().process(chord("C:maj"), SR);
    const wanted = chordPitchClasses("C:maj", null);
    expect(litPitchClasses(reading.notes, 200)).toEqual(wanted);
    expect(litPitchClasses(reading.notes, 20).size).toBeGreaterThanOrEqual(wanted.size);
  });

  it("tells a minor chord from a major one by the third", () => {
    const major = new LiveAnalyser().process(chord("C:maj"), SR);
    const minor = new LiveAnalyser().process(chord("C:min"), SR);
    expect(litPitchClasses(major.notes, 100).has(4)).toBe(true);
    expect(litPitchClasses(major.notes, 100).has(3)).toBe(false);
    expect(litPitchClasses(minor.notes, 100).has(3)).toBe(true);
    expect(litPitchClasses(minor.notes, 100).has(4)).toBe(false);
  });

  it("returns a spectrum with a peak where the sound is", () => {
    const reading = new LiveAnalyser().process(sine(440), SR);
    const db = reading.db!;
    let top = 0;
    for (let i = 1; i < db.length; i++) if (db[i] > db[top]) top = i;
    expect((top * SR) / FFT_SIZE).toBeGreaterThan(430);
    expect((top * SR) / FFT_SIZE).toBeLessThan(450);
    expect(reading.sampleRate).toBe(SR);
  });

  it("reads the newest window of a longer buffer", () => {
    const old = sine(110, FFT_SIZE);
    const fresh = sine(220, FFT_SIZE);
    const both = new Float32Array(FFT_SIZE * 2);
    both.set(old, 0);
    both.set(fresh, FFT_SIZE);
    const notes = new LiveAnalyser().process(both, SR).notes;
    expect(notes[57 - MIDI_LOW]).toBeGreaterThan(200);
    expect(notes[45 - MIDI_LOW]).toBe(0);
  });

  it("flags clipping", () => {
    expect(new LiveAnalyser().process(sine(220, FFT_SIZE, CLIP_LEVEL + 0.01), SR).clipped).toBe(true);
    expect(new LiveAnalyser().process(sine(220, FFT_SIZE, 0.3), SR).clipped).toBe(false);
  });

  it("draws a quieter passage against the louder one before it, then forgets it as it fades", () => {
    const analyser = new LiveAnalyser();
    analyser.process(sine(220, FFT_SIZE, 0.5), SR);
    const soft = sine(330, FFT_SIZE, 0.002);
    expect(analyser.process(soft, SR).notes[64 - MIDI_LOW]).toBe(0);
    let last = 0;
    for (let i = 0; i < 200; i++) last = analyser.process(soft, SR).notes[64 - MIDI_LOW];
    expect(last).toBeGreaterThan(200);
  });

  it("keeps the same scale as the saved notes", () => {
    expect(strengthOf(24, -10, -10)).toBe(255);
    expect(strengthOf(12, -10, -10)).toBe(128);
    expect(strengthOf(24, -60, -10)).toBe(0);
  });

  it("returns NOTE_COUNT strengths", () => {
    expect(new LiveAnalyser().process(sine(220), SR).notes).toHaveLength(NOTE_COUNT);
  });
});

describe("LiveTrace", () => {
  it("keeps what was written in the frame of its time and reads zero elsewhere", () => {
    const trace = new LiveTrace();
    const notes = new Uint8Array(NOTE_COUNT);
    notes[5] = 200;
    trace.write(1.0, notes);
    const frame = Math.floor(1.0 / ROLL_HOP);
    expect(trace.strength(frame, 5)).toBe(200);
    expect(trace.strength(frame + 1, 5)).toBe(0);
    expect(trace.strength(frame, 6)).toBe(0);
  });

  it("lets a later write in the same frame replace the earlier one", () => {
    const trace = new LiveTrace();
    trace.write(2.01, Uint8Array.of(9));
    trace.write(2.05, Uint8Array.of(4));
    expect(trace.size).toBe(1);
    expect(trace.strength(Math.floor(2.05 / ROLL_HOP), 0)).toBe(4);
  });

  it("ignores a time before the song starts", () => {
    const trace = new LiveTrace();
    trace.write(-0.5, Uint8Array.of(1));
    expect(trace.size).toBe(0);
  });

  it("drops the oldest frames beyond its limit", () => {
    const trace = new LiveTrace(3);
    for (let f = 0; f < 5; f++) trace.write(f * ROLL_HOP, Uint8Array.of(f + 1));
    expect(trace.size).toBe(3);
    expect(trace.frame(0)).toBeUndefined();
    expect(trace.frame(4)?.[0]).toBe(5);
  });

  it("clears", () => {
    const trace = new LiveTrace();
    trace.write(1, Uint8Array.of(1));
    trace.clear();
    expect(trace.size).toBe(0);
  });
});

describe("liveFrameTime", () => {
  it("is the playhead while paused", () => {
    expect(liveFrameTime(false, 12.5, SR, 0.2)).toBe(12.5);
  });

  it("moves back by the round trip and half a window while playing", () => {
    expect(liveFrameTime(true, 12.5, SR, 0.2)).toBeCloseTo(12.5 - 0.2 - FFT_SIZE / 2 / SR, 6);
  });

  it("does not go before the start of the song", () => {
    expect(liveFrameTime(true, 0.1, SR, 0.2)).toBe(0);
  });
});

describe("calibratedLatencyS", () => {
  it("uses the device's calibration in seconds", () => {
    expect(calibratedLatencyS({ a: { offset: 180 } }, "a")).toBeCloseTo(0.18);
  });

  it("reads the default device's entry for no id", () => {
    expect(calibratedLatencyS({ "": { offset: 100 } }, null)).toBeCloseTo(0.1);
  });

  it("is zero without a calibration, with a stale one or with a non-positive one", () => {
    expect(calibratedLatencyS({}, "a")).toBe(0);
    expect(calibratedLatencyS({ a: { offset: 180, stale: true } }, "a")).toBe(0);
    expect(calibratedLatencyS({ a: { offset: 0 } }, "a")).toBe(0);
  });
});

describe("levelFraction", () => {
  it("is empty at the gate and full at 0 dBFS, and stays within them", () => {
    expect(levelFraction(GATE_DB)).toBe(0);
    expect(levelFraction(0)).toBe(1);
    expect(levelFraction(GATE_DB / 2)).toBeCloseTo(0.5);
    expect(levelFraction(-120)).toBe(0);
    expect(levelFraction(6)).toBe(1);
  });
});

describe("describeInput", () => {
  const heard = { levelDb: -30, clipped: false };

  it("says nothing while off", () => {
    expect(describeInput("off", null, null, null)).toBeNull();
  });

  it("shows the error as something to act on", () => {
    expect(describeInput("error", null, "Input unavailable: busy", null)).toEqual({ text: "Input unavailable: busy", tone: "bad" });
    expect(describeInput("error", null, null, null)?.text).toMatch(/could not be opened/);
  });

  it("says it is opening", () => {
    expect(describeInput("starting", null, null, null)?.text).toMatch(/Opening/);
  });

  it("names the device it listens to, before and after the first reading", () => {
    expect(describeInput("on", "Focusrite", null, null)?.text).toBe("Listening to Focusrite");
    expect(describeInput("on", "Focusrite", null, heard)?.text).toBe("Listening to Focusrite");
    expect(describeInput("on", "", null, heard)?.text).toBe("Listening to the input");
  });

  it("asks for sound when there is none", () => {
    expect(describeInput("on", "Focusrite", null, { levelDb: -90, clipped: false })).toEqual({
      text: "No sound on the input. Play something.",
      tone: "info",
    });
  });

  it("warns about clipping before anything else", () => {
    const note = describeInput("on", "Focusrite", null, { levelDb: -3, clipped: true });
    expect(note?.tone).toBe("bad");
    expect(note?.text).toMatch(/clipping/);
  });
});
