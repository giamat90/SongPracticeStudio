import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChordSynth, type SynthContext } from "./chordSynth";

interface FakeOsc { frequency: { value: number }; started: boolean; stopped: boolean; connect: () => void; start: () => void; stop: () => void }

function fakeContext() {
  const oscillators: FakeOsc[] = [];
  const gains: { gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn> }[] = [];
  const ctx: SynthContext & { sinkIds: string[]; resumed: number } = {
    currentTime: 1,
    state: "suspended",
    destination: {},
    sinkIds: [],
    resumed: 0,
    resume() { this.resumed += 1; return Promise.resolve(); },
    createGain() {
      const g = {
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
        connect: vi.fn(),
      };
      gains.push(g);
      return g;
    },
    createOscillator() {
      const o: FakeOsc = {
        frequency: { value: 0 }, started: false, stopped: false,
        connect: () => undefined,
        start() { o.started = true; },
        stop() { o.stopped = true; },
      };
      oscillators.push(o);
      return o;
    },
    setSinkId(id: string) { this.sinkIds.push(id); return Promise.resolve(); },
  };
  return { ctx, oscillators, gains };
}

describe("ChordSynth", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sounds a bass note and the chord tones, each with an overtone", () => {
    const { ctx, oscillators } = fakeContext();
    const synth = new ChordSynth(() => ctx);
    expect(synth.play({ chord: "C:maj" })).toBe(true);
    expect(oscillators).toHaveLength((1 + 3) * 2);
    expect(oscillators.every((o) => o.started)).toBe(true);
    expect(ctx.resumed).toBeGreaterThan(0);
  });

  it("is tuned to the recording: the cents move every oscillator", () => {
    const flat = fakeContext();
    const sharp = fakeContext();
    new ChordSynth(() => flat.ctx).play({ chord: "A:min", cents: 0 });
    new ChordSynth(() => sharp.ctx).play({ chord: "A:min", cents: 30 });
    flat.oscillators.forEach((o, i) => {
      expect(1200 * Math.log2(sharp.oscillators[i].frequency.value / o.frequency.value)).toBeCloseTo(30, 5);
    });
  });

  it("lets go of a chord after its time and replaces one that still sounds", () => {
    const { ctx, oscillators } = fakeContext();
    const synth = new ChordSynth(() => ctx);
    synth.play({ chord: "C:maj" }, 1);
    vi.advanceTimersByTime(1000);
    expect(oscillators.every((o) => o.stopped)).toBe(true);

    const before = oscillators.length;
    synth.play({ chord: "G:maj" }, 5);
    synth.play({ chord: "D:min" }, 5);
    expect(oscillators.slice(before, before + 8).every((o) => o.stopped)).toBe(true);
    expect(oscillators.slice(before + 8).every((o) => !o.stopped)).toBe(true);
  });

  it("holds a chord until stopped, and asking again for the same one starts nothing new", () => {
    const { ctx, oscillators } = fakeContext();
    const synth = new ChordSynth(() => ctx);
    synth.hold({ chord: "C:maj" });
    const count = oscillators.length;
    synth.hold({ chord: "C:maj" });
    expect(oscillators).toHaveLength(count);
    vi.advanceTimersByTime(60_000);
    expect(oscillators.every((o) => !o.stopped)).toBe(true);
    synth.hold({ chord: "F:maj" });
    expect(oscillators.slice(0, count).every((o) => o.stopped)).toBe(true);
    synth.stop();
    expect(oscillators.every((o) => o.stopped)).toBe(true);
  });

  it("does nothing for a chord it cannot voice", () => {
    const { ctx, oscillators } = fakeContext();
    const synth = new ChordSynth(() => ctx);
    expect(synth.play({ chord: "N" })).toBe(false);
    expect(synth.hold({ chord: "X:wat" })).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it("opens its context on the chosen output device and follows a change", () => {
    const made: string[] = [];
    const { ctx } = fakeContext();
    const synth = new ChordSynth((sinkId) => { made.push(sinkId); return ctx; });
    synth.setOutputDevice("speakers");
    synth.play({ chord: "C:maj" });
    expect(made).toEqual(["speakers"]);
    synth.setOutputDevice("headphones");
    expect(ctx.sinkIds).toEqual(["headphones"]);
  });
});
