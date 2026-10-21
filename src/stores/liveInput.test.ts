import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSource } from "../audio/liveInput";

// The store's real wiring: how the monitor reads the player, the output device and the recorder.

const h = vi.hoisted(() => ({
  state: { time: 3 },
  engine: null as { setOutputDevice: ReturnType<typeof vi.fn> } | null,
  open: vi.fn(),
}));

vi.mock("../audio/liveInput", () => ({ openLiveInput: h.open }));
vi.mock("../lib/tauri", () => ({}));
vi.mock("@giamat90/mps-core/metronome", () => ({ metronome: { start: vi.fn(), stop: vi.fn() } }));
vi.mock("@giamat90/mps-core/recorder", () => ({ VocalRecorder: class {} }));
vi.mock("../audio/engine", () => ({
  AudioEngine: class {
    setOutputDevice = vi.fn(async () => {});
    setActiveTakeTrack = vi.fn();
    setTakeGains = vi.fn();
    setAudibleTakeTracks = vi.fn();
    getCurrentTime = vi.fn(() => h.state.time);
    onTimeUpdate() {}
    onFinish() {}
    onScrollChange() {}
    constructor() { h.engine = this; }
  },
}));

function source(label = "Focusrite") {
  const made: LiveSource = {
    sampleRate: 44100,
    label,
    read: vi.fn((): Float32Array | null => new Float32Array(16384)),
    onEnded: vi.fn(),
    close: vi.fn(),
  };
  return made;
}

type Modules = {
  live: typeof import("./liveInput");
  player: typeof import("./player");
  singletons: typeof import("./player/singletons");
};
let m: Modules;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { mediaDevices: { addEventListener: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
  h.open.mockReset();
  h.state.time = 3;
  vi.resetModules();
  const player = await import("./player");
  m = { player, live: await import("./liveInput"), singletons: await import("./player/singletons") };
  player.getEngine();
});

afterEach(() => {
  m.live.useLiveInput.getState().stop();
  vi.useRealTimers();
});

describe("live input wiring", () => {
  it("opens the input chosen in the mic menu", async () => {
    h.open.mockResolvedValue(source());
    m.player.usePlayerStore.setState({ selectedDeviceId: "mic-1" });
    await m.live.useLiveInput.getState().start();
    expect(h.open).toHaveBeenCalledWith("mic-1");
    expect(m.live.useLiveInput.getState()).toMatchObject({ status: "on", label: "Focusrite" });
  });

  it("keeps the output the user chose, which opening an input can move", async () => {
    h.open.mockResolvedValue(source());
    m.player.usePlayerStore.setState({ selectedOutputDeviceId: "out-2" });
    await m.live.useLiveInput.getState().start();
    expect(h.engine!.setOutputDevice).toHaveBeenCalledWith("out-2");
  });

  it("leaves the output alone when none was chosen", async () => {
    h.open.mockResolvedValue(source());
    await m.live.useLiveInput.getState().start();
    expect(h.engine!.setOutputDevice).not.toHaveBeenCalled();
  });

  it("still listens when the output cannot be kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.open.mockResolvedValue(source());
    m.player.usePlayerStore.setState({ selectedOutputDeviceId: "out-2" });
    h.engine!.setOutputDevice.mockRejectedValueOnce(new Error("gone"));
    await m.live.useLiveInput.getState().start();
    expect(m.live.useLiveInput.getState().status).toBe("on");
    expect(warn).toHaveBeenCalled();
  });

  it("writes what it hears at the playhead while paused", async () => {
    const loud = new Float32Array(16384);
    for (let i = 0; i < loud.length; i++) loud[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 44100);
    const src = source();
    src.read = vi.fn(() => loud);
    h.open.mockResolvedValue(src);
    h.state.time = 10;
    await m.live.useLiveInput.getState().start();
    vi.advanceTimersByTime(150);
    expect(m.live.liveTrace.frame(Math.floor(10 / 0.125))?.[57 - 28]).toBeGreaterThan(200);
    expect(m.live.useLiveInput.getState().reading?.db).not.toBeNull();
  });

  it("writes earlier by the calibrated round trip while the song plays", async () => {
    const loud = new Float32Array(16384);
    for (let i = 0; i < loud.length; i++) loud[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 44100);
    const src = source();
    src.read = vi.fn(() => loud);
    h.open.mockResolvedValue(src);
    h.state.time = 10;
    m.player.usePlayerStore.setState({ isPlaying: true, selectedDeviceId: "mic-1", recordingOffsets: { "mic-1": { offset: 250 } } });
    await m.live.useLiveInput.getState().start();
    vi.advanceTimersByTime(150);
    const at = 10 - 0.25 - 16384 / 2 / 44100;
    expect(m.live.liveTrace.frame(Math.floor(at / 0.125))?.[57 - 28]).toBeGreaterThan(200);
    expect(m.live.liveTrace.frame(Math.floor(10 / 0.125))).toBeUndefined();
  });

  it("does not listen while a take is being recorded", async () => {
    m.player.usePlayerStore.setState({ isRecording: true });
    await m.live.useLiveInput.getState().start();
    expect(h.open).not.toHaveBeenCalled();
    expect(m.live.useLiveInput.getState()).toMatchObject({ status: "error", error: expect.stringMatching(/recording/i) });
  });

  it("is released by the gate startRecording uses", async () => {
    const src = source();
    h.open.mockResolvedValue(src);
    await m.live.useLiveInput.getState().start();
    m.singletons.liveMonitorGate.stop?.();
    expect(src.close).toHaveBeenCalled();
    expect(m.live.useLiveInput.getState().status).toBe("off");
  });

  it("moves to the new input when another is chosen while listening", async () => {
    const first = source("First");
    const second = source("Second");
    h.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    m.player.usePlayerStore.setState({ selectedDeviceId: "mic-1" });
    await m.live.useLiveInput.getState().start();
    m.player.usePlayerStore.setState({ selectedDeviceId: "mic-2" });
    await vi.waitFor(() => expect(m.live.useLiveInput.getState().label).toBe("Second"));
    expect(first.close).toHaveBeenCalled();
    expect(h.open).toHaveBeenLastCalledWith("mic-2");
  });

  it("ignores a change of input while it is off", async () => {
    m.player.usePlayerStore.setState({ selectedDeviceId: "mic-1" });
    m.player.usePlayerStore.setState({ selectedDeviceId: "mic-2" });
    expect(h.open).not.toHaveBeenCalled();
  });
});
