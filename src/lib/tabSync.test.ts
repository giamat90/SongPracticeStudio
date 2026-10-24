import { describe, expect, it } from "vitest";
import { alignmentNotes, barSpans, barsDiffer, cursorX, locate, moveBar, qualityText, timeAt } from "./tabSync";
import type { TabBar } from "./types";

const bars: TabBar[] = [
  { index: 0, occurrence: 0, time: 1 },
  { index: 1, occurrence: 0, time: 3 },
  { index: 2, occurrence: 0, time: 5 },
  { index: 1, occurrence: 1, time: 7 },
  { index: 2, occurrence: 1, time: 9 },
];

describe("cursorX", () => {
  const bar = { x: 100, w: 400, length: 3840 };
  // Four beats, drawn unevenly: the first note sits a little inside the bar line.
  const stops = [{ tick: 0, x: 130 }, { tick: 960, x: 190 }, { tick: 1920, x: 330 }, { tick: 2880, x: 420 }];

  it("sits on the first note at the start of the bar, not on the bar line", () => {
    expect(cursorX(stops, bar, 0)).toBe(130);
  });

  it("sits on each note at that note's time", () => {
    expect(cursorX(stops, bar, 0.25)).toBe(190);
    expect(cursorX(stops, bar, 0.5)).toBe(330);
    expect(cursorX(stops, bar, 0.75)).toBe(420);
  });

  it("moves between notes in proportion to the time, and on to the next bar line after the last note", () => {
    expect(cursorX(stops, bar, 0.125)).toBe(160);
    expect(cursorX(stops, bar, 0.875)).toBe(460);
    expect(cursorX(stops, bar, 1)).toBe(500);
  });

  it("starts from the bar line when the first beat comes after a pickup", () => {
    expect(cursorX([{ tick: 960, x: 200 }], bar, 0)).toBe(100);
    expect(cursorX([{ tick: 960, x: 200 }], bar, 0.125)).toBe(150);
  });

  it("falls back to an even spread without beats and clamps the fraction", () => {
    expect(cursorX([], bar, 0.5)).toBe(300);
    expect(cursorX(stops, bar, -1)).toBe(130);
    expect(cursorX(stops, bar, 2)).toBe(500);
  });
});

describe("barSpans", () => {
  it("ends each bar where the next starts and the last at the song's end", () => {
    const spans = barSpans(bars, 12);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[1, 3], [3, 5], [5, 7], [7, 9], [9, 12]]);
    expect(spans[3]).toMatchObject({ order: 3, index: 1, occurrence: 1 });
  });

  it("gives the last bar a typical length when the song ends before it", () => {
    const spans = barSpans(bars, 5);
    expect(spans[spans.length - 1]).toMatchObject({ start: 9, end: 11 });
  });

  it("is empty without bars", () => {
    expect(barSpans([], 10)).toEqual([]);
  });
});

describe("locate", () => {
  const spans = barSpans(bars, 12);

  it("is null before the first bar line", () => {
    expect(locate(0.5, spans)).toBeNull();
  });

  it("finds the bar and how far into it", () => {
    expect(locate(4, spans)).toEqual({ order: 1, index: 1, occurrence: 0, fraction: 0.5 });
    expect(locate(3, spans)).toMatchObject({ order: 1, fraction: 0 });
  });

  it("tells the second pass over a repeated bar from the first", () => {
    expect(locate(8, spans)).toMatchObject({ index: 1, occurrence: 1 });
  });

  it("stays in the last bar past the end", () => {
    expect(locate(99, spans)).toMatchObject({ order: 4, fraction: 1 });
  });
});

describe("timeAt", () => {
  const spans = barSpans(bars, 12);

  it("maps a place in the tab to a time", () => {
    expect(timeAt(2, 0, 0.5, spans)).toBe(6);
  });

  it("uses the requested pass, falling back to the first", () => {
    expect(timeAt(1, 1, 0, spans)).toBe(7);
    expect(timeAt(1, 5, 0, spans)).toBe(3);
  });

  it("is null for a bar that is not in the tab", () => {
    expect(timeAt(40, 0, 0, spans)).toBeNull();
  });

  it("clamps the position inside the bar", () => {
    expect(timeAt(0, 0, 3, spans)).toBe(3);
    expect(timeAt(0, 0, -1, spans)).toBe(1);
  });
});

describe("moveBar", () => {
  it("moves one bar line and keeps it between its neighbours", () => {
    expect(moveBar(bars, 2, 5.5, false).map((b) => b.time)).toEqual([1, 3, 5.5, 7, 9]);
    expect(moveBar(bars, 2, 8, false)[2].time).toBe(7);
    expect(moveBar(bars, 2, 1, false)[2].time).toBe(3);
  });

  it("shifts every following bar line by the same amount", () => {
    expect(moveBar(bars, 2, 5.5, true).map((b) => b.time)).toEqual([1, 3, 5.5, 7.5, 9.5]);
  });

  it("never lets a shift run before the previous bar", () => {
    const moved = moveBar(bars, 3, 0, true);
    expect(moved[3].time).toBe(5);
    expect(moved.every((b, i, all) => i === 0 || b.time >= all[i - 1].time)).toBe(true);
  });

  it("does not change its input and ignores bad arguments", () => {
    const before = JSON.stringify(bars);
    moveBar(bars, 1, 4, true);
    expect(JSON.stringify(bars)).toBe(before);
    expect(moveBar(bars, 99, 4, false)).toEqual(bars);
    expect(moveBar(bars, 1, NaN, false)).toEqual(bars);
  });
});

describe("barsDiffer", () => {
  it("compares times within half a millisecond", () => {
    expect(barsDiffer(bars, bars.map((b) => ({ ...b })))).toBe(false);
    expect(barsDiffer(bars, moveBar(bars, 1, 3.2, false))).toBe(true);
    expect(barsDiffer(bars, bars.slice(1))).toBe(true);
  });
});

describe("messages", () => {
  it("names the quality", () => {
    expect(qualityText("good")).toBe("Aligned");
    expect(qualityText("poor")).toBe("Poor match");
    expect(qualityText("other")).toBe("other");
  });

  it("explains a retuned or doubtful alignment", () => {
    expect(alignmentNotes({ transpose: 0, quality: "good" })).toEqual([]);
    expect(alignmentNotes({ transpose: 1, quality: "good" })[0]).toMatch(/1 semitone higher/);
    expect(alignmentNotes({ transpose: -2, quality: "check" })).toHaveLength(2);
    expect(alignmentNotes({ transpose: 0, quality: "poor" })[0]).toMatch(/different version/);
  });
});
