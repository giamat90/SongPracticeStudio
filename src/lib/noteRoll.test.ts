import { describe, expect, it } from "vitest";
import { chordVoicing } from "./chordVoicing";
import { renderChord } from "./chordSpectrum";
import { NOTE_COUNT, NOTE_ROLL_VERSION, chordPitchClasses, computeNoteMatrix, decodeRoll, encodeRoll, noteStrength } from "./noteRoll";

const RATE = 22050;

async function roll(chord: string) {
  const voicing = chordVoicing(chord, null)!;
  return computeNoteMatrix(renderChord(voicing, RATE, RATE * 3, "rich"), RATE);
}

describe("computeNoteMatrix", () => {
  it("puts the strength on the notes of the chord and not on its overtones", async () => {
    const m = await roll("C:maj");
    const frame = 10;
    for (const midi of [36, 60, 64, 67]) expect(noteStrength(m, frame, midi)).toBeGreaterThan(200);
    for (const midi of [61, 62, 63, 66, 68]) expect(noteStrength(m, frame, midi)).toBeLessThan(120);
    expect(noteStrength(m, frame, 55)).toBeLessThan(120);
  });

  it("tells a minor third from a major one", async () => {
    const m = await roll("C:min");
    expect(noteStrength(m, 10, 63)).toBeGreaterThan(200);
    expect(noteStrength(m, 10, 64)).toBeLessThan(120);
  });

  it("is zero outside the covered range", async () => {
    const m = await roll("C:maj");
    expect(noteStrength(m, 10, 20)).toBe(0);
    expect(noteStrength(m, 999, 60)).toBe(0);
  });
});

describe("chordPitchClasses", () => {
  it("lists the notes of the chord as pitch classes", () => {
    expect([...chordPitchClasses("C:maj", null)].sort((a, b) => a - b)).toEqual([0, 4, 7]);
    expect([...chordPitchClasses("A:min7", null)].sort((a, b) => a - b)).toEqual([0, 4, 7, 9]);
  });

  it("adds a slash bass that is not in the voicing and follows the shift", () => {
    expect(chordPitchClasses("C:maj", "D", 0).has(2)).toBe(true);
    expect([...chordPitchClasses("C:maj", null, 2)].sort((a, b) => a - b)).toEqual([2, 6, 9]);
  });

  it("is empty for a chord it does not know", () => {
    expect(chordPitchClasses("N", null).size).toBe(0);
  });
});

describe("saved roll", () => {
  const sample = () => ({ hop: 0.125, frames: 3, data: Uint8Array.from({ length: 3 * NOTE_COUNT }, (_, i) => i % 256) });

  it("comes back as it went in", () => {
    const back = decodeRoll(encodeRoll({ guitar: sample() }, 2));
    expect(back?.transpose).toBe(2);
    expect(back?.matrices.guitar.frames).toBe(3);
    expect([...back!.matrices.guitar.data]).toEqual([...sample().data]);
  });

  it("is refused when it is from another version of the analysis", () => {
    const doc = JSON.parse(encodeRoll({ guitar: sample() }, 0));
    expect(decodeRoll(JSON.stringify({ ...doc, version: NOTE_ROLL_VERSION + 1 }))).toBeNull();
  });

  it("is refused when it is damaged or empty", () => {
    expect(decodeRoll("{{")).toBeNull();
    expect(decodeRoll("{}")).toBeNull();
    const doc = JSON.parse(encodeRoll({ guitar: sample() }, 0));
    doc.stems.guitar.frames = 4;
    expect(decodeRoll(JSON.stringify(doc))).toBeNull();
    expect(decodeRoll(encodeRoll({}, 0))).toBeNull();
  });

  it("holds the matrices of a whole song without a stack overflow", () => {
    const long = { hop: 0.125, frames: 4000, data: new Uint8Array(4000 * NOTE_COUNT).fill(7) };
    expect(decodeRoll(encodeRoll({ bass: long }, 0))?.matrices.bass.frames).toBe(4000);
  });
});
