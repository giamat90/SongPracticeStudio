import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VocalRecorder } from "./recorder";

// ─── fakes ─────────────────────────────────────────────────────────────────

interface Node { connections: Array<{ to: unknown; output?: number; input?: number }>; disconnected: boolean }

let contexts: FakeContext[];
let channelLevels: number[];
let constructFailsWithRate = false;
let getUserMedia: ReturnType<typeof vi.fn>;
let recorders: FakeMediaRecorder[];
let supportedTypes: string[];
let stopTracks: ReturnType<typeof vi.fn>[];

function node(extra: object = {}): Node & Record<string, unknown> {
  const n: Node & Record<string, unknown> = {
    connections: [],
    disconnected: false,
    connect(to: unknown, output?: number, input?: number) { n.connections.push({ to, output, input }); },
    disconnect() { n.disconnected = true; },
    ...extra,
  };
  return n;
}

class FakeContext {
  state: AudioContextState = "running";
  options: unknown;
  analysers: Array<{ level: number; disconnect: ReturnType<typeof vi.fn> }> = [];
  closed = false;
  dest = node({ stream: { id: "processed" } });
  gains: Array<Node & { gain: { value: number } }> = [];
  merger = node();
  splitter = node();
  source = node();
  constructor(options?: unknown) {
    if (constructFailsWithRate && options) throw new Error("sampleRate unsupported");
    this.options = options;
    contexts.push(this);
  }
  createMediaStreamSource() { return this.source; }
  createMediaStreamDestination() { return this.dest; }
  createChannelSplitter() { return this.splitter; }
  createChannelMerger() { return this.merger; }
  createGain() {
    const g = node({ gain: { value: 1 } }) as unknown as Node & { gain: { value: number } };
    this.gains.push(g);
    return g;
  }
  createAnalyser() {
    const index = this.analysers.length;
    const a = {
      level: channelLevels[index] ?? 0,
      fftSize: 0,
      getFloatTimeDomainData(buf: Float32Array) { buf.fill(this.level); },
      disconnect: vi.fn(),
    };
    this.analysers.push(a);
    return a;
  }
  close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
}

class FakeMediaRecorder {
  static isTypeSupported(t: string) { return supportedTypes.includes(t); }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onstop: (() => void) | null = null;
  startedWith: number | null = null;
  constructor(public stream: unknown, public options: { mimeType?: string }) {
    this.mimeType = options.mimeType ?? "";
    recorders.push(this);
  }
  start(timeslice: number) { this.state = "recording"; this.startedWith = timeslice; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  emitData(bytes: number[]) { this.ondataavailable?.({ data: new Blob([Uint8Array.from(bytes)]) }); }
}

function fakeStream(channelCount: number | undefined) {
  const stop = vi.fn();
  stopTracks.push(stop);
  return {
    getAudioTracks: () => [{ getSettings: () => (channelCount === undefined ? {} : { channelCount }) }],
    getTracks: () => [{ stop }],
  };
}

beforeEach(() => {
  contexts = [];
  recorders = [];
  stopTracks = [];
  channelLevels = [];
  constructFailsWithRate = false;
  supportedTypes = ["audio/webm;codecs=opus", "audio/webm"];
  getUserMedia = vi.fn(async () => fakeStream(1));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => vi.useRealTimers());

async function initWithChannels(n: number, levels: number[] = []) {
  channelLevels = levels;
  getUserMedia.mockResolvedValue(fakeStream(n));
  const rec = new VocalRecorder();
  const pending = rec.init("mic");
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  return { rec, ctx: contexts[0] };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("VocalRecorder.init", () => {
  it("requests a raw mic: processing off, 44.1 kHz, pinned to the chosen device", async () => {
    const rec = new VocalRecorder();
    await rec.init("mic-1");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: "mic-1" },
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        sampleRate: 44100,
      },
      video: false,
    });
  });

  it("omits the device constraint for the default mic (null, undefined or empty)", async () => {
    for (const id of [null, undefined, ""]) {
      getUserMedia.mockClear();
      await new VocalRecorder().init(id);
      expect(getUserMedia.mock.calls[0][0].audio).not.toHaveProperty("deviceId");
    }
  });

  it("wires a mono mic straight to the recording destination", async () => {
    const { ctx } = await initWithChannels(1);
    expect(ctx.options).toEqual({ sampleRate: 44100 });
    expect(ctx.source.connections.map((c) => c.to)).toEqual([ctx.dest]);
    expect(ctx.splitter.connections).toHaveLength(0);
  });

  it("treats an unreported channel count as mono", async () => {
    getUserMedia.mockResolvedValue(fakeStream(undefined));
    const rec = new VocalRecorder();
    await rec.init();
    expect(contexts[0].source.connections.map((c) => c.to)).toEqual([contexts[0].dest]);
  });

  it("falls back to a default-rate context (with a warning) when 44.1 kHz is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    constructFailsWithRate = true;
    await new VocalRecorder().init("mic");
    expect(contexts).toHaveLength(1);
    expect(contexts[0].options).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("propagates a getUserMedia failure", async () => {
    getUserMedia.mockRejectedValue(new Error("NotAllowedError"));
    await expect(new VocalRecorder().init()).rejects.toThrow("NotAllowedError");
  });
});

