import { useEffect, useMemo, useState } from "react";
import { usePlayerStore } from "../stores/player";
import { readSongChords } from "./tauri";
import type { ChordSegment, Song } from "./types";
import { transposeChord } from "./chordNames";

export { formatChordName, transposeChord, transposeKey } from "./chordNames";

export function findActiveChordIndex(segments: ChordSegment[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (time < seg.start) hi = mid - 1;
    else if (time >= seg.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Index of the segment to treat as the "current" pointer even when nothing
 * is actively playing (leading silence before the first chord, or a gap
 * between segments): the nearest upcoming segment, falling back to the last
 * segment once playback runs past the end of the detected chords.
 */
export function findNearestChordIndex(segments: ChordSegment[], time: number): number {
  if (segments.length === 0) return -1;
  const active = findActiveChordIndex(segments, time);
  if (active >= 0) return active;
  const next = segments.findIndex((seg) => seg.start > time);
  return next >= 0 ? next : segments.length - 1;
}

/** Loads a song's detected chord segments once and tracks which one is currently playing. */
export function useChordSegments(song: Song) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const transpose = usePlayerStore((s) => s.transpose);
  const [detected, setSegments] = useState<ChordSegment[]>([]);
  const segments = useMemo(
    () => (transpose === 0 ? detected : detected.map((seg) => ({ ...seg, chord: transposeChord(seg.chord, transpose) }))),
    [detected, transpose],
  );

  useEffect(() => {
    setSegments([]);
    if (!song.hasChords) return;
    let cancelled = false;
    readSongChords(song.id)
      .then((result) => { if (!cancelled) setSegments(result); })
      .catch((e: unknown) => console.error("[useChordSegments] readSongChords failed:", e));
    return () => { cancelled = true; };
  }, [song.id, song.hasChords]);

  const activeIndex = findActiveChordIndex(segments, currentTime);
  const centerIndex = findNearestChordIndex(segments, currentTime);
  return {
    segments,
    activeIndex,
    centerIndex,
    activeChord: activeIndex >= 0 ? segments[activeIndex] : null,
  };
}
