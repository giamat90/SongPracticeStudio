import { describe, it, expect } from "vitest";
import { CHORD_QUALITIES, formatChordName, isChordDetail, simplifyChord } from "./chordNames";

describe("simplifyChord", () => {
  it("leaves everything alone at the advanced level", () => {
    expect(simplifyChord("A:min7", "E", "advanced")).toEqual({ chord: "A:min7", bass: "E" });
    expect(simplifyChord("C:maj", undefined, "advanced")).toEqual({ chord: "C:maj", bass: null });
  });

  it("drops the bass note but keeps the seventh at the medium level", () => {
    expect(simplifyChord("C:maj7", "E", "medium")).toEqual({ chord: "C:maj7", bass: null });
  });

  it("reduces sevenths and sixths to their triad at the easy level", () => {
    expect(simplifyChord("G:7", null, "easy")).toEqual({ chord: "G:maj", bass: null });
    expect(simplifyChord("F:maj7", "A", "easy")).toEqual({ chord: "F:maj", bass: null });
    expect(simplifyChord("A:min7", null, "easy")).toEqual({ chord: "A:min", bass: null });
    expect(simplifyChord("C:6", null, "easy")).toEqual({ chord: "C:maj", bass: null });
  });

  it("keeps what a triad cannot say for it: sus, dim and aug are not turned into major or minor", () => {
    for (const quality of ["sus2", "sus4", "dim", "aug"]) {
      expect(simplifyChord(`D:${quality}`, null, "easy").chord).toBe(`D:${quality}`);
    }
  });

  it("returns a chord it does not understand as it is", () => {
    expect(simplifyChord("N", null, "easy")).toEqual({ chord: "N", bass: null });
  });
});

describe("isChordDetail", () => {
  it("accepts the three levels and nothing else", () => {
    expect(["easy", "medium", "advanced"].every(isChordDetail)).toBe(true);
    expect(isChordDetail("hard")).toBe(false);
    expect(isChordDetail(null)).toBe(false);
  });
});

describe("chord qualities", () => {
  it("offer the power chord, written E5", () => {
    expect(CHORD_QUALITIES.map((q) => q.value)).toContain("5");
    expect(formatChordName("E:5")).toBe("E5");
    expect(formatChordName("E:5", "B")).toBe("E5/B");
  });

  it("keep a power chord as it is at every level of detail", () => {
    expect(simplifyChord("E:5", "B", "easy")).toEqual({ chord: "E:5", bass: null });
    expect(simplifyChord("E:5", "B", "medium")).toEqual({ chord: "E:5", bass: null });
  });
});
