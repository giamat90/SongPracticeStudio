import { describe, expect, it, vi } from "vitest";
import { FFT_SIZE } from "../lib/chordSpectrum";
import { GATE_DB, LiveTrace, type LiveReading } from "../lib/liveInput";
import { MIDI_LOW, ROLL_HOP } from "../lib/noteRoll";
import type { LiveSource } from "./liveInput";
import { StartCancelled, TICK_MS, createLiveMonitor, type MonitorDeps } from "./liveMonitor";

const SR = 44100;

function tone(freq: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function fakeSource(samples: Float32Array = tone(220)) {
  let ended: (() => void) | null = null;
  const source: LiveSource & { end: () => void } = {
    sampleRate: SR,
    label: "Fake input",
    read: vi.fn(() => samples),
    onEnded: (callback) => {
      ended = callback;
    },
    close: vi.fn(),
    end: () => ended?.(),
  };
  return source;
}

function setup(overrides: Partial<MonitorDeps> = {}, source = fakeSource()) {
  let tick: (() => void) | null = null;
  const published: LiveReading[] = [];
  const clock = { playing: false, time: 10, latencyS: 0.2 };
  const deps: MonitorDeps = {
    open: vi.fn(async () => source),
    deviceId: () => "device-1",
    clock: () => clock,
    trace: new LiveTrace(),
    publish: (reading) => published.push(reading),
    lost: vi.fn(),
    every: vi.fn((callback: () => void) => {
      tick = callback;
      return 42;
    }),
    cancelEvery: vi.fn(),
    ...overrides,
  };
  return { deps, source, published, clock, tick: () => tick!(), hasTimer: () => tick !== null };
}

const a3Frame = (time: number) => Math.floor(time / ROLL_HOP);
const A3 = 57 - MIDI_LOW;

describe("createLiveMonitor", () => {
  it("opens the chosen device, then looks at it every TICK_MS", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    expect(monitor.running).toBe(false);
    await expect(monitor.start()).resolves.toBe("Fake input");
    expect(t.deps.open).toHaveBeenCalledWith("device-1");
    expect(t.deps.every).toHaveBeenCalledWith(expect.any(Function), TICK_MS);
    expect(monitor.running).toBe(true);
  });

  it("publishes each reading and writes its notes at the playhead while paused", async () => {
    const t = setup();
    await createLiveMonitor(t.deps).start();
    t.tick();
    expect(t.published).toHaveLength(1);
    expect(t.published[0].notes[A3]).toBeGreaterThan(200);
    expect(t.deps.trace.strength(a3Frame(10), A3)).toBeGreaterThan(200);
  });

  it("writes earlier in the song while it plays: the round trip and half a window back", async () => {
    const t = setup();
    t.clock.playing = true;
    await createLiveMonitor(t.deps).start();
    t.tick();
    const where = 10 - 0.2 - FFT_SIZE / 2 / SR;
    expect(t.deps.trace.strength(a3Frame(where), A3)).toBeGreaterThan(200);
    expect(t.deps.trace.strength(a3Frame(10), A3)).toBe(0);
  });

  it("a silent input erases the stale notes of that moment and publishes no spectrum", async () => {
    const quiet = new Float32Array(FFT_SIZE);
    const source = fakeSource(tone(220));
    const t = setup({}, source);
    await createLiveMonitor(t.deps).start();
    t.tick();
    expect(t.deps.trace.strength(a3Frame(10), A3)).toBeGreaterThan(0);
    vi.mocked(source.read).mockReturnValue(quiet);
    t.tick();
    expect(t.published[1].db).toBeNull();
    expect(t.published[1].levelDb).toBeLessThan(GATE_DB);
    expect(t.deps.trace.strength(a3Frame(10), A3)).toBe(0);
  });

  it("skips a tick when the input has nothing to read yet", async () => {
    const source = fakeSource();
    vi.mocked(source.read).mockReturnValue(null);
    const t = setup({}, source);
    await createLiveMonitor(t.deps).start();
    t.tick();
    expect(t.published).toHaveLength(0);
  });

  it("opens once however many times it is started", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    await Promise.all([monitor.start(), monitor.start()]);
    await monitor.start();
    expect(t.deps.open).toHaveBeenCalledTimes(1);
    expect(t.deps.every).toHaveBeenCalledTimes(1);
  });

  it("stops: gives the device back, stops the timer, forgets the notes", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    await monitor.start();
    t.tick();
    monitor.stop();
    expect(t.source.close).toHaveBeenCalledTimes(1);
    expect(t.deps.cancelEvery).toHaveBeenCalledWith(42);
    expect(t.deps.trace.size).toBe(0);
    expect(monitor.running).toBe(false);
  });

  it("ignores a tick that arrives after stop", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    await monitor.start();
    monitor.stop();
    t.tick();
    expect(t.published).toHaveLength(0);
  });

  it("gives the device back when stopped while it is still opening", async () => {
    let finishOpening: (source: LiveSource) => void = () => {};
    const source = fakeSource();
    const t = setup({ open: () => new Promise<LiveSource>((resolve) => { finishOpening = resolve; }) });
    const monitor = createLiveMonitor(t.deps);
    const started = monitor.start();
    monitor.stop();
    finishOpening(source);
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(t.hasTimer()).toBe(false);
    expect(monitor.running).toBe(false);
  });

  it("can be started again after a stop", async () => {
    const first = fakeSource();
    const second = fakeSource();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const t = setup({ open });
    const monitor = createLiveMonitor(t.deps);
    await monitor.start();
    monitor.stop();
    await monitor.start();
    expect(open).toHaveBeenCalledTimes(2);
    expect(monitor.running).toBe(true);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("rejects when the device cannot be opened, and can be tried again", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("Input unavailable: busy")).mockResolvedValueOnce(fakeSource());
    const monitor = createLiveMonitor(setup({ open }).deps);
    await expect(monitor.start()).rejects.toThrow("Input unavailable: busy");
    expect(monitor.running).toBe(false);
    await expect(monitor.start()).resolves.toBe("Fake input");
  });

  it("lets go and says so when the device goes away", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    await monitor.start();
    t.source.end();
    expect(t.deps.lost).toHaveBeenCalledWith("The input was disconnected.");
    expect(t.source.close).toHaveBeenCalledTimes(1);
    expect(monitor.running).toBe(false);
  });

  it("does not report a device that was already given back", async () => {
    const t = setup();
    const monitor = createLiveMonitor(t.deps);
    await monitor.start();
    monitor.stop();
    t.source.end();
    expect(t.deps.lost).not.toHaveBeenCalled();
  });
});
