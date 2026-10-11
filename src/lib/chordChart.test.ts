import { describe, it, expect } from "vitest";
import { buildChordChart, formatClock } from "./chordChart";
import type { ChordSegment } from "./types";

const seg = (start: number, end: number, chord: string): ChordSegment => ({ start, end, chord });

describe("formatClock", () => {
  it.each([[0, "0:00"], [7.4, "0:07"], [65, "1:05"], [600, "10:00"]])("%s -> %s", (s, text) => {
    expect(formatClock(s)).toBe(text);
  });
});

describe("buildChordChart", () => {
  const segments = [
    seg(0, 4, "A:min"), seg(4, 8, "F:maj"), seg(8, 12, "C:maj"), seg(12, 16, "G:maj"), seg(16, 20, "A:min"),
  ];
  const base = { title: "My Song", key: "A minor", bpm: 120.4, segments, transpose: 0, capo: 0 };

  it("starts with the title, key and tempo", () => {
    const lines = buildChordChart(base).split("\n");
    expect(lines[0]).toBe("My Song");
    expect(lines[1]).toBe("Key: A minor   Tempo: 120 BPM");
  });

  it("lists four chords per line with their start time", () => {
    const text = buildChordChart(base);
    expect(text).toContain("0:00  Am     0:04  F      0:08  C      0:12  G");
    expect(text).toContain("0:16  Am");
  });

  it("shifts the chords and the key by the transpose", () => {
    const text = buildChordChart({ ...base, transpose: 2 });
    expect(text).toContain("Key: B minor");
    expect(text).toContain("0:00  Bm");
    expect(text).toContain("Transposed +2 semitones");
  });

  it("shows capo shapes, keeping the sounding key in the header", () => {
    const text = buildChordChart({ ...base, capo: 2 });
    expect(text).toContain("Key: A minor");
    expect(text).toContain("Capo 2: the chords below are the shapes to play");
    expect(text).toContain("0:00  Gm");
  });

  it("merges neighbouring segments with the same chord", () => {
    const text = buildChordChart({ ...base, segments: [seg(0, 2, "C:maj"), seg(2, 4, "C:maj"), seg(4, 6, "G:maj")] });
    expect(text).toContain("0:00  C      0:04  G");
  });

  it("copes with a song that has no key, no tempo and no chords", () => {
    const text = buildChordChart({ title: "Bare", key: undefined, bpm: undefined, segments: [], transpose: 0, capo: 0 });
    expect(text.split("\n")[0]).toBe("Bare");
    expect(text).toContain("No chords were detected");
  });
});
