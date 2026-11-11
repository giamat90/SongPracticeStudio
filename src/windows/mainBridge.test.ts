import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startMainBridge, type PlayerPort } from "./mainBridge";
import { EVT_COMMAND, EVT_DOCKED, EVT_ENVELOPE, EVT_HELLO, EVT_STATE } from "./protocol";

const take = (id: string) => ({ id, songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav`, startPosition: 0 });

const silenced = { value: false };
const hitEnvelope = vi.fn(async (_song: unknown, _cancelled: () => boolean): Promise<Float32Array | null> => Float32Array.from([0, 0.5, 1]));
const bars = { version: 1 as const, bars: [{ start: 0, num: 4, den: 4 }], end: 8, source: "edited" as const };

function harness() {
  const state: PlayerPort = {
    song: { id: "s1", title: "Song", stems: ["vocals"] } as PlayerPort["song"],
    isPlaying: false,
    currentTime: 0,
    duration: 200,
    transpose: 3,
    capo: 2,
    chordDetail: "easy",
    chordsRevision: 4,
    playbackRate: 1,
    activeTakeId: null,
    shownTakeIds: [],
    takePlayback: "all",
    mutedTakeIds: [],
    soloedTakeId: null,
    muteTakesWhileRecording: true,
    isRecording: false,
    takes: [take("t1"), take("t2")],
    meterMap: null,
    meterEdited: false,
    meterSelected: null,
    meterBusy: false,
    meterError: null,
    meterHistory: [],
    clickDensity: "pulses" as const,
    tapSession: null,
    applyMeter: vi.fn(async () => {}),
    undoMeter: vi.fn(async () => {}),
    resetMeter: vi.fn(async () => {}),
    detectMeter: vi.fn(async () => {}),
    startMeterFromGrid: vi.fn(async () => {}),
    finishTapping: vi.fn(async () => {}),
    cancelTapping: vi.fn(),
    clearMeterError: vi.fn(),
    selectBar: vi.fn(),
    setClickDensity: vi.fn(),
    startTapping: vi.fn(),
    addTap: vi.fn(),
    applyLoopRegion: vi.fn(),
    seek: vi.fn(),
    toggleTake: vi.fn(),
    deleteTake: vi.fn(async () => {}),
    renameTake: vi.fn(async () => {}),
  };
  let notify: () => void = () => {};
  const handlers = new Map<string, (p: unknown) => void>();
  const emitted: { event: string; payload: unknown }[] = [];
  const bridge = startMainBridge({
    player: { getState: () => state, subscribe: (l) => ((notify = l), () => {}) },
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    listen: async (event, cb) => {
      handlers.set(event, cb);
      return () => {};
    },
    now: () => 5000,
    takesSilenced: () => silenced.value,
    hitEnvelope,
  });
  return { state, emitted, bridge, fire: (e: string, p: unknown) => handlers.get(e)?.(p), notify: () => notify() };
}

beforeEach(() => {
  hitEnvelope.mockClear();
  silenced.value = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("analyzer main bridge", () => {
  it("sends nothing before a window says hello", async () => {
    const h = harness();
    await h.bridge;
    h.state.currentTime = 10;
    h.notify();
    expect(h.emitted).toEqual([]);
  });

  it("answers hello with the song, the takes and the transport", async () => {
    const h = harness();
    await h.bridge;
    h.state.currentTime = 42;
    h.state.activeTakeId = "t2";
    h.fire(EVT_HELLO, { panelId: "takes" });
    expect(h.emitted).toHaveLength(1);
    const msg = h.emitted[0].payload as { transport: { time: number }; shared: Record<string, unknown> };
    expect(h.emitted[0].event).toBe(EVT_STATE);
    expect(msg.transport.time).toBe(42);
    expect(msg.shared).toMatchObject({ duration: 200, transpose: 3, capo: 2, chordsRevision: 4, activeTakeId: "t2" });
    expect((msg.shared.takes as unknown[]).length).toBe(2);
    expect((msg.shared.song as { id: string }).id).toBe("s1");
  });

  it("tells the detached window when the main take mute or another solo silences the takes", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "takes" });
    silenced.value = true;
    h.state.currentTime = 1;
    h.notify();
    const last = h.emitted[h.emitted.length - 1].payload as { shared: { takesSilenced: boolean } };
    expect(last.shared.takesSilenced).toBe(true);
  });

  it("sends a new state when a take is added", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "takes" });
    h.state.takes = [...h.state.takes, take("t3")];
    h.notify();
    expect(h.emitted).toHaveLength(2);
    expect(((h.emitted[1].payload as { shared: { takes: unknown[] } }).shared.takes)).toHaveLength(3);
  });

  it("runs seek and the take commands against the main player", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "seek", time: 7 });
    h.fire(EVT_COMMAND, { type: "toggleTake", id: "t2" });
    h.fire(EVT_COMMAND, { type: "renameTake", id: "t1", name: "Chorus" });
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "t1" });
    expect(h.state.seek).toHaveBeenCalledWith(7);
    expect(h.state.toggleTake).toHaveBeenCalledWith("t2");
    expect(h.state.renameTake).toHaveBeenCalledWith("t1", "Chorus");
    expect(h.state.deleteTake).toHaveBeenCalledWith("t1");
  });

  it("does not act on a take that does not exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "nope" });
    h.fire(EVT_COMMAND, { type: "toggleTake", id: "nope" });
    expect(h.state.deleteTake).not.toHaveBeenCalled();
    expect(h.state.toggleTake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("drops commands it does not know", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "setPunchIn", time: 3 });
    h.fire(EVT_COMMAND, "seek");
    expect(h.state.seek).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reports a failed delete instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    (h.state.deleteTake as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk"));
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "t1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalled();
  });

  it("sends the bars and what the editor is doing, and how far Undo goes", async () => {
    const h = harness();
    await h.bridge;
    h.state.meterMap = bars;
    h.state.meterSelected = 0;
    h.state.meterHistory = [{}, {}];
    h.fire(EVT_HELLO, { panelId: "meter" });
    const shared = (h.emitted[0].payload as { shared: Record<string, unknown> }).shared;
    expect(shared).toMatchObject({ meterMap: bars, meterSelected: 0, meterUndoDepth: 2, meterEdited: false, clickDensity: "pulses", tapSession: null });
  });

  it("carries out the Meter's commands against the main player", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "applyMeter", map: bars, select: 0 });
    h.fire(EVT_COMMAND, { type: "undoMeter" });
    h.fire(EVT_COMMAND, { type: "resetMeter" });
    h.fire(EVT_COMMAND, { type: "detectMeter" });
    h.fire(EVT_COMMAND, { type: "startMeterFromGrid" });
    h.fire(EVT_COMMAND, { type: "finishTapping" });
    h.fire(EVT_COMMAND, { type: "cancelTapping" });
    h.fire(EVT_COMMAND, { type: "clearMeterError" });
    h.fire(EVT_COMMAND, { type: "selectBar", index: 2 });
    h.fire(EVT_COMMAND, { type: "setClickDensity", density: "bars" });
    h.fire(EVT_COMMAND, { type: "startTapping", session: { kind: "beats", den: 4, perBar: 4, pulse: 0.5 } });
    h.fire(EVT_COMMAND, { type: "addTap", time: 3.25 });
    h.fire(EVT_COMMAND, { type: "applyLoopRegion", start: 1, end: 2 });
    expect(h.state.applyMeter).toHaveBeenCalledWith(bars, 0);
    for (const name of ["undoMeter", "resetMeter", "detectMeter", "startMeterFromGrid", "finishTapping", "cancelTapping", "clearMeterError"] as const) {
      expect(h.state[name], name).toHaveBeenCalledTimes(1);
    }
    expect(h.state.selectBar).toHaveBeenCalledWith(2);
    expect(h.state.setClickDensity).toHaveBeenCalledWith("bars");
    expect(h.state.startTapping).toHaveBeenCalledWith({ kind: "beats", den: 4, perBar: 4, pulse: 0.5 });
    expect(h.state.addTap).toHaveBeenCalledWith(3.25);
    expect(h.state.applyLoopRegion).toHaveBeenCalledWith(1, 2);
  });

  it("does not pass bars of the wrong shape on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "applyMeter", map: { bars: "x" }, select: 0 });
    expect(h.state.applyMeter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("reports a failed bar change instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    (h.state.applyMeter as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk"));
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "applyMeter", map: bars, select: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalled();
  });

  it("sends the drum envelope to the Meter window, and to no other", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "lyrics" });
    await vi.advanceTimersByTimeAsync(0);
    expect(hitEnvelope).not.toHaveBeenCalled();
    h.fire(EVT_HELLO, { panelId: "meter" });
    await vi.advanceTimersByTimeAsync(0);
    const sent = h.emitted.filter((e) => e.event === EVT_ENVELOPE);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ songId: "s1", fps: 100, values: [0, 0.5, 1] });
  });

  it("stops reading the drums when the Meter window is docked before it is done", async () => {
    let cancelled: () => boolean = () => false;
    hitEnvelope.mockImplementationOnce(async (_song, c) => {
      cancelled = c;
      return null;
    });
    const h = harness();
    const running = await h.bridge;
    h.fire(EVT_HELLO, { panelId: "meter" });
    running.dispose();
    expect(cancelled()).toBe(true);
  });

  it("stops publishing once every window is docked", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "lyrics" });
    h.fire(EVT_DOCKED, "lyrics");
    const before = h.emitted.length;
    h.state.currentTime = 99;
    h.notify();
    vi.advanceTimersByTime(500);
    expect(h.emitted.length).toBe(before);
  });
});
