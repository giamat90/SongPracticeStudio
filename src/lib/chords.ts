import { useEffect, useMemo, useState } from "react";
import { usePlayerStore } from "../stores/player";
import { readSongChords } from "./tauri";
import type { ChordSegment, Song } from "./types";

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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function shiftNote(note: string, semitones: number): string | null {
  const i = NOTE_NAMES.indexOf(note);
  if (i < 0) return null;
  return NOTE_NAMES[(((i + semitones) % 12) + 12) % 12];
}

/** "C:maj" shifted up by 2 semitones -> "D:maj"; anything that is not a note:quality pair is returned as is. */
export function transposeChord(chord: string, semitones: number): string {
  const [root, quality] = chord.split(":");
  const shifted = shiftNote(root, semitones);
  if (shifted === null || quality === undefined) return chord;
  return `${shifted}:${quality}`;
}

/** "A minor" shifted down by 3 -> "F# minor". */
export function transposeKey(key: string, semitones: number): string {
  const [root, ...rest] = key.split(" ");
  const shifted = shiftNote(root, semitones);
  return shifted === null ? key : [shifted, ...rest].join(" ");
}

/** Chord name like "C:maj" / "A:min" -> "C" / "Am" */
export function formatChordName(chord: string): string {
  const [root, quality] = chord.split(":");
  return quality === "min" ? `${root}m` : root;
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
