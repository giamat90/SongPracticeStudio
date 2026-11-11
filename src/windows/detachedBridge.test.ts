import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startDetachedBridge, type DetachedPlayer } from "./detachedBridge";
import { EVT_COMMAND, EVT_ENVELOPE, EVT_HELLO, EVT_STATE } from "./protocol";
import { useRemoteEnvelope } from "./remoteEnvelope";

const take = (id: string) => ({ id, songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav`, startPosition: 0 });
const song = { id: "s1", title: "Song", stems: ["vocals"], hasChords: true };

function setup() {
  let state: DetachedPlayer = {
    song: null,
    duration: 0,
    transpose: 0,
    capo: 0,
    chordDetail: "advanced",
    chordsRevision: 0,
    currentTime: 0,
    isPlaying: false,
    playbackRate: 1,
    activeTakeId: null,
    shownTakeIds: [],
    takePlayback: "all" as const,
    mutedTakeIds: [] as string[],
    soloedTakeId: null,
    mutedStems: {} as Record<string, boolean>,
    soloedStem: null as string | null,
    muteTakesWhileRecording: true,
    isRecording: false,
    takes: [],
    meterMap: null,
    meterEdited: false,
    meterSelected: null,
    meterBusy: false,
    meterError: null,
    meterHistory: [],
    clickDensity: "pulses" as const,
    tapSession: null,
    applyMeter: async () => {},
    undoMeter: async () => {},
    resetMeter: async () => {},
    detectMeter: async () => {},
    startMeterFromGrid: async () => {},
    finishTapping: async () => {},
    cancelTapping: () => {},
    clearMeterError: () => {},
    selectBar: () => {},
    setClickDensity: () => {},
    startTapping: () => {},
    tapNow: () => {},
    addTap: () => {},
    applyLoopRegion: () => {},
    seek: () => {},
    toggleTake: () => {},
    deleteTake: async () => {},
    renameTake: async () => {},
    fetchTakes: async () => {
      throw new Error("must not read the disk from a detached window");
    },
  };
  let clock = 1000;
  let playheadSource: (() => number) | null = null;
  const handlers = new Map<string, (p: unknown) => void>();
  const emitted: { event: string; payload: unknown }[] = [];
  const started = startDetachedBridge({
    panelId: "takes",
    player: {
      getState: () => state,
      setState: (partial) => {
        state = { ...state, ...partial };
      },
    },
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    listen: async (event, cb) => {
      handlers.set(event, cb);
      return () => {};
    },
    now: () => clock,
    takeTrackKey: "__take__",
    installPlayhead: (source) => {
      playheadSource = source;
      return () => {
        playheadSource = null;
      };
    },
    playhead: () => 12.5,
  });
  const message = (
    over: Partial<{ meterMap: unknown; meterSelected: number | null; meterUndoDepth: number; tapSession: unknown; time: number; playing: boolean; takes: unknown[]; activeTakeId: string | null; shownTakeIds: string[]; transpose: number; capo: number; chordDetail: "easy" | "medium" | "advanced"; chordsRevision: number }> = {},
  ) => ({
    transport: { time: over.time ?? 10, playing: over.playing ?? false, rate: 1, sentAt: clock },
    shared: {
      song,
      duration: 200,
      transpose: over.transpose ?? 0,
      capo: over.capo ?? 0,
      chordDetail: over.chordDetail ?? "advanced",
      chordsRevision: over.chordsRevision ?? 0,
      activeTakeId: over.activeTakeId ?? null,
      shownTakeIds: over.shownTakeIds ?? [],
      takePlayback: "all",
      mutedTakeIds: [],
      soloedTakeId: null,
      takesSilenced: false,
      muteTakesWhileRecording: true,
      isRecording: false,
      takes: over.takes ?? [take("t1")],
      meterMap: over.meterMap ?? null,
      meterEdited: false,
      meterSelected: over.meterSelected ?? null,
      meterBusy: false,
      meterError: null,
      meterUndoDepth: over.meterUndoDepth ?? 0,
      clickDensity: "pulses" as const,
      tapSession: over.tapSession ?? null,
    },
  });
  return {
    started,
    emitted,
    get: () => state,
    handlers,
    playheadSource: () => playheadSource,
    send: (payload: unknown) => handlers.get(EVT_STATE)?.(payload),
    message,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const bars = { version: 1 as const, bars: [{ start: 0, num: 4, den: 4 }], end: 8, source: "edited" as const };

describe("meter in a detached window", () => {
  it("mirrors the bars, the pick, the taps and the length of Undo", async () => {
    const t = setup();
    await t.started;
    const tap = { kind: "beats", den: 4, perBar: 4, pulse: 0.5, taps: [1] };
    t.send(t.message({ meterMap: bars, meterSelected: 0, meterUndoDepth: 3, tapSession: tap }));
    expect(t.get()).toMatchObject({ meterMap: bars, meterSelected: 0, tapSession: tap, clickDensity: "pulses" });
    expect(t.get().meterHistory).toHaveLength(3);
  });

  it("turns the editing actions into commands to the main window", async () => {
    const t = setup();
    await t.started;
    const commands = () => t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload);
    await t.get().applyMeter(bars, 0);
    await t.get().undoMeter();
    await t.get().detectMeter();
    t.get().startTapping({ kind: "bars", den: 4, perBar: 4, pulse: 0.5 });
    t.get().applyLoopRegion(1, 2);
    expect(commands()).toEqual([
      { type: "applyMeter", map: bars, select: 0 },
      { type: "undoMeter" },
      { type: "detectMeter" },
      { type: "startTapping", session: { kind: "bars", den: 4, perBar: 4, pulse: 0.5 } },
      { type: "applyLoopRegion", start: 1, end: 2 },
    ]);
  });

  it("does not send an edit that did not fit (null bars only report a problem in the main window)", async () => {
    const t = setup();
    await t.started;
    await t.get().applyMeter(null);
    expect(t.emitted.filter((e) => e.event === EVT_COMMAND)).toEqual([]);
  });

  it("shows a pick and a click density at once, and tells the main window", async () => {
    const t = setup();
    await t.started;
    t.get().selectBar(4);
    t.get().setClickDensity("bars");
    expect(t.get()).toMatchObject({ meterSelected: 4, clickDensity: "bars" });
    expect(t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload)).toEqual([
      { type: "selectBar", index: 4 },
      { type: "setClickDensity", density: "bars" },
    ]);
  });

  it("taps by its own playhead, which is the one the user is watching", async () => {
    const t = setup();
    await t.started;
    t.get().tapNow();
    expect(t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload)).toEqual([{ type: "addTap", time: 12.5 }]);
  });

  it("gives the drawing code the mirrored playhead in place of the engine, and takes it back on dispose", async () => {
    const t = setup();
    const bridge = await t.started;
    t.send(t.message({ time: 20 }));
    expect(t.playheadSource()?.()).toBeCloseTo(20, 1);
    bridge.dispose();
    expect(t.playheadSource()).toBeNull();
  });

  it("keeps the drum envelope the main window sends, and ignores a malformed one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useRemoteEnvelope.setState({ songId: null, values: null });
    const t = setup();
    await t.started;
    t.handlers.get(EVT_ENVELOPE)?.({ songId: "s1", fps: 100, values: [0, 0.25, 1] });
    expect(useRemoteEnvelope.getState().songId).toBe("s1");
    expect([...(useRemoteEnvelope.getState().values ?? [])]).toEqual([0, 0.25, 1]);
    t.handlers.get(EVT_ENVELOPE)?.({ songId: "s2", fps: 50, values: [1] });
    t.handlers.get(EVT_ENVELOPE)?.({ songId: "s2", fps: 100, values: ["x"] });
    expect(useRemoteEnvelope.getState().songId).toBe("s1");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("analyzer detached bridge", () => {
  it("says hello for its own panel", async () => {
    const t = setup();
    await t.started;
    expect(t.emitted).toEqual([{ event: EVT_HELLO, payload: { panelId: "takes" } }]);
  });

  it("mirrors the song, the takes, the active take and the transport", async () => {
    const t = setup();
    await t.started;
    t.send(t.message({ time: 30, playing: true, takes: [take("t1"), take("t2")], activeTakeId: "t2" }));
    expect(t.get()).toMatchObject({ duration: 200, activeTakeId: "t2", isPlaying: true, playbackRate: 1 });
    expect(t.get().song?.id).toBe("s1");
    expect(t.get().takes.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(t.get().currentTime).toBeCloseTo(30, 1);
  });

  it("mirrors the transpose so the chords there follow the main window", async () => {
    const t = setup();
    await t.started;
    t.send(t.message({ transpose: -2 }));
    expect(t.get().transpose).toBe(-2);
  });

  it("mirrors how much of each chord is shown", async () => {
    const t = setup();
    await t.started;
    t.send(t.message({ chordDetail: "easy" }));
    expect(t.get()).toMatchObject({ chordDetail: "easy" });
  });

  it("mirrors the capo and the chords revision", async () => {
    const t = setup();
    await t.started;
    t.send(t.message({ capo: 3, chordsRevision: 5 }));
    expect(t.get()).toMatchObject({ capo: 3, chordsRevision: 5 });
  });

  it("keeps the playhead moving between messages, and holds it when paused", async () => {
    const t = setup();
    await t.started;
    t.send(t.message({ time: 30, playing: true }));
    t.advance(1000);
    expect(t.get().currentTime).toBeCloseTo(31, 1);
    t.send(t.message({ time: 50, playing: false }));
    t.advance(1000);
    expect(t.get().currentTime).toBe(50);
  });

  it("turns a click on a take into a command, and shows the choice at once", async () => {
    const t = setup();
    await t.started;
    t.send(t.message());
    t.get().toggleTake("t1");
    expect(t.get().activeTakeId).toBe("t1");
    expect(t.get().shownTakeIds).toEqual(["t1"]);
    expect(t.emitted[t.emitted.length - 1]).toEqual({ event: EVT_COMMAND, payload: { type: "toggleTake", id: "t1" } });
  });

  it("turns delete, rename and seek into commands without touching the disk or the engine", async () => {
    const t = setup();
    await t.started;
    t.send(t.message());
    await t.get().deleteTake("t1");
    await t.get().renameTake("t1", "Verse");
    t.get().seek(75);
    const commands = t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload);
    expect(commands).toEqual([
      { type: "deleteTake", id: "t1" },
      { type: "renameTake", id: "t1", name: "Verse" },
      { type: "seek", time: 75 },
    ]);
    expect(t.get().currentTime).toBe(75);
  });

  it("does not read the takes from disk: they are mirrored", async () => {
    const t = setup();
    await t.started;
    await expect(t.get().fetchTakes()).resolves.toBeUndefined();
  });

  it("shows the main take mute in the store the Takes list reads", async () => {
    const t = setup();
    await t.started;
    t.send({ ...t.message(), shared: { ...t.message().shared, takesSilenced: true } });
    expect(t.get().mutedStems).toEqual({ __take__: true });
    expect(t.get().soloedStem).toBeNull();
  });

  it("ignores a malformed state message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await t.started;
    t.send({ transport: { time: 1 }, shared: {} });
    expect(t.get().song).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
