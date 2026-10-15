import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "../stores/player";
import { readSongChords } from "./tauri";
import type { ChordSegment, Song } from "./types";
import { simplifyChord, transposeChord, transposeNote } from "./chordNames";

export { formatChordName, simplifyChord, transposeChord, transposeKey, transposeNote } from "./chordNames";

/**
 * Below this a detected chord is a guess worth a second look. Measured on 12
 * Beatles/Queen songs against their reference charts: chords under 0.70 were
 * right about half the time, chords over 0.80 about 85% (wiki/testing.md).
 */
export const LOW_CONFIDENCE = 0.72;

export function isUnsure(segment: ChordSegment): boolean {
  return segment.confidence !== undefined && segment.confidence < LOW_CONFIDENCE;
}

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
  const capo = usePlayerStore((s) => s.capo);
  const chordDetail = usePlayerStore((s) => s.chordDetail);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const [detected, setSegments] = useState<ChordSegment[]>([]);
  // What is shown is the shapes to play: the key the song sounds in, with the capo taken off.
  const shift = transpose - capo;
  const segments = useMemo(
    () =>
      shift === 0
        ? detected
        : detected.map((seg) => ({
            ...seg,
            chord: transposeChord(seg.chord, shift),
            ...(seg.bass ? { bass: transposeNote(seg.bass, shift) } : {}),
          })),
    [detected, shift],
  );

  // A reload for the same song (a correction, a new detection) keeps what is
  // shown until the new list arrives, so the row does not blink out and back.
  const loadedSongId = useRef<string | null>(null);

  useEffect(() => {
    if (loadedSongId.current !== song.id || !song.hasChords) {
      loadedSongId.current = song.id;
      setSegments([]);
    }
    if (!song.hasChords) return;
    let cancelled = false;
    readSongChords(song.id)
      .then((result) => { if (!cancelled) setSegments(result); })
      .catch((e: unknown) => console.error("[useChordSegments] readSongChords failed:", e));
    return () => { cancelled = true; };
  }, [song.id, song.hasChords, revision]);

  // The names to show. Segments are not merged: a chip keeps pointing at the
  // stored chord it corrects, even when two neighbours read the same here.
  const display = useMemo(
    () => segments.map((seg) => simplifyChord(seg.chord, seg.bass, chordDetail)),
    [segments, chordDetail],
  );

  const activeIndex = findActiveChordIndex(segments, currentTime);
  const centerIndex = findNearestChordIndex(segments, currentTime);
  return {
    segments,
    /** What to print for each segment (same order) at the chosen detail level. */
    display,
    /** The segments as stored, in the key the song was detected in (before transpose and capo). */
    stored: detected,
    /** Semitones the shown chords are moved from the stored ones. */
    shift,
    activeIndex,
    centerIndex,
    activeChord: activeIndex >= 0 ? segments[activeIndex] : null,
  };
}
