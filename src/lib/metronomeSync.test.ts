import { describe, it, expect } from "vitest";
import { computeMetronomePhase, countInDurationSeconds } from "./metronomeSync";

describe("computeMetronomePhase", () => {
  const base = { detectedBpm: 120, playbackRate: 1, anchorTime: 0, currentSongTime: 0 };

  it("clicks immediately when exactly on a beat", () => {
    expect(computeMetronomePhase(base)).toEqual({ timeUntilNextBeat: 0, beatIndex: 0 });
  });

  it("waits the remainder of the beat interval when between beats", () => {
    const r = computeMetronomePhase({ ...base, currentSongTime: 0.1 });
    expect(r.timeUntilNextBeat).toBeCloseTo(0.4, 9);
    expect(r.beatIndex).toBe(1);
  });

  it("counts beat-in-bar relative to the anchor", () => {
    const r = computeMetronomePhase({ ...base, currentSongTime: 1.5 });
    expect(r.timeUntilNextBeat).toBeCloseTo(0, 9);
    expect(r.beatIndex).toBe(3);
  });

  it("wraps the bar every beatsPerBar beats (accent on beat 0)", () => {
    const r = computeMetronomePhase({ ...base, currentSongTime: 2.0 });
    expect(r.beatIndex).toBe(0);
  });

  it("honours a custom beatsPerBar", () => {
    const r = computeMetronomePhase({ ...base, currentSongTime: 1.5, beatsPerBar: 3 });
    expect(r.beatIndex).toBe(0);
  });

  it("phase-locks to the downbeat anchor, not to song start", () => {
    const r = computeMetronomePhase({ ...base, anchorTime: 0.3, currentSongTime: 0.3 });
    expect(r).toEqual({ timeUntilNextBeat: 0, beatIndex: 0 });
    const next = computeMetronomePhase({ ...base, anchorTime: 0.3, currentSongTime: 0.4 });
    expect(next.timeUntilNextBeat).toBeCloseTo(0.4, 9);
  });

  it("handles playback before the anchor (negative elapsed) with a positive wait", () => {
    const r = computeMetronomePhase({ ...base, anchorTime: 5, currentSongTime: 4.9 });
    expect(r.timeUntilNextBeat).toBeCloseTo(0.1, 9);
    expect(r.timeUntilNextBeat).toBeGreaterThanOrEqual(0);
    expect(r.beatIndex).toBeGreaterThanOrEqual(0);
    expect(r.beatIndex).toBeLessThan(4);
    expect(r.beatIndex).toBe(0);
  });

  it("labels the beat before the anchor as the last beat of the previous bar", () => {
    const r = computeMetronomePhase({ ...base, anchorTime: 5, currentSongTime: 4.4 });
    expect(r.timeUntilNextBeat).toBeCloseTo(0.1, 9);
    expect(r.beatIndex).toBe(3);
  });

  it("converts the wait to wall-clock time via the playback rate", () => {
    const slow = computeMetronomePhase({ ...base, playbackRate: 0.5, currentSongTime: 0.1 });
    expect(slow.timeUntilNextBeat).toBeCloseTo(0.8, 9);
    const fast = computeMetronomePhase({ ...base, playbackRate: 2, currentSongTime: 0.1 });
    expect(fast.timeUntilNextBeat).toBeCloseTo(0.2, 9);
  });

  it("does not change the beat index with playback rate", () => {
    const a = computeMetronomePhase({ ...base, currentSongTime: 1.1 });
    const b = computeMetronomePhase({ ...base, playbackRate: 0.5, currentSongTime: 1.1 });
    expect(b.beatIndex).toBe(a.beatIndex);
  });

  it.each([
    [0, 1],
    [-10, 1],
    [NaN, 1],
    [120, 0],
    [120, -1],
    [120, NaN],
  ])("returns a harmless zero phase for bpm=%s rate=%s", (bpm, rate) => {
    expect(computeMetronomePhase({ ...base, detectedBpm: bpm, playbackRate: rate, currentSongTime: 3.3 })).toEqual({
      timeUntilNextBeat: 0,
      beatIndex: 0,
    });
  });

  it("never produces a wait longer than one beat interval", () => {
    for (let t = 0; t < 10; t += 0.137) {
      const r = computeMetronomePhase({ ...base, detectedBpm: 97, currentSongTime: t, anchorTime: 0.21 });
      expect(r.timeUntilNextBeat).toBeGreaterThanOrEqual(0);
      expect(r.timeUntilNextBeat).toBeLessThanOrEqual(60 / 97);
    }
  });
});

describe("countInDurationSeconds", () => {
  it("is bars * beatsPerBar * 60 / bpm", () => {
    expect(countInDurationSeconds(120, 1)).toBe(2);
    expect(countInDurationSeconds(60, 2)).toBe(8);
    expect(countInDurationSeconds(90, 1, 3)).toBeCloseTo(2, 9);
  });

  it.each([[0, 1], [-5, 1], [NaN, 1], [120, 0], [120, -1]])("is 0 for bpm=%s bars=%s", (bpm, bars) => {
    expect(countInDurationSeconds(bpm, bars)).toBe(0);
  });
});
