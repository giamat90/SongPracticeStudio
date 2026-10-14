import type { TabBar } from "./types";

/** One played bar with the stretch of the recording it covers. */
export interface BarSpan {
  /** Position in play order (repeats count again). */
  order: number;
  /** Master bar index in the tab. */
  index: number;
  occurrence: number;
  start: number;
  end: number;
}

export interface BarPosition {
  order: number;
  index: number;
  occurrence: number;
  /** 0 at the bar line, up to 1 at the next one. */
  fraction: number;
}

/** Spans for every played bar; the last one ends at `duration` (or a median bar later when that is not after it). */
export function barSpans(bars: readonly TabBar[], duration: number): BarSpan[] {
  if (bars.length === 0) return [];
  const gaps = bars.slice(1).map((b, i) => b.time - bars[i].time).filter((g) => g > 0).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 2;
  return bars.map((b, i) => {
    const next = i + 1 < bars.length ? bars[i + 1].time : Math.max(duration, b.time + typical);
    return { order: i, index: b.index, occurrence: b.occurrence, start: b.time, end: Math.max(next, b.time) };
  });
}

/** Which bar the recording is in at `time`, or `null` before the first bar line. */
export function locate(time: number, spans: readonly BarSpan[]): BarPosition | null {
  if (spans.length === 0 || time < spans[0].start) return null;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= time) lo = mid;
    else hi = mid - 1;
  }
  const s = spans[lo];
  const length = s.end - s.start;
  const fraction = length > 0 ? Math.min(1, Math.max(0, (time - s.start) / length)) : 0;
  return { order: lo, index: s.index, occurrence: s.occurrence, fraction };
}

/** The time of a place in the tab; the first pass of a bar when `occurrence` does not exist. */
export function timeAt(index: number, occurrence: number, fraction: number, spans: readonly BarSpan[]): number | null {
  const exact = spans.find((s) => s.index === index && s.occurrence === occurrence);
  const span = exact ?? spans.find((s) => s.index === index);
  if (!span) return null;
  return span.start + (span.end - span.start) * Math.min(1, Math.max(0, fraction));
}

/**
 * Move the bar line at play order `order` to `time`. With `following` every
 * later bar line moves by the same amount (the tab was early or late from here
 * on); otherwise only this one moves and stays between its neighbours.
 */
export function moveBar(bars: readonly TabBar[], order: number, time: number, following: boolean): TabBar[] {
  if (order < 0 || order >= bars.length || !Number.isFinite(time)) return bars.map((b) => ({ ...b }));
  const floor = order > 0 ? bars[order - 1].time : 0;
  const t = Math.max(floor, time);
  if (following) {
    const delta = t - bars[order].time;
    return bars.map((b, i) => (i < order ? { ...b } : { ...b, time: Math.max(floor, b.time + delta) }));
  }
  const ceiling = order + 1 < bars.length ? bars[order + 1].time : Infinity;
  return bars.map((b, i) => (i === order ? { ...b, time: Math.min(t, ceiling) } : { ...b }));
}

/** Whether two sets of bar lines differ, to know if there is anything to save. */
export function barsDiffer(a: readonly TabBar[], b: readonly TabBar[]): boolean {
  return a.length !== b.length || a.some((bar, i) => Math.abs(bar.time - b[i].time) > 0.0005);
}

export const QUALITY_TEXT = {
  good: "Aligned",
  check: "Check the bar lines",
  poor: "Poor match",
} as const;

export type TabQuality = keyof typeof QUALITY_TEXT;

export function qualityText(quality: string): string {
  return quality in QUALITY_TEXT ? QUALITY_TEXT[quality as TabQuality] : quality;
}

/** What the user is told about a tab that was shifted or retuned to fit the recording. */
export function alignmentNotes(sync: { transpose: number; quality: string }): string[] {
  const notes: string[] = [];
  if (sync.transpose !== 0) {
    const n = Math.abs(sync.transpose);
    notes.push(`The recording sounds ${n} semitone${n === 1 ? "" : "s"} ${sync.transpose > 0 ? "higher" : "lower"} than the tab.`);
  }
  if (sync.quality === "poor") {
    notes.push("The tab does not match this recording well. It may be a different version or arrangement.");
  } else if (sync.quality === "check") {
    notes.push("Some bars may be off. Click a bar and use Set here to correct it.");
  }
  return notes;
}
