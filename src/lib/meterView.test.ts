import { describe, it, expect } from "vitest";
import type { BarMap } from "@giamat90/mps-core/meter";
import {
  STRIP_H, barRange, barTitle, classifyMeterPress, formatStamp, groupPresets, hitEnvelope, meterShares, parseCycle,
  parseGroups, stretchOf,
} from "./meterView";

const map = (sigs: Array<[number, number]>, bar = 2): BarMap => ({
  version: 1,
  bars: sigs.map(([num, den], i) => ({ start: i * bar, num, den })),
  end: sigs.length * bar,
  source: "edited",
});

describe("classifyMeterPress", () => {
  const blocks = [{ index: 0, x0: 100, x1: 200 }, { index: 1, x0: 200, x1: 300 }];

  it("grabs a bar's left edge, even from a little to its left", () => {
    expect(classifyMeterPress(blocks, 102, 10)).toEqual({ kind: "edge", index: 0 });
    expect(classifyMeterPress(blocks, 190, 10)).toEqual({ kind: "bar", index: 0 });
    expect(classifyMeterPress(blocks, 195, 10)).toEqual({ kind: "edge", index: 1 });
  });

  it("picks the bar anywhere else on its button", () => {
    expect(classifyMeterPress(blocks, 150, 10)).toEqual({ kind: "bar", index: 0 });
    expect(classifyMeterPress(blocks, 250, STRIP_H)).toEqual({ kind: "bar", index: 1 });
  });

  it("goes to the time under a press below the strip or outside the bars", () => {
    expect(classifyMeterPress(blocks, 150, STRIP_H + 1)).toEqual({ kind: "seek" });
    expect(classifyMeterPress(blocks, 20, 10)).toEqual({ kind: "seek" });
  });
});

describe("barRange", () => {
  const m = map([[4, 4], [7, 8], [7, 8], [7, 8], [4, 4]]);

  it("reaches one bar, a run of the same signature, or the rest of the song", () => {
    expect(barRange(m, 2, "bar")).toEqual([2, 2]);
    expect(barRange(m, 1, "run")).toEqual([1, 3]);
    expect(barRange(m, 2, "run")).toEqual([2, 3]);
    expect(barRange(m, 1, "end")).toEqual([1, 4]);
  });
});

describe("naming bars", () => {
  it("shows the groups only when there are some", () => {
    const m = map([[4, 4], [7, 8]]);
    expect(barTitle(m, 0)).toBe("4/4");
    expect(barTitle(m, 1)).toBe("7/8 (3+2+2)");
  });

  it("writes a stamp as minutes and tenths of seconds", () => {
    expect(formatStamp(75.04)).toBe("1:15.0");
    expect(formatStamp(5.55)).toBe("0:05.5");
  });

  it("gives the stretch of a bar", () => {
    expect(stretchOf(map([[4, 4], [4, 4]]), 1)).toEqual([2, 4]);
  });
});

describe("groupPresets", () => {
  it("starts with the usual split and offers the other orders", () => {
    expect(groupPresets(7).slice(0, 3)).toEqual([[3, 2, 2], [2, 3, 2], [2, 2, 3]]);
    expect(groupPresets(7)).toContainEqual([4, 3]);
    expect(groupPresets(5)).toEqual([[3, 2], [2, 3]]);
    expect(groupPresets(6)[0]).toEqual([3, 3]);
  });

  it("offers a short bar as one group, a four as one or two twos, and never more than the limit", () => {
    expect(groupPresets(3)).toEqual([[3]]);
    expect(groupPresets(4)).toEqual([[4], [2, 2]]);
    expect(groupPresets(13).length).toBeLessThanOrEqual(6);
    for (const n of [5, 7, 8, 9, 11, 12]) {
      for (const g of groupPresets(n)) expect(g.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });
});

describe("parsing what a person types", () => {
  it("reads groups written with plus signs, spaces or commas, and refuses ones that do not add up", () => {
    expect(parseGroups("3+2+2", 7)).toEqual([3, 2, 2]);
    expect(parseGroups("2 2 3", 7)).toEqual([2, 2, 3]);
    expect(parseGroups("4, 3", 7)).toEqual([4, 3]);
    expect(parseGroups("3+3", 7)).toBeNull();
    expect(parseGroups("", 7)).toBeNull();
    expect(parseGroups("0+7", 7)).toBeNull();
  });

  it("reads a pattern of bar lengths", () => {
    expect(parseCycle("5, 7")).toEqual([5, 7]);
    expect(parseCycle("9+8+7")).toEqual([9, 8, 7]);
    expect(parseCycle("")).toBeNull();
    expect(parseCycle("0")).toBeNull();
    expect(parseCycle("33")).toBeNull();
  });
});

describe("meterShares", () => {
  it("lists the signatures by the time they take", () => {
    const m = map([[4, 4], [4, 4], [4, 4], [7, 4], [4, 4]]);
    const shares = meterShares(m);
    expect(shares.map((s) => s.label)).toEqual(["4/4", "7/4"]);
    expect(shares[0].share).toBeCloseTo(0.8, 6);
    expect(shares[0].bars).toBe(4);
  });
});

describe("hitEnvelope", () => {
  it("peaks where a sound starts and stays quiet through steady sound and silence", () => {
    const sr = 1000;
    const samples = new Float32Array(sr);
    for (let i = 500; i < 1000; i++) samples[i] = i < 600 ? 1 : 0.2;
    const env = hitEnvelope(samples, sr, 100);
    expect(env.length).toBe(100);
    expect(env[50]).toBeGreaterThan(0.9);
    expect(env[20]).toBe(0);
    expect(env[80]).toBe(0);
  });

  it("is all zero for silence", () => {
    expect(Array.from(hitEnvelope(new Float32Array(1000), 1000, 100)).every((v) => v === 0)).toBe(true);
  });
});
