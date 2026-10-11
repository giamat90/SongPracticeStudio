import { describe, it, expect } from "vitest";
import { detectSections } from "./sections";
import type { ChordSegment } from "./types";

const BPM = 120;
const BAR = 2;

/** One chord per bar, starting at `startBar`. A null entry is a bar with no chord. */
function bars(startBar: number, chords: (string | null)[]): ChordSegment[] {
  const out: ChordSegment[] = [];
  chords.forEach((chord, i) => {
    if (chord === null) return;
    out.push({ start: (startBar + i) * BAR, end: (startBar + i + 1) * BAR, chord });
  });
  return out;
}

const repeat = <T,>(items: T[], times: number): T[] => Array.from({ length: times }, () => items).flat();

const VERSE = ["C:maj", "G:maj", "A:min", "F:maj"];
const CHORUS = ["F:maj", "F:maj", "C:maj", "G:7"];
const BRIDGE = ["D:min", "E:7", "A:min", "A:min7"];

function song(parts: string[][]): { segments: ChordSegment[]; duration: number } {
  const chords = parts.flat();
  return { segments: bars(0, chords), duration: chords.length * BAR };
}

const verse8 = repeat(VERSE, 2);
const chorus8 = repeat(CHORUS, 2);

describe("detectSections", () => {
  it("finds the boundaries of a verse / chorus form and gives repeats the same letter", () => {
    const { segments, duration } = song([verse8, chorus8, verse8, chorus8, verse8, chorus8]);
    const found = detectSections(segments, { duration, bpm: BPM });
    expect(found.map((s) => s.label)).toEqual(["A", "B", "A", "B", "A", "B"]);
    expect(found.map((s) => s.start)).toEqual([0, 16, 32, 48, 64, 80]);
    expect(found[found.length - 1].end).toBe(duration);
  });

  it("recognises a section that returns with a small variation as the same one", () => {
    const varied = [...verse8.slice(0, 7), "E:min"];
    const { segments, duration } = song([verse8, chorus8, varied, chorus8]);
    const found = detectSections(segments, { duration, bpm: BPM });
    expect(found.map((s) => s.label)).toEqual(["A", "B", "A", "B"]);
  });

  it("gives a third kind of section its own letter", () => {
    const bridge8 = repeat(BRIDGE, 2);
    const { segments, duration } = song([verse8, chorus8, bridge8, verse8, chorus8]);
    const found = detectSections(segments, { duration, bpm: BPM });
    expect(found.map((s) => s.label)).toEqual(["A", "B", "C", "A", "B"]);
  });

  it("reports one section for a song that is one loop", () => {
    const { segments, duration } = song([repeat(VERSE, 8)]);
    expect(detectSections(segments, { duration, bpm: BPM })).toEqual([{ start: 0, end: duration, label: "A" }]);
  });

  it("names silence before the first chord an intro", () => {
    const segments = [...bars(4, verse8), ...bars(12, chorus8), ...bars(20, verse8), ...bars(28, chorus8)];
    const found = detectSections(segments, { duration: 36 * BAR, bpm: BPM });
    expect(found[0]).toEqual({ start: 0, end: 8, label: "Intro" });
    expect(found.slice(1).map((s) => s.label)).toEqual(["A", "B", "A", "B"]);
  });

  it("keeps the sections contiguous and in order", () => {
    const { segments, duration } = song([verse8, chorus8, verse8, chorus8]);
    const found = detectSections(segments, { duration, bpm: BPM });
    expect(found[0].start).toBe(0);
    for (let i = 1; i < found.length; i++) expect(found[i].start).toBe(found[i - 1].end);
    expect(found[found.length - 1].end).toBe(duration);
  });

  it("counts bars from the downbeat", () => {
    const shifted = song([verse8, chorus8, verse8, chorus8]).segments.map((s) => ({ ...s, start: s.start + 1, end: s.end + 1 }));
    const found = detectSections(shifted, { duration: 64 * 0.5 * 2 + 1, bpm: BPM, offset: 1 });
    expect(found.map((s) => s.label)).toEqual(["A", "B", "A", "B"]);
    expect(found[1].start).toBe(17);
  });

  it("detects nothing without a usable tempo, a duration or enough bars", () => {
    const { segments, duration } = song([verse8, chorus8]);
    expect(detectSections(segments, { duration, bpm: 0 })).toEqual([]);
    expect(detectSections(segments, { duration: 0, bpm: BPM })).toEqual([]);
    expect(detectSections(bars(0, VERSE), { duration: 8, bpm: BPM })).toEqual([]);
    expect(detectSections([], { duration: 100, bpm: BPM })).toEqual([]);
  });

  it("does not split a section for a single odd bar", () => {
    const odd = [...verse8];
    odd[3] = "B:maj";
    const { segments, duration } = song([repeat(odd, 1), repeat(odd, 1), repeat(odd, 1), repeat(odd, 1)]);
    const found = detectSections(segments, { duration, bpm: BPM });
    expect(found).toHaveLength(1);
  });
});
