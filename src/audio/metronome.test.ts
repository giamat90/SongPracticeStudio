import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface Click { freq: number; time: number; peak: number }

let clicks: Click[];
let contexts: FakeContext[];
let ctxState: AudioContextState;

class FakeContext {
  currentTime = 0;
  state: AudioContextState = ctxState;
  destination = {};
  options: unknown;
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  setSinkId = vi.fn(async () => {});
  constructor(options?: unknown) { this.options = options; contexts.push(this); }
  createOscillator() {
    const click: Click = { freq: 0, time: 0, peak: 0 };
    const osc = {
      frequency: { set value(v: number) { click.freq = v; } },
      connect: vi.fn(),
      start: (t: number) => { click.time = t; clicks.push(click); },
      stop: vi.fn(),
    };
    (this as unknown as { lastClick: Click }).lastClick = click;
    return osc;
  }
  createGain() {
    const owner = this as unknown as { lastClick: Click };
    return {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: (v: number) => { owner.lastClick.peak = v; },
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
}

async function freshMetronome() {
  vi.resetModules();
  return (await import("./metronome")).metronome;
}

beforeEach(() => {
  clicks = [];
  contexts = [];
  ctxState = "running";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("AudioContext", FakeContext);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("metronome scheduling", () => {
  it("schedules clicks one beat apart, accenting beat 0 of each bar", async () => {
    const m = await freshMetronome();
    m.start(120, 0, 0);
    const ctx = contexts[0];
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.025;
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    const gaps = clicks.slice(1).map((c, i) => c.time - clicks[i].time);
    for (const g of gaps) expect(g).toBeCloseTo(0.5, 9);
    expect(clicks[0].freq).toBe(1500);
    expect(clicks[0].peak).toBe(0.9);
    expect(clicks[1].freq).toBe(900);
    expect(clicks[1].peak).toBe(0.5);
    if (clicks[4]) expect(clicks[4].freq).toBe(1500);
    m.stop();
  });

  it("looks ahead at most 100 ms, so it never floods the audio graph", async () => {
    const m = await freshMetronome();
    m.start(600, 0, 0);
    expect(clicks.length).toBeLessThanOrEqual(2);
    m.stop();
  });

  it("starts the first click no sooner than 50 ms out, and honours a longer phase delay", async () => {
    const m = await freshMetronome();
    m.start(60, 0.4, 0);
    const ctx = contexts[0];
    ctx.currentTime = 0.31;
    await vi.advanceTimersByTimeAsync(25);
    expect(clicks[0].time).toBeCloseTo(0.4, 9);
    m.stop();
  });

  it("starts on the requested beat of the bar (negative and overflowing values wrap)", async () => {
    const m = await freshMetronome();
    m.start(60, 0, 2);
    expect(clicks[0].freq).toBe(900);
    m.stop();

    clicks = [];
    const m2 = await freshMetronome();
    m2.start(60, 0, -4);
    expect(clicks[0].freq).toBe(1500);
    m2.stop();

    clicks = [];
    const m3 = await freshMetronome();
    m3.start(60, 0, 6);
    expect(clicks[0].freq).toBe(900);
    m3.stop();
  });

  it("reuses one AudioContext across restarts and resyncs the phase instead of stacking timers", async () => {
    const m = await freshMetronome();
    m.start(120, 0, 0);
    m.start(90, 0, 0);
    expect(contexts).toHaveLength(1);
    const before = clicks.length;
    contexts[0].currentTime += 0.2;
    await vi.advanceTimersByTimeAsync(25);
    expect(clicks.length - before).toBeLessThanOrEqual(2);
    m.stop();
  });

  it("stop cancels the scheduler and suspends the context", async () => {
    const m = await freshMetronome();
    m.start(120);
    m.stop();
    const count = clicks.length;
    contexts[0].currentTime += 5;
    await vi.advanceTimersByTimeAsync(500);
    expect(clicks).toHaveLength(count);
    expect(contexts[0].suspend).toHaveBeenCalled();
  });

  it("stop before start is harmless", async () => {
    const m = await freshMetronome();
    expect(() => m.stop()).not.toThrow();
  });

  it("resumes a suspended context", async () => {
    ctxState = "suspended";
    const m = await freshMetronome();
    m.start(120);
    expect(contexts[0].resume).toHaveBeenCalled();
    m.stop();
  });

  it("warns, rather than throwing, when resume or suspend fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctxState = "suspended";
    const m = await freshMetronome();
    m.start(120);
    contexts[0].resume.mockRejectedValue(new Error("x"));
    contexts[0].suspend.mockRejectedValue(new Error("y"));
    ctxState = "suspended";
    contexts[0].state = "suspended";
    m.start(120);
    m.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("Metronome: failed to resume AudioContext", expect.any(Error));
    expect(warn).toHaveBeenCalledWith("Metronome: failed to suspend AudioContext", expect.any(Error));
  });
});

describe("metronome output routing", () => {
  it("creates its context on the pinned output when one was set first", async () => {
    const m = await freshMetronome();
    m.setOutputDevice("hw-out");
    m.start(120);
    expect(contexts[0].options).toEqual({ sinkId: "hw-out" });
    m.stop();
  });

  it("uses the default output when nothing was pinned", async () => {
    const m = await freshMetronome();
    m.start(120);
    expect(contexts[0].options).toBeUndefined();
    m.stop();
  });

  it("re-routes a live context through setSinkId", async () => {
    const m = await freshMetronome();
    m.start(120);
    m.setOutputDevice("later");
    expect(contexts[0].setSinkId).toHaveBeenCalledWith("later");
    m.stop();
  });

  it("warns when a live re-route fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await freshMetronome();
    m.start(120);
    contexts[0].setSinkId.mockRejectedValue(new Error("busy"));
    m.setOutputDevice("later");
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("Metronome: setSinkId failed", expect.any(Error));
    m.stop();
  });

  it("tolerates browsers without AudioContext.setSinkId", async () => {
    const m = await freshMetronome();
    m.start(120);
    (contexts[0] as unknown as { setSinkId?: unknown }).setSinkId = undefined;
    expect(() => m.setOutputDevice("x")).not.toThrow();
    m.stop();
  });
});
