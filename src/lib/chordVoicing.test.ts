import { describe, it, expect } from "vitest";
import { chordVoicing } from "./chordVoicing";
import { keyChords } from "./keyChords";

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

describe("chordVoicing", () => {
  it("voices C major as C E G around middle C with the root below", () => {
    const v = chordVoicing("C:maj", null)!;
    expect(v.upper.map((f) => Math.round(f * 100) / 100)).toEqual([hz(60), hz(64), hz(67)].map((f) => Math.round(f * 100) / 100));
    expect(v.bass).toBeCloseTo(hz(36), 6);
  });

  it("names the quality by its notes: minor, sevenths, sus, dim, aug and sixth", () => {
    const semis = (chord: string) => {
      const v = chordVoicing(chord, null)!;
      return v.upper.map((f) => Math.round(12 * Math.log2(f / v.upper[0])));
    };
    expect(semis("A:min")).toEqual([0, 3, 7]);
    expect(semis("G:7")).toEqual([0, 4, 7, 10]);
    expect(semis("F:maj7")).toEqual([0, 4, 7, 11]);
    expect(semis("D:min7")).toEqual([0, 3, 7, 10]);
    expect(semis("D:sus2")).toEqual([0, 2, 7]);
    expect(semis("D:sus4")).toEqual([0, 5, 7]);
    expect(semis("B:dim")).toEqual([0, 3, 6]);
    expect(semis("C:aug")).toEqual([0, 4, 8]);
    expect(semis("C:6")).toEqual([0, 4, 7, 9]);
  });

  it("keeps every root in the same register so roots can be compared by ear", () => {
    for (const root of ["C", "C#", "D", "F#", "G", "A#", "B"]) {
      const v = chordVoicing(`${root}:maj`, null)!;
      expect(v.upper[0]).toBeGreaterThan(hz(54));
      expect(v.upper[0]).toBeLessThan(hz(67));
      expect(v.bass).toBeLessThan(hz(48));
    }
  });

  it("puts a slash chord's own note in the bass", () => {
    const plain = chordVoicing("C:maj", null)!;
    const slash = chordVoicing("C:maj", "E")!;
    expect(slash.bass).toBeCloseTo(hz(36 + 4), 6);
    expect(slash.upper).toEqual(plain.upper);
  });

  it("moves into the sounding key by the transpose, bass included", () => {
    const up2 = chordVoicing("C:maj", "E", 2)!;
    const d = chordVoicing("D:maj", "F#")!;
    expect(up2.bass).toBeCloseTo(d.bass, 6);
    expect(up2.upper.map((f) => f.toFixed(3))).toEqual(d.upper.map((f) => f.toFixed(3)));
  });

  it("tunes to a recording that is not at concert pitch", () => {
    const flat = chordVoicing("A:min", null, 0, 0)!;
    const sharp = chordVoicing("A:min", null, 0, 29)!;
    for (let i = 0; i < flat.upper.length; i++) {
      expect(1200 * Math.log2(sharp.upper[i] / flat.upper[i])).toBeCloseTo(29, 6);
    }
    expect(1200 * Math.log2(sharp.bass / flat.bass)).toBeCloseTo(29, 6);
  });

  it("does not guess at a chord it does not know", () => {
    expect(chordVoicing("H:maj", null)).toBeNull();
    expect(chordVoicing("C:wat", null)).toBeNull();
    expect(chordVoicing("N", null)).toBeNull();
  });
});

describe("keyChords", () => {
  it("lists the chords of a major key", () => {
    expect(keyChords("C major")).toEqual(["C:maj", "D:min", "E:min", "F:maj", "G:maj", "A:min", "G:7", "B:dim"]);
  });

  it("lists the chords of a minor key, with the major dominant", () => {
    expect(keyChords("A minor")).toEqual(["A:min", "B:dim", "C:maj", "D:min", "E:min", "F:maj", "G:maj", "E:maj", "E:7"]);
  });

  it("moves with the transpose", () => {
    expect(keyChords("C major", 2)[0]).toBe("D:maj");
    expect(keyChords("A minor", -3)[0]).toBe("F#:min");
  });

  it("copes with a key that is missing or unknown", () => {
    expect(keyChords(undefined)).toEqual([]);
    expect(keyChords("Unknown")).toEqual([]);
    expect(keyChords("H major")).toEqual([]);
  });
});
