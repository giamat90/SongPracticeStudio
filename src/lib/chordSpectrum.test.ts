import { describe, expect, it } from "vitest";
import {
  PRESENT_DB, candidateSpectrumDb, columnCurve, isPresent, meanSpectrumDb, noteName, readTones, spectrumPeaks, strongestExtra,
} from "./chordSpectrum";
import { chordVoicing } from "./chordVoicing";

const SR = 44100;
const SIZE = 16384;

/** A tone per frequency, each with `partials` overtones falling off like a plucked string. */
function notes(freqs: number[], partials = 6): Float32Array {
  const out = new Float32Array(SIZE * 2);
  for (const f of freqs) {
    for (let h = 1; h <= partials; h++) {
      const step = (2 * Math.PI * f * h) / SR;
      for (let i = 0; i < out.length; i++) out[i] += (h ** -1) * Math.sin(step * i);
    }
  }
  return out;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const C3 = 48, Eb3 = 51, G3 = 55, Bb3 = 58, D4 = 62;

function analyse(freqs: number[], candidate: string) {
  const db = meanSpectrumDb(notes(freqs.map(hz)));
  const voicing = chordVoicing(candidate, null, 0, 0)!;
  const tones = readTones(db, SR, voicing, 0);
  return { db, tones, extra: strongestExtra(db, SR, 0, tones) };
}

describe("meanSpectrumDb", () => {
  it("puts the peak of a 440 Hz tone at 440 Hz", () => {
    const tone = new Float32Array(SIZE * 2).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / SR));
    const [top] = spectrumPeaks(meanSpectrumDb(tone), SR);
    expect(top.freq).toBeCloseTo(440, 0);
    expect(top.db).toBe(0);
  });

  it("takes a stretch shorter than a window without failing", () => {
    expect(meanSpectrumDb(new Float32Array(1000).fill(0.1)).length).toBe(SIZE / 2);
  });
});

describe("noteName", () => {
  it("names a frequency, allowing for a recording off A440", () => {
    expect(noteName(440)).toBe("A4");
    expect(noteName(261.63)).toBe("C4");
    expect(noteName(440 * 2 ** (30 / 1200), 30)).toBe("A4");
  });
});

describe("candidateSpectrumDb", () => {
  it("has a peak on every note of the chord", () => {
    const db = candidateSpectrumDb("C:min", null, 0, 0, SR, "rich")!;
    const names = spectrumPeaks(db, SR).filter((p) => p.db > -20).map((p) => noteName(p.freq).replace(/\d+$/, ""));
    expect(names).toEqual(expect.arrayContaining(["C", "D#", "G"]));
  });

  it("is null for a chord it does not know", () => {
    expect(candidateSpectrumDb("N", null, 0, 0, SR, "rich")).toBeNull();
  });
});

describe("the notes of a candidate in a recording", () => {
  it("finds all three notes of C minor played as C minor", () => {
    const { tones, extra } = analyse([C3, Eb3, G3], "C:min");
    expect(tones.map((t) => t.note)).toEqual(["C", "D#", "G"]);
    expect(tones.every((t) => t.db !== null && t.db >= PRESENT_DB)).toBe(true);
    expect(extra).toBeNull();
  });

  it("shows B flat left over when C minor is tried on C minor 7", () => {
    const { extra } = analyse([C3, Eb3, G3, Bb3], "C:min");
    expect(extra?.note.replace(/\d+$/, "")).toBe("A#");
  });

  it("leaves nothing over when C minor 7 is tried on C minor 7", () => {
    const { tones, extra } = analyse([C3, Eb3, G3, Bb3], "C:min7");
    expect(tones.every((t) => t.db !== null && t.db >= PRESENT_DB)).toBe(true);
    expect(extra).toBeNull();
  });

  it("finds the third missing and a D left over when C minor is tried on C sus2", () => {
    const { tones, extra } = analyse([C3, D4, G3], "C:min");
    const third = tones.find((t) => t.note === "D#")!;
    expect(third.db === null || third.db < PRESENT_DB).toBe(true);
    expect(extra?.note.replace(/\d+$/, "")).toBe("D");
  });

  it("tells major from minor: C major tried on C minor shows E as only an overtone and E flat left over", () => {
    const { tones, extra } = analyse([C3, Eb3, G3], "C:maj");
    const third = tones.find((t) => t.note === "E")!;
    // The E is there, but only as far under the C as its fifth overtone: it is not counted as a played note.
    expect(third.db === null || third.db < PRESENT_DB || third.overtoneOf === "C").toBe(true);
    expect(extra?.note.replace(/\d+$/, "")).toBe("D#");
  });
});

describe("columnCurve", () => {
  it("has one value per column with its highest point at 0 dB", () => {
    const db = candidateSpectrumDb("C:maj", null, 0, 0, SR, "pure")!;
    const curve = columnCurve(db, SR, 400);
    expect(curve.length).toBe(400);
    expect(Math.max(...curve)).toBeCloseTo(0, 5);
  });
});

describe("isPresent", () => {
  const tone = (db: number | null, overtoneOf: string | null = null) => ({ note: "E", freq: 330, db, overtoneOf });

  it("accepts a note found at or above the present level", () => {
    expect(isPresent(tone(0))).toBe(true);
    expect(isPresent(tone(PRESENT_DB))).toBe(true);
  });

  it("rejects a missing note, a weak one, and one that is only an overtone", () => {
    expect(isPresent(tone(null))).toBe(false);
    expect(isPresent(tone(PRESENT_DB - 1))).toBe(false);
    expect(isPresent(tone(-3, "C"))).toBe(false);
  });
});
