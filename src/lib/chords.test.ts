import { describe, it, expect, vi } from "vitest";
import type { ChordSegment } from "./types";

vi.mock("../stores/player", () => ({ usePlayerStore: () => 0 }));
vi.mock("./tauri", () => ({ readSongChords: vi.fn() }));

import {
  LOW_CONFIDENCE, findActiveChordIndex, findNearestChordIndex, formatChordName, isUnsure, transposeChord, transposeKey, transposeNote,
} from "./chords";

const seg = (start: number, end: number, chord: string): ChordSegment => ({ start, end, chord });
const SEGMENTS = [seg(2, 4, "C:maj"), seg(4, 6, "A:min"), seg(8, 9, "G:maj")];

describe("formatChordName", () => {
  it.each([
    ["C:maj", "C"],
    ["A:min", "Am"],
    ["F#:maj", "F#"],
    ["C#:min", "C#m"],
    ["G", "G"],
    ["G:7", "G7"],
    ["C:maj7", "Cmaj7"],
    ["A:min7", "Am7"],
    ["F#:min7", "F#m7"],
    ["D:sus2", "Dsus2"],
    ["D:sus4", "Dsus4"],
    ["B:dim", "Bdim"],
    ["C:aug", "Caug"],
    ["G:6", "G6"],
  ])("%s -> %s", (input, expected) => expect(formatChordName(input)).toBe(expected));

  it("adds the bass note of a slash chord", () => {
    expect(formatChordName("C:maj", "E")).toBe("C/E");
    expect(formatChordName("A:min7", "G")).toBe("Am7/G");
  });

  it("ignores a missing bass note", () => {
    expect(formatChordName("C:maj", null)).toBe("C");
    expect(formatChordName("C:maj", undefined)).toBe("C");
  });
});

describe("transposeNote", () => {
  it.each([["E", 2, "F#"], ["C", -1, "B"], ["A#", 14, "C"]])("%s by %i is %s", (n, s, e) => {
    expect(transposeNote(n, s)).toBe(e);
  });

  it("leaves what is not a note alone", () => {
    expect(transposeNote("H", 3)).toBe("H");
  });
});

describe("transposeChord with sevenths", () => {
  it("keeps the quality", () => {
    expect(transposeChord("A:min7", 3)).toBe("C:min7");
    expect(transposeChord("G:7", 2)).toBe("A:7");
  });
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

describe("transposeChord", () => {
  it.each([
    ["C:maj", 0, "C:maj"],
    ["C:maj", 2, "D:maj"],
    ["A:min", 3, "C:min"],
    ["A#:maj", 1, "B:maj"],
    ["B:maj", 1, "C:maj"],
    ["C:maj", -1, "B:maj"],
    ["C:maj", -6, "F#:maj"],
    ["C:maj", 14, "D:maj"],
  ])("%s by %i is %s", (chord, n, expected) => {
    expect(transposeChord(chord, n)).toBe(expected);
  });

  it("leaves the no-chord label and unknown roots alone", () => {
    expect(transposeChord("N", 3)).toBe("N");
    expect(transposeChord("H:maj", 3)).toBe("H:maj");
  });
});

describe("transposeKey", () => {
  it.each([
    ["C major", 2, "D major"],
    ["A minor", -3, "F# minor"],
    ["G# minor", 4, "C minor"],
    ["C major", 0, "C major"],
  ])("%s by %i is %s", (key, n, expected) => {
    expect(transposeKey(key, n)).toBe(expected);
  });

  it("returns an unparseable key unchanged", () => {
    expect(transposeKey("unknown", 2)).toBe("unknown");
  });
});

describe("isUnsure", () => {
  const seg = (confidence?: number) => ({ start: 0, end: 1, chord: "C:maj", ...(confidence === undefined ? {} : { confidence }) });

  it("flags a chord the detector fit poorly", () => {
    expect(isUnsure(seg(0.6))).toBe(true);
    expect(isUnsure(seg(LOW_CONFIDENCE - 0.01))).toBe(true);
  });

  it("does not flag a good fit, the threshold itself, or a chord with no confidence", () => {
    expect(isUnsure(seg(0.9))).toBe(false);
    expect(isUnsure(seg(LOW_CONFIDENCE))).toBe(false);
    expect(isUnsure(seg())).toBe(false);
  });
});
