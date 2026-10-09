import { describe, it, expect } from "vitest";
import {
  clamp,
  computePan,
  computeZoomToCursor,
  wheelDeltaPixels,
  MAX_PX_PER_SEC,
  ZOOM_SENSITIVITY,
} from "./zoomPan";

function wheel(partial: Partial<WheelEvent>): WheelEvent {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ...partial } as WheelEvent;
}

describe("clamp", () => {
  it("passes through values inside the range", () => expect(clamp(5, 0, 10)).toBe(5));
  it("clamps below and above", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it("lets the upper bound win when the range is inverted", () => expect(clamp(5, 10, 0)).toBe(0));
});

describe("wheelDeltaPixels", () => {
  it("returns pixel deltas unchanged", () => expect(wheelDeltaPixels(wheel({ deltaY: 40 }))).toBe(40));
  it("scales line mode by 16 and page mode by 800", () => {
    expect(wheelDeltaPixels(wheel({ deltaY: 3, deltaMode: 1 }))).toBe(48);
    expect(wheelDeltaPixels(wheel({ deltaY: 2, deltaMode: 2 }))).toBe(1600);
  });
  it("ignores deltaX on the default y axis", () => {
    expect(wheelDeltaPixels(wheel({ deltaX: 9, deltaY: 4 }))).toBe(4);
  });
  it("prefers deltaX on x-or-y when present, else falls back to deltaY", () => {
    expect(wheelDeltaPixels(wheel({ deltaX: 9, deltaY: 4 }), "x-or-y")).toBe(9);
    expect(wheelDeltaPixels(wheel({ deltaX: 0, deltaY: 4 }), "x-or-y")).toBe(4);
  });
  it("applies the mode multiplier to the x delta too", () => {
    expect(wheelDeltaPixels(wheel({ deltaX: 2, deltaMode: 1 }), "x-or-y")).toBe(32);
  });
});

const base = { minPxPerSec: 100, scrollTime: 10, cursorOffsetPx: 200, viewportWidthPx: 1000, duration: 300, minBound: 5 };

describe("computeZoomToCursor", () => {
  it("keeps the time under the cursor fixed", () => {
    const before = base.scrollTime + base.cursorOffsetPx / base.minPxPerSec;
    const r = computeZoomToCursor({ ...base, deltaY: -300 });
    const after = r.scrollTime + base.cursorOffsetPx / r.minPxPerSec;
    expect(after).toBeCloseTo(before, 9);
  });

  it("zooms in on negative deltaY and out on positive", () => {
    expect(computeZoomToCursor({ ...base, deltaY: -100 }).minPxPerSec).toBeGreaterThan(base.minPxPerSec);
    expect(computeZoomToCursor({ ...base, deltaY: 100 }).minPxPerSec).toBeLessThan(base.minPxPerSec);
  });

  it("uses an exponential factor so equal wheel steps compose multiplicatively", () => {
    const one = computeZoomToCursor({ ...base, deltaY: -100 }).minPxPerSec;
    expect(one).toBeCloseTo(base.minPxPerSec * Math.exp(100 * ZOOM_SENSITIVITY), 9);
  });

  it("never exceeds MAX_PX_PER_SEC", () => {
    expect(computeZoomToCursor({ ...base, deltaY: -100000 }).minPxPerSec).toBe(MAX_PX_PER_SEC);
  });

  it("never drops below minBound", () => {
    expect(computeZoomToCursor({ ...base, deltaY: 100000 }).minPxPerSec).toBe(base.minBound);
  });

  it("keeps scrollTime within [0, duration - viewport]", () => {
    const r = computeZoomToCursor({ ...base, scrollTime: 0, cursorOffsetPx: 0, deltaY: 100000 });
    expect(r.scrollTime).toBe(0);
    const farRight = computeZoomToCursor({
      ...base, scrollTime: 290, cursorOffsetPx: 900, minPxPerSec: 100, duration: 300, deltaY: -400,
    });
    const maxScroll = 300 - 1000 / farRight.minPxPerSec;
    expect(farRight.scrollTime).toBeLessThanOrEqual(maxScroll + 1e-9);
    expect(farRight.scrollTime).toBeGreaterThanOrEqual(0);
  });

  it("pins scrollTime to 0 when the whole song fits in the viewport", () => {
    const r = computeZoomToCursor({ ...base, duration: 5, scrollTime: 0, deltaY: 0 });
    expect(r.scrollTime).toBe(0);
  });

  it("is the identity for deltaY = 0 when the view is already valid", () => {
    const r = computeZoomToCursor({ ...base, deltaY: 0 });
    expect(r.minPxPerSec).toBeCloseTo(base.minPxPerSec, 9);
    expect(r.scrollTime).toBeCloseTo(base.scrollTime, 9);
  });
});

describe("computePan", () => {
  const args = { minPxPerSec: 100, scrollTime: 10, viewportWidthPx: 1000, duration: 300 };

  it("converts pixel deltas to seconds", () => expect(computePan({ ...args, deltaPx: 250 })).toBeCloseTo(12.5, 9));
  it("clamps at the start", () => expect(computePan({ ...args, deltaPx: -1e6 })).toBe(0));
  it("clamps at the end so the last visible edge is the duration", () => {
    expect(computePan({ ...args, deltaPx: 1e6 })).toBeCloseTo(300 - 1000 / 100, 9);
  });
  it("returns 0 when the song is shorter than the viewport", () => {
    expect(computePan({ ...args, duration: 5, deltaPx: 500 })).toBe(0);
  });
});
