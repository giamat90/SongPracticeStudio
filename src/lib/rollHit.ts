/** A chord in view on the roll: its index in the song's chord list and where it spans on the canvas. */
export interface RollBlock {
  index: number;
  x0: number;
  x1: number;
}

/** How close, in pixels, the pointer must be to a chord's left edge to take hold of it. */
export const EDGE_PX = 6;
/** Height of the chord strip above the notes: one button per chord, each as wide as the chord is long. */
export const STRIP_H = 28;

/** Half the width of the "+" button that adds a chord at the playhead. */
export const ADD_HALF_PX = 12;

export type Press =
  | { kind: "add" }
  | { kind: "edge"; index: number }
  | { kind: "strip"; index: number }
  | { kind: "seek" };

/**
 * What a press at (x, y) on the roll takes hold of: the add button (when there is one, at `addX`), a chord's left
 * edge, a chord's button in the strip, or the time.
 */
export function classifyPress(blocks: readonly RollBlock[], x: number, y: number, addX: number | null = null): Press {
  if (addX !== null && y < STRIP_H && Math.abs(x - addX) <= ADD_HALF_PX) return { kind: "add" };
  const edge = blocks.find((b) => Math.abs(b.x0 - x) <= EDGE_PX);
  if (edge) return { kind: "edge", index: edge.index };
  if (y < STRIP_H) {
    const inside = blocks.find((b) => x >= b.x0 && x < b.x1);
    if (inside) return { kind: "strip", index: inside.index };
  }
  return { kind: "seek" };
}
