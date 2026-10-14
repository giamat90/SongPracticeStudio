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

  it("writes sevenths and slash chords, shifted with the rest", () => {
    const segments = [seg(0, 4, "A:min7"), seg(4, 8, "C:maj"), seg(8, 12, "G:7")];
    segments[1].bass = "E";
    const text = buildChordChart({ ...base, segments, transpose: 2 });
    expect(text).toContain("0:00  Bm7");
    expect(text).toContain("0:04  D/F#");
    expect(text).toContain("0:08  A7");
  });

  it("prints triads only at the easy level, which also merges what then reads the same", () => {
    const segments = [seg(0, 4, "A:min7"), seg(4, 8, "A:min"), seg(8, 12, "C:maj7"), seg(12, 16, "G:7")];
    segments[2].bass = "E";
    const text = buildChordChart({ ...base, segments, detail: "easy" });
    expect(text).toContain("0:00  Am     0:08  C      0:12  G");
    expect(text).not.toContain("m7");
    expect(text).not.toContain("/E");
  });

  it("keeps sevenths but drops the bass note at the medium level", () => {
    const segments = [seg(0, 4, "C:maj7"), seg(4, 8, "G:7")];
    segments[0].bass = "E";
    const text = buildChordChart({ ...base, segments, detail: "medium" });
    expect(text).toContain("0:00  Cmaj7  0:04  G7");
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
