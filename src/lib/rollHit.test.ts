import { describe, expect, it } from "vitest";
import { STRIP_H, classifyPress } from "./rollHit";

const blocks = [
  { index: 3, x0: 100, x1: 300 },
  { index: 4, x0: 300, x1: 500 },
];

describe("classifyPress", () => {
  it("takes hold of a chord's left edge, wherever down the roll the press is", () => {
    expect(classifyPress(blocks, 103, 120)).toEqual({ kind: "edge", index: 3 });
    expect(classifyPress(blocks, 296, 5)).toEqual({ kind: "edge", index: 4 });
  });

  it("picks the chord under the name strip when the press is not on an edge", () => {
    expect(classifyPress(blocks, 200, STRIP_H - 1)).toEqual({ kind: "strip", index: 3 });
    expect(classifyPress(blocks, 400, 4)).toEqual({ kind: "strip", index: 4 });
  });

  it("seeks everywhere else", () => {
    expect(classifyPress(blocks, 200, STRIP_H + 1)).toEqual({ kind: "seek" });
    expect(classifyPress(blocks, 700, 4)).toEqual({ kind: "seek" });
    expect(classifyPress([], 10, 4)).toEqual({ kind: "seek" });
  });
});
