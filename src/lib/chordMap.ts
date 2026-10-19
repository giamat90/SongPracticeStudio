import type { ChordSegment } from "./types";

/** One chord on the whole-song map: its index in the chord list and where it spans on a map `width` pixels wide. */
export interface MapBlock {
  index: number;
  x0: number;
  x1: number;
}

/** Where every chord of the song sits on a map that shows the whole song across `width` pixels. */
export function mapBlocks(segments: readonly Pick<ChordSegment, "start" | "end">[], duration: number, width: number): MapBlock[] {
  if (duration <= 0 || width <= 0) return [];
  return segments.map((seg, index) => ({
    index,
    x0: (Math.max(0, seg.start) / duration) * width,
    x1: (Math.min(duration, seg.end) / duration) * width,
  }));
}

/** The song time under pixel `x` of a map `width` pixels wide, kept inside the song. */
export function mapTime(x: number, duration: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(Math.max(x / width, 0), 1) * duration;
}
