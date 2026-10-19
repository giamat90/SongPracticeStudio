import { describe, expect, it } from "vitest";
import { chordVoicing } from "./chordVoicing";
import { renderChord } from "./chordSpectrum";
import { computeNoteMatrix, noteStrength } from "./noteRoll";

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
