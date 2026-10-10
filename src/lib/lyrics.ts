import type { LyricLine, LyricWord, Lyrics } from "./types";

/** How long a line stays lit after it ends before the display shows a break. */
export const LINE_HOLD_S = 4;

/** Clicking a line starts this much early so the first word is not clipped. */
export const LINE_LEAD_IN_S = 0.3;

/** Index of the last element whose `start` is at or before `time`, or -1. */
function lastStartedIndex(items: readonly { start: number }[], time: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The line being sung at `time`, or -1 before the first line and in long breaks.
 * A line lights up one lead-in early, which is exactly where clicking it seeks
 * to; otherwise a click while paused would highlight the previous line.
 */
export function activeLineIndex(lines: readonly LyricLine[], time: number, hold = LINE_HOLD_S): number {
  const i = lastStartedIndex(lines, time + LINE_LEAD_IN_S + 1e-6);
  if (i < 0) return -1;
  return time > lines[i].end + hold ? -1 : i;
}

/** The word being sung within `line` at `time`, or -1 before its first word. */
export function activeWordIndex(line: LyricLine, time: number): number {
  return lastStartedIndex(line.words as readonly LyricWord[], time);
}

export function lineSeekTime(line: LyricLine): number {
  return Math.max(0, line.start - LINE_LEAD_IN_S);
}

export function lyricsPlainText(lyrics: Lyrics): string {
  return lyrics.lines.map((l) => l.text).join("\n");
}

/**
 * Lyrics are placed on the vocals stem, and SPS lets a song be imported
 * without it, so the tab explains instead of failing when it is absent.
 */
export function canSyncLyrics(stems: readonly string[]): boolean {
  return stems.includes("vocals");
}
