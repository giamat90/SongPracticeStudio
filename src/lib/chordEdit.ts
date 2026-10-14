import type { ChordSegment } from "./types";

/** No edit may leave a chord shorter than this: it could not be clicked or seen. */
export const MIN_CHORD_SECONDS = 0.1;
/** Two segments whose edges are this close are one continuous stretch of music. */
const JOIN_EPSILON = 0.01;
/** How long a chord added in a gap is, when there is room. */
const ADDED_CHORD_SECONDS = 2;

const round3 = (t: number) => Math.round(t * 1000) / 1000;

function replaceAt(segments: ChordSegment[], index: number, ...parts: ChordSegment[]): ChordSegment[] {
  return [...segments.slice(0, index), ...parts, ...segments.slice(index + 1)];
}

/** The same list with segment `index` renamed; a missing `bass` clears the slash bass. */
export function setChordAt(segments: ChordSegment[], index: number, chord: string, bass?: string | null): ChordSegment[] {
  const seg = segments[index];
  if (!seg) return segments;
  // A chord the user names is a decision, not a guess: it carries no confidence.
  const { bass: _old, confidence: _guess, ...rest } = seg;
  return replaceAt(segments, index, bass ? { ...rest, chord, bass } : { ...rest, chord });
}

export function deleteChordAt(segments: ChordSegment[], index: number): ChordSegment[] {
  return index < 0 || index >= segments.length ? segments : replaceAt(segments, index);
}

/** Cuts segment `index` in two at `time`; null when either half would be too short. */
export function splitChordAt(segments: ChordSegment[], index: number, time: number): ChordSegment[] | null {
  const seg = segments[index];
  if (!seg || time - seg.start < MIN_CHORD_SECONDS || seg.end - time < MIN_CHORD_SECONDS) return null;
  const at = round3(time);
  return replaceAt(segments, index, { ...seg, end: at }, { ...seg, start: at });
}

/**
 * Moves the start of segment `index` to `time`. A segment that touched the one
 * before it keeps touching it (the neighbour's end moves too); the move stops
 * short of leaving either chord under the minimum length.
 */
export function setChordStart(segments: ChordSegment[], index: number, time: number): ChordSegment[] {
  const seg = segments[index];
  if (!seg) return segments;
  const prev = segments[index - 1];
  const touching = !!prev && Math.abs(prev.end - seg.start) <= JOIN_EPSILON;
  const lower = prev ? (touching ? prev.start + MIN_CHORD_SECONDS : prev.end) : 0;
  const upper = seg.end - MIN_CHORD_SECONDS;
  if (lower > upper) return segments;
  const at = round3(Math.min(Math.max(time, lower), upper));
  const moved = { ...seg, start: at };
  return touching
    ? [...segments.slice(0, index - 1), { ...prev, end: at }, moved, ...segments.slice(index + 1)]
    : replaceAt(segments, index, moved);
}

/** The mirror of `setChordStart`; `limit` (the song's length) caps the last chord. */
export function setChordEnd(segments: ChordSegment[], index: number, time: number, limit = Infinity): ChordSegment[] {
  const seg = segments[index];
  if (!seg) return segments;
  const next = segments[index + 1];
  const touching = !!next && Math.abs(next.start - seg.end) <= JOIN_EPSILON;
  const lower = seg.start + MIN_CHORD_SECONDS;
  const upper = next ? (touching ? next.end - MIN_CHORD_SECONDS : next.start) : limit;
  if (lower > upper) return segments;
  const at = round3(Math.min(Math.max(time, lower), upper));
  const moved = { ...seg, end: at };
  return touching
    ? [...segments.slice(0, index), moved, { ...next, start: at }, ...segments.slice(index + 2)]
    : replaceAt(segments, index, moved);
}

/** Merges segment `index + 1` into segment `index`, which keeps its own chord. */
export function joinWithNext(segments: ChordSegment[], index: number): ChordSegment[] {
  const seg = segments[index];
  const next = segments[index + 1];
  if (!seg || !next) return segments;
  return [...segments.slice(0, index), { ...seg, end: next.end }, ...segments.slice(index + 2)];
}

/**
 * A new chord that starts at `time`, which has to be in a gap; it runs for a
 * couple of seconds or up to the next chord, and never past `limit`.
 * Null when `time` is inside a chord or there is no room.
 */
export function addChordAt(
  segments: ChordSegment[],
  time: number,
  chord: string,
  limit = Infinity,
): { segments: ChordSegment[]; index: number } | null {
  if (segments.some((s) => time >= s.start && time < s.end)) return null;
  const insertAt = segments.findIndex((s) => s.start > time);
  const index = insertAt < 0 ? segments.length : insertAt;
  const ceiling = Math.min(limit, insertAt < 0 ? Infinity : segments[insertAt].start);
  const start = round3(time);
  const end = round3(Math.min(start + ADDED_CHORD_SECONDS, ceiling));
  if (end - start < MIN_CHORD_SECONDS) return null;
  const seg: ChordSegment = { start, end, chord };
  return { segments: [...segments.slice(0, index), seg, ...segments.slice(index)], index };
}
