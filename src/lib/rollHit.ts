/** A chord in view on the roll: its index in the song's chord list and where it spans on the canvas. */
export interface RollBlock {
  index: number;
  x0: number;
  x1: number;
}

/** How close, in pixels, the pointer must be to a chord's left edge to take hold of it. */
export const EDGE_PX = 6;
/** Height of the strip at the top of the roll that carries the chord names and picks a chord when clicked. */
export const STRIP_H = 18;

export type Press =
  | { kind: "edge"; index: number }
  | { kind: "strip"; index: number }
  | { kind: "seek" };

/** What a press at (x, y) on the roll takes hold of: a chord's left edge, a chord's name strip, or the time. */
export function classifyPress(blocks: readonly RollBlock[], x: number, y: number): Press {
  const edge = blocks.find((b) => Math.abs(b.x0 - x) <= EDGE_PX);
  if (edge) return { kind: "edge", index: edge.index };
  if (y < STRIP_H) {
    const inside = blocks.find((b) => x >= b.x0 && x < b.x1);
    if (inside) return { kind: "strip", index: inside.index };
  }
  return { kind: "seek" };
}