describe("two-channel interface: only the live channel is recorded", () => {
  it("routes just the live channel at unity gain (the 'one input wired' case)", async () => {
    const { ctx } = await initWithChannels(2, [0.2, 0.0001]);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0].gain.value).toBe(1);
    expect(ctx.splitter.connections.find((c) => c.to === ctx.gains[0])?.output).toBe(0);
    expect(ctx.merger.connections.map((c) => c.to)).toEqual([ctx.dest]);
  });

  it("picks channel 1 when that is the live one", async () => {
    const { ctx } = await initWithChannels(2, [0, 0.2]);
    expect(ctx.splitter.connections.filter((c) => c.to === ctx.gains[0])[0].output).toBe(1);
  });

  it("with both channels live, splits level so the sum is not louder than the source", async () => {
    const { ctx } = await initWithChannels(2, [0.2, 0.2]);
    expect(ctx.gains).toHaveLength(2);
    const sum = ctx.gains.reduce((a, g) => a + g.gain.value, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("with neither channel live (silence at init) averages them", async () => {
    const { ctx } = await initWithChannels(2, [0, 0]);
    expect(ctx.gains.map((g) => g.gain.value)).toEqual([0.5, 0.5]);
  });

  it("measures every channel before deciding, then releases its analysers", async () => {
    const { ctx } = await initWithChannels(2, [0.2, 0]);
    const analysers = ctx.analysers.slice(0, 2);
    expect(analysers).toHaveLength(2);
    analysers.forEach((a) => expect(a.disconnect).toHaveBeenCalled());
  });

  it("applies the same logic for 4 channels with a single live one", async () => {
    const { ctx } = await initWithChannels(4, [0, 0, 0.3, 0]);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.splitter.connections.find((c) => c.to === ctx.gains[0])?.output).toBe(2);
  });
});

describe("VocalRecorder.start / stop", () => {
  it("refuses to start before init", () => {
    expect(() => new VocalRecorder().start()).toThrow(/call init\(\) first/);
  });

  it("records the processed stream in 100 ms slices with the best supported container", async () => {
    const { rec, ctx } = await initWithChannels(1);
    rec.start();
    expect(recorders[0].stream).toBe(ctx.dest.stream);
    expect(recorders[0].options).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(recorders[0].startedWith).toBe(100);
    expect(rec.isRecording).toBe(true);
  });

  it("falls through the preference list and finally lets the browser choose", async () => {
    supportedTypes = ["audio/ogg;codecs=opus"];
    const a = await initWithChannels(1);
    a.rec.start();
    expect(recorders[0].options).toEqual({ mimeType: "audio/ogg;codecs=opus" });

    supportedTypes = [];
    const b = await initWithChannels(1);
    b.rec.start();
    expect(recorders[1].options).toEqual({});
  });

  it("assembles the chunks into one blob on stop and clears state", async () => {
    const { rec } = await initWithChannels(1);
    rec.start();
    recorders[0].emitData([1, 2]);
    recorders[0].emitData([3]);
    recorders[0].ondataavailable?.({ data: new Blob([]) });
    const blob = await rec.stop();
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(rec.isRecording).toBe(false);
  });

  it("starts a fresh take without the previous take's chunks", async () => {
    const { rec } = await initWithChannels(1);
    rec.start();
    recorders[0].emitData([1, 2, 3]);
    await rec.stop();
    rec.start();
    recorders[1].emitData([9]);
    expect((await rec.stop()).size).toBe(1);
  });

  it("rejects stop when nothing is recording, naming the state", async () => {
    const { rec } = await initWithChannels(1);
    await expect(rec.stop()).rejects.toThrow("Not recording (state: no recorder)");
    rec.start();
    await rec.stop();
    await expect(rec.stop()).rejects.toThrow("Not recording (state: inactive)");
  });

  it("logs a MediaRecorder error and clears the recording flag", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rec } = await initWithChannels(1);
    rec.start();
    recorders[0].onerror?.(new Error("boom"));
    expect(err).toHaveBeenCalled();
    expect(rec.isRecording).toBe(false);
  });
});

describe("streams and cleanup", () => {
  it("exposes the raw and processed streams", async () => {
    const { rec, ctx } = await initWithChannels(1);
    expect(rec.getStream()).not.toBeNull();
    expect(rec.getProcessedStream()).toBe(ctx.dest.stream);
    expect(new VocalRecorder().getProcessedStream()).toBeNull();
  });

  it("releaseStream stops the mic tracks so Windows leaves communication mode", async () => {
    const { rec } = await initWithChannels(1);
    rec.releaseStream();
    expect(stopTracks[0]).toHaveBeenCalled();
    expect(rec.getStream()).toBeNull();
    expect(() => rec.releaseStream()).not.toThrow();
  });

  it("dispose stops an active recording, frees the mic and closes the context", async () => {
    const { rec, ctx } = await initWithChannels(2, [0.2, 0.2]);
    rec.start();
    rec.dispose();
    expect(recorders[0].state).toBe("inactive");
    expect(stopTracks[0]).toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
    expect(ctx.source.disconnected).toBe(true);
    expect(ctx.merger.disconnected).toBe(true);
    expect(ctx.gains.every((g) => g.disconnected)).toBe(true);
    expect(rec.isRecording).toBe(false);
    expect(rec.getProcessedStream()).toBeNull();
  });

  it("dispose on a fresh recorder is harmless", () => {
    expect(() => new VocalRecorder().dispose()).not.toThrow();
  });

  it("warns when closing the context fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rec, ctx } = await initWithChannels(1);
    ctx.close = () => Promise.reject(new Error("already closed"));
    rec.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("[recorder] AudioContext close:", expect.any(Error));
  });
});
