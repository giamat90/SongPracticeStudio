import { describe, it, expect, vi } from "vitest";
import type { ChordSegment } from "./types";

vi.mock("../stores/player", () => ({ usePlayerStore: () => 0 }));
vi.mock("./tauri", () => ({ readSongChords: vi.fn() }));

import { findActiveChordIndex, findNearestChordIndex, formatChordName } from "./chords";

const seg = (start: number, end: number, chord: string): ChordSegment => ({ start, end, chord });
const SEGMENTS = [seg(2, 4, "C:maj"), seg(4, 6, "A:min"), seg(8, 9, "G:maj")];

describe("formatChordName", () => {
  it.each([
    ["C:maj", "C"],
    ["A:min", "Am"],
    ["F#:maj", "F#"],
    ["C#:min", "C#m"],
    ["G", "G"],
  ])("%s -> %s", (input, expected) => expect(formatChordName(input)).toBe(expected));
});

describe("findActiveChordIndex", () => {
  it("returns -1 for no segments", () => expect(findActiveChordIndex([], 1)).toBe(-1));

  it("finds the segment containing the time", () => {
    expect(findActiveChordIndex(SEGMENTS, 2.5)).toBe(0);
    expect(findActiveChordIndex(SEGMENTS, 5)).toBe(1);
    expect(findActiveChordIndex(SEGMENTS, 8.5)).toBe(2);
  });

  it("treats a segment as [start, end): the boundary belongs to the next chord", () => {
    expect(findActiveChordIndex(SEGMENTS, 2)).toBe(0);
    expect(findActiveChordIndex(SEGMENTS, 4)).toBe(1);
    expect(findActiveChordIndex(SEGMENTS, 6)).toBe(-1);
  });

  it("returns -1 before the first chord, in a gap and after the last", () => {
    expect(findActiveChordIndex(SEGMENTS, 0)).toBe(-1);
    expect(findActiveChordIndex(SEGMENTS, 7)).toBe(-1);
    expect(findActiveChordIndex(SEGMENTS, 9)).toBe(-1);
    expect(findActiveChordIndex(SEGMENTS, 100)).toBe(-1);
  });

  it("agrees with a linear scan on a long, gap-riddled list", () => {
    const many: ChordSegment[] = [];
    for (let i = 0; i < 200; i++) many.push(seg(i * 3, i * 3 + 2, "C:maj"));
    for (let t = 0; t < 610; t += 0.25) {
      const expected = many.findIndex((s) => t >= s.start && t < s.end);
      expect(findActiveChordIndex(many, t)).toBe(expected);
    }
  });
});

describe("findNearestChordIndex", () => {
  it("returns -1 for no segments", () => expect(findNearestChordIndex([], 3)).toBe(-1));

  it("returns the active segment when there is one", () => {
    expect(findNearestChordIndex(SEGMENTS, 5)).toBe(1);
  });

  it("points at the next chord during leading silence and gaps", () => {
    expect(findNearestChordIndex(SEGMENTS, 0)).toBe(0);
    expect(findNearestChordIndex(SEGMENTS, 7)).toBe(2);
  });

  it("sticks to the last chord once playback runs past the end", () => {
    expect(findNearestChordIndex(SEGMENTS, 30)).toBe(2);
  });
});
