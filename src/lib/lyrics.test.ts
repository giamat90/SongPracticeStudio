import { describe, it, expect } from "vitest";
import {
  LINE_HOLD_S,
  LINE_LEAD_IN_S,
  activeLineIndex,
  activeWordIndex,
  canSyncLyrics,
  lineSeekTime,
  lyricsPlainText,
} from "./lyrics";
import type { LyricLine, Lyrics } from "./types";

const word = (text: string, start: number, end: number) => ({ text, start, end, score: 0.5 });
const line = (text: string, start: number, end: number, words = [word(text, start, end)]): LyricLine => ({
  text,
  start,
  end,
  score: 0.5,
  words,
});

const lines = [line("one", 10, 12), line("two", 15, 18), line("three", 18.5, 22)];

describe("activeLineIndex", () => {
  it("is -1 before the first line starts", () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 9)).toBe(-1);
  });

  it("switches a lead-in before each line starts, so the highlight leads the voice", () => {
    expect(activeLineIndex(lines, 10)).toBe(0);
    expect(activeLineIndex(lines, 10 - LINE_LEAD_IN_S + 0.01)).toBe(0);
    expect(activeLineIndex(lines, 10 - LINE_LEAD_IN_S - 0.01)).toBe(-1);
    expect(activeLineIndex(lines, 14.5)).toBe(0);
    expect(activeLineIndex(lines, 15)).toBe(1);
    expect(activeLineIndex(lines, 18.5)).toBe(2);
  });

  it("is the line a click on it seeks to, for every line (no off-by-one while paused)", () => {
    const many = Array.from({ length: 200 }, (_, i) => line(`l${i}`, 0.1 + i * 2.7 + (i % 5) * 0.31, 0.1 + i * 2.7 + 2));
    many.forEach((l, i) => {
      expect(activeLineIndex(many, lineSeekTime(l)), `line ${i}`).toBe(i);
    });
  });

  it("keeps a line lit through a short pause and drops it after the hold", () => {
    const spaced = [line("a", 10, 12), line("b", 40, 42)];
    expect(activeLineIndex(spaced, 12 + LINE_HOLD_S - 0.01)).toBe(0);
    expect(activeLineIndex(spaced, 12 + LINE_HOLD_S + 0.01)).toBe(-1);
  });

  it("a long instrumental break shows no line, then the next one", () => {
    const spaced = [line("a", 10, 12), line("b", 40, 42)];
    expect(activeLineIndex(spaced, 25)).toBe(-1);
    expect(activeLineIndex(spaced, 40.2)).toBe(1);
  });

  it("a short gap between lines keeps the previous line until the next starts", () => {
    expect(activeLineIndex(lines, 14)).toBe(0);
    expect(activeLineIndex(lines, 15.2)).toBe(1);
  });

  it("stays on the last line shortly after the song's final line ends, then clears", () => {
    expect(activeLineIndex(lines, 23)).toBe(2);
    expect(activeLineIndex(lines, 500)).toBe(-1);
  });

  it("copes with no lines and a single line", () => {
    expect(activeLineIndex([], 5)).toBe(-1);
    expect(activeLineIndex([line("a", 1, 2)], 1.5)).toBe(0);
  });

  it("finds the right line in a long list (binary search, not first match)", () => {
    const many = Array.from({ length: 500 }, (_, i) => line(`l${i}`, i * 4, i * 4 + 3));
    expect(activeLineIndex(many, 1234.5)).toBe(308);
    expect(activeLineIndex(many, 0)).toBe(0);
    expect(activeLineIndex(many, 1999)).toBe(499);
  });

  it("is not thrown by a line that overlaps the next one", () => {
    const overlapping = [line("a", 1, 8), line("b", 5, 9)];
    expect(activeLineIndex(overlapping, 6)).toBe(1);
  });
});

describe("activeWordIndex", () => {
  const l = line("hello big world", 10, 14, [word("hello", 10, 11), word("big", 11.5, 12), word("world", 12.5, 14)]);

  it("is -1 before the line's first word", () => {
    expect(activeWordIndex(l, 9)).toBe(-1);
  });

  it("is the last word that has started", () => {
    expect(activeWordIndex(l, 10)).toBe(0);
    expect(activeWordIndex(l, 11.2)).toBe(0);
    expect(activeWordIndex(l, 11.5)).toBe(1);
    expect(activeWordIndex(l, 13)).toBe(2);
    expect(activeWordIndex(l, 99)).toBe(2);
  });

  it("is -1 for a line without word timings", () => {
    expect(activeWordIndex({ ...l, words: [] }, 11)).toBe(-1);
  });
});

describe("lineSeekTime", () => {
  it("starts a touch early so the first word is not clipped", () => {
    expect(lineSeekTime(line("a", 20, 22))).toBeCloseTo(20 - LINE_LEAD_IN_S);
  });

  it("never seeks before the start of the song", () => {
    expect(lineSeekTime(line("a", 0.1, 2))).toBe(0);
  });
});

describe("lyricsPlainText", () => {
  it("joins the lines for editing and re-syncing", () => {
    const lyrics = { lines, text: "ignored" } as unknown as Lyrics;
    expect(lyricsPlainText(lyrics)).toBe("one\ntwo\nthree");
  });
});

describe("canSyncLyrics", () => {
  it("needs the vocals stem, which a song can be imported without", () => {
    expect(canSyncLyrics(["vocals", "drums", "bass"])).toBe(true);
    expect(canSyncLyrics(["drums", "bass", "other"])).toBe(false);
    expect(canSyncLyrics([])).toBe(false);
  });
});
