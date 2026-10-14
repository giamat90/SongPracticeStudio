import { describe, it, expect } from "vitest";
import type { ChordSegment } from "./types";
import {
  MIN_CHORD_SECONDS, addChordAt, deleteChordAt, joinWithNext, setChordAt, setChordEnd, setChordStart, splitChordAt,
} from "./chordEdit";

const seg = (start: number, end: number, chord: string, bass?: string): ChordSegment =>
  bass ? { start, end, chord, bass } : { start, end, chord };

/** C 0-4, G 4-8, a gap, A minor 10-12 */
const LIST = (): ChordSegment[] => [seg(0, 4, "C:maj"), seg(4, 8, "G:maj"), seg(10, 12, "A:min")];

describe("setChordAt", () => {
  it("renames one segment and leaves the others and the input alone", () => {
    const input = LIST();
    const out = setChordAt(input, 1, "D:7");
    expect(out.map((s) => s.chord)).toEqual(["C:maj", "D:7", "A:min"]);
    expect(input[1].chord).toBe("G:maj");
    expect(out[1]).toMatchObject({ start: 4, end: 8 });
  });

  it("sets and clears a slash bass", () => {
    const withBass = setChordAt(LIST(), 0, "C:maj", "E");
    expect(withBass[0].bass).toBe("E");
    const cleared = setChordAt(withBass, 0, "C:maj", null);
    expect("bass" in cleared[0]).toBe(false);
  });

  it("ignores an index that is not there", () => {
    const input = LIST();
    expect(setChordAt(input, 9, "D:maj")).toBe(input);
  });
});

describe("deleteChordAt", () => {
  it("removes one segment and keeps the gap it leaves", () => {
    const out = deleteChordAt(LIST(), 1);
    expect(out.map((s) => s.chord)).toEqual(["C:maj", "A:min"]);
  });

  it("ignores an index that is not there", () => {
    const input = LIST();
    expect(deleteChordAt(input, -1)).toBe(input);
    expect(deleteChordAt(input, 3)).toBe(input);
  });
});

describe("splitChordAt", () => {
  it("cuts a chord in two with the same name and bass", () => {
    const out = splitChordAt([seg(0, 4, "C:maj", "E")], 0, 1.5)!;
    expect(out).toEqual([seg(0, 1.5, "C:maj", "E"), seg(1.5, 4, "C:maj", "E")]);
  });

  it("refuses a cut too close to either edge", () => {
    expect(splitChordAt(LIST(), 0, MIN_CHORD_SECONDS / 2)).toBeNull();
    expect(splitChordAt(LIST(), 0, 4 - MIN_CHORD_SECONDS / 2)).toBeNull();
    expect(splitChordAt(LIST(), 0, 9)).toBeNull();
    expect(splitChordAt(LIST(), 5, 1)).toBeNull();
  });
});

describe("setChordStart", () => {
  it("drags the end of the chord before it along when they touch", () => {
    const out = setChordStart(LIST(), 1, 5);
    expect(out[0]).toMatchObject({ start: 0, end: 5 });
    expect(out[1]).toMatchObject({ start: 5, end: 8 });
  });

  it("stops where it would squeeze the previous chord below the minimum", () => {
    const out = setChordStart(LIST(), 1, 0.05);
    expect(out[0].end).toBeCloseTo(MIN_CHORD_SECONDS, 5);
    expect(out[0].end).toBe(out[1].start);
  });

  it("stops at the chord's own end", () => {
    const out = setChordStart(LIST(), 1, 99);
    expect(out[1].start).toBeCloseTo(8 - MIN_CHORD_SECONDS, 5);
  });

  it("cannot cross the chord before it across a gap, and can use the gap", () => {
    const toGap = setChordStart(LIST(), 2, 8.5);
    expect(toGap[2].start).toBe(8.5);
    expect(toGap[1].end).toBe(8);
    const below = setChordStart(LIST(), 2, 3);
    expect(below[2].start).toBe(8);
  });

  it("the first chord cannot start before zero", () => {
    expect(setChordStart(LIST(), 0, -3)[0].start).toBe(0);
  });

  it("rounds to the millisecond", () => {
    expect(setChordStart(LIST(), 1, 4.123456)[1].start).toBe(4.123);
  });
});

describe("setChordEnd", () => {
  it("drags the start of the chord after it along when they touch", () => {
    const out = setChordEnd(LIST(), 0, 3);
    expect(out[0]).toMatchObject({ start: 0, end: 3 });
    expect(out[1]).toMatchObject({ start: 3, end: 8 });
  });

  it("uses a gap and stops at the next chord's start", () => {
    const out = setChordEnd(LIST(), 1, 99);
    expect(out[1].end).toBe(10);
    expect(out[2].start).toBe(10);
  });

  it("the last chord is capped by the song length", () => {
    expect(setChordEnd(LIST(), 2, 99, 14)[2].end).toBe(14);
    expect(setChordEnd(LIST(), 2, 99)[2].end).toBe(99);
  });

  it("stops where it would leave the chord under the minimum", () => {
    expect(setChordEnd(LIST(), 0, 0)[0].end).toBeCloseTo(MIN_CHORD_SECONDS, 5);
  });
});

describe("joinWithNext", () => {
  it("absorbs the next chord, keeping the first one's name", () => {
    const out = joinWithNext(LIST(), 0);
    expect(out).toEqual([seg(0, 8, "C:maj"), seg(10, 12, "A:min")]);
  });

  it("does nothing on the last chord", () => {
    const input = LIST();
    expect(joinWithNext(input, 2)).toBe(input);
  });
});

describe("addChordAt", () => {
  it("fills a gap for a couple of seconds", () => {
    const out = addChordAt(LIST(), 8.5, "G:maj")!;
    expect(out.index).toBe(2);
    expect(out.segments[2]).toEqual(seg(8.5, 10, "G:maj"));
    expect(out.segments).toHaveLength(4);
  });

  it("is a couple of seconds long when there is room", () => {
    const out = addChordAt([seg(0, 4, "C:maj")], 6, "D:min")!;
    expect(out.segments[1]).toEqual(seg(6, 8, "D:min"));
    expect(out.index).toBe(1);
  });

  it("stops at the end of the song", () => {
    const out = addChordAt([seg(0, 4, "C:maj")], 6, "D:min", 7)!;
    expect(out.segments[1].end).toBe(7);
  });

  it("is refused inside a chord and where there is no room", () => {
    expect(addChordAt(LIST(), 2, "C:maj")).toBeNull();
    expect(addChordAt(LIST(), 4, "C:maj")).toBeNull();
    expect(addChordAt(LIST(), 9.95, "C:maj")).toBeNull();
    expect(addChordAt([], 3, "C:maj", 3.01)).toBeNull();
  });

  it("works on an empty list", () => {
    expect(addChordAt([], 1, "E:min")!.segments).toEqual([seg(1, 3, "E:min")]);
  });
});
