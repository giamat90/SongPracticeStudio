import { describe, expect, it } from "vitest";
import { mapBlocks, mapTime } from "./chordMap";

describe("mapBlocks", () => {
  it("lays the chords across the width in proportion to their time", () => {
    const blocks = mapBlocks([{ start: 0, end: 25 }, { start: 25, end: 100 }], 100, 400);
    expect(blocks).toEqual([{ index: 0, x0: 0, x1: 100 }, { index: 1, x0: 100, x1: 400 }]);
  });

  it("keeps a chord that runs past the song inside the map", () => {
    expect(mapBlocks([{ start: 90, end: 120 }], 100, 200)[0].x1).toBe(200);
  });

  it("has nothing to draw without a song length or a width", () => {
    expect(mapBlocks([{ start: 0, end: 5 }], 0, 200)).toEqual([]);
    expect(mapBlocks([{ start: 0, end: 5 }], 10, 0)).toEqual([]);
  });
});

describe("mapTime", () => {
  it("turns a position into a time and stays inside the song", () => {
    expect(mapTime(100, 200, 400)).toBe(50);
    expect(mapTime(-20, 200, 400)).toBe(0);
    expect(mapTime(900, 200, 400)).toBe(200);
    expect(mapTime(10, 200, 0)).toBe(0);
  });
});
