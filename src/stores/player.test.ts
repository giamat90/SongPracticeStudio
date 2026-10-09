import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Song, Take } from "../lib/types";

// ─── fakes for everything that touches the browser / Tauri ─────────────────

const h = vi.hoisted(() => {
  const state = { duration: 200, currentTime: 0, playing: false, engine: null as any };
  const rec = {
    init: vi.fn(), start: vi.fn(), stop: vi.fn(), releaseStream: vi.fn(), dispose: vi.fn(), getStream: vi.fn(),
  };
  return {
    state,
    api: {
      saveTake: vi.fn(), listTakes: vi.fn(), deleteTakeApi: vi.fn(), renameTakeApi: vi.fn(),
      setTakeManualOffsetApi: vi.fn(), pitchShiftSong: vi.fn(), setMetronomeOffsetApi: vi.fn(),
    },
    metronome: { start: vi.fn(), stop: vi.fn() },
    rec,
  };
});

vi.mock("../lib/tauri", () => h.api);
vi.mock("../audio/metronome", () => ({ metronome: h.metronome }));
vi.mock("../audio/engine", () => ({
  AudioEngine: class {
    timeCb: ((t: number) => void) | null = null;
    finishCb: (() => void) | null = null;
    scrollCb: ((px: number, t: number) => void) | null = null;
    load = vi.fn(async () => {});
    play = vi.fn(() => { h.state.playing = true; });
    pause = vi.fn(() => { h.state.playing = false; });
    stop = vi.fn(() => { h.state.playing = false; });
    seekTo = vi.fn((t: number) => { h.state.currentTime = t; });
    setPlaybackRate = vi.fn();
    setOutputDevice = vi.fn(async () => {});
    setStemVolume = vi.fn();
    setTakeVolume = vi.fn();
    setInteract = vi.fn();
    clearTakeTrack = vi.fn();
    setTakeManualOffset = vi.fn();
    reloadStemsFromPaths = vi.fn(async () => {});
    zoomAll = vi.fn();
    getMinPxPerSec = vi.fn(() => 2);
    destroy = vi.fn();
    getDuration = vi.fn(() => h.state.duration);
    getCurrentTime = vi.fn(() => h.state.currentTime);
    get isPlaying() { return h.state.playing; }
    onTimeUpdate(cb: (t: number) => void) { this.timeCb = cb; }
    onFinish(cb: () => void) { this.finishCb = cb; }
    onScrollChange(cb: (px: number, t: number) => void) { this.scrollCb = cb; }
    constructor() { h.state.engine = this; }
  },
}));
vi.mock("../audio/recorder", () => ({
  VocalRecorder: class {
    init = h.rec.init;
    start = h.rec.start;
    stop = h.rec.stop;
    releaseStream = h.rec.releaseStream;
    dispose = h.rec.dispose;
    getStream = h.rec.getStream;
  },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

const STEMS: Song["stems"] = ["vocals", "drums", "bass"];

const song = (extra: Partial<Song> = {}): Song => ({
  id: "s1", title: "Song", duration: 200, processedAt: "2026-01-01", directory: "C:\\lib\\s1", stems: [...STEMS], sortIndex: 0, ...extra,
});
const take = (extra: Partial<Take> = {}): Take => ({
  id: "t1", songId: "s1", recordedAt: "2026-01-01", filepath: "/takes/t1.wav", startPosition: 5, ...extra,
});
const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId) =>
  ({ kind, deviceId, label, groupId: "g" }) as MediaDeviceInfo;

const DEVICES = [
  device("audioinput", "mic-ub", "Microphone (2-Behringer USB WDM Audio)"),
  device("audiooutput", "out-def", "Default - Speakers"),
  device("audiooutput", "out-ub", "Speakers (2-Behringer USB WDM Audio)"),
];

type PlayerModule = typeof import("./player");
let mod: PlayerModule;
let deviceChange: (() => void) | null = null;
let currentDevices: MediaDeviceInfo[] = DEVICES;
let getUserMedia: ReturnType<typeof vi.fn>;

const eng = () => h.state.engine;
const rec = () => h.rec;
const store = () => mod.usePlayerStore;

async function freshModule() {
  vi.resetModules();
  deviceChange = null;
  mod = await import("./player");
  return mod;
}

async function loadedSong(s: Song = song()) {
  await store().getState().loadSong(s, {});
}

beforeEach(async () => {
  Object.values(h.api).forEach((fn) => fn.mockReset());
  h.api.listTakes.mockResolvedValue([]);
  Object.values(h.metronome).forEach((fn) => fn.mockReset());
  Object.values(h.rec).forEach((fn) => fn.mockReset());
  h.rec.init.mockResolvedValue(undefined);
  h.rec.stop.mockImplementation(async () => new Blob([Uint8Array.from([7, 8, 9])]));
  h.rec.getStream.mockReturnValue({ getAudioTracks: () => [{ getSettings: () => ({ latency: 0.01 }) }] });
  h.state.duration = 200;
  h.state.currentTime = 0;
  h.state.playing = false;
  currentDevices = DEVICES;
  localStorage.clear();

  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => currentDevices),
      addEventListener: vi.fn((_: string, cb: () => void) => { deviceChange = cb; }),
    },
  });
  vi.stubGlobal("AudioContext", class {
    outputLatency = 0.02;
    baseLatency = 0.01;
    close() { return Promise.resolve(); }
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await freshModule();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── pure helpers ──────────────────────────────────────────────────────────

describe("effectiveStemGain", () => {
  it("passes the slider value through when nothing is muted or soloed", () => {
    expect(mod.effectiveStemGain("vocals", 0.7, {}, null)).toBe(0.7);
  });

  it("silences a muted stem only", () => {
    expect(mod.effectiveStemGain("vocals", 0.7, { vocals: true }, null)).toBe(0);
    expect(mod.effectiveStemGain("drums", 0.4, { vocals: true }, null)).toBe(0.4);
  });

  it("solo keeps the soloed stem and silences all others", () => {
    expect(mod.effectiveStemGain("drums", 0.4, {}, "drums")).toBe(0.4);
    expect(mod.effectiveStemGain("vocals", 0.7, {}, "drums")).toBe(0);
  });

  it("solo overrides mute on the soloed stem", () => {
    expect(mod.effectiveStemGain("drums", 0.4, { drums: true }, "drums")).toBe(0.4);
  });

  it("treats the take as just another soloable track", () => {
    expect(mod.effectiveStemGain(mod.TAKE_TRACK_KEY, 1, {}, "drums")).toBe(0);
    expect(mod.effectiveStemGain(mod.TAKE_TRACK_KEY, 1, {}, mod.TAKE_TRACK_KEY)).toBe(1);
  });
});

describe("buildMixSources", () => {
  const base = () => ({ ...store().getState(), song: song(), duration: 200, stemVolumes: { vocals: 1, drums: 1, bass: 1 } });

  it("is null without a loaded song", () => {
    expect(mod.buildMixSources({ ...base(), song: null })).toBeNull();
  });

  it("includes every stem at its slider gain over the whole song", () => {
    const out = mod.buildMixSources({ ...base(), stemVolumes: { vocals: 0.5, drums: 0.8, bass: 1 } })!;
    expect(out.sources).toEqual([
      { path: "C:\\lib\\s1/vocals.wav", gain: 0.5, isTake: false },
      { path: "C:\\lib\\s1/drums.wav", gain: 0.8, isTake: false },
      { path: "C:\\lib\\s1/bass.wav", gain: 1, isTake: false },
    ]);
    expect([out.startSec, out.endSec]).toEqual([0, 200]);
  });

  it("defaults a stem with no stored volume to unity", () => {
    const out = mod.buildMixSources({ ...base(), stemVolumes: {} })!;
    expect(out.sources.map((s) => s.gain)).toEqual([1, 1, 1]);
  });

  it("omits muted stems and returns null when nothing is audible", () => {
    const out = mod.buildMixSources({ ...base(), mutedStems: { drums: true } })!;
    expect(out.sources.map((s) => s.path)).toEqual(["C:\\lib\\s1/vocals.wav", "C:\\lib\\s1/bass.wav"]);
    expect(mod.buildMixSources({ ...base(), mutedStems: { vocals: true, drums: true, bass: true } })).toBeNull();
  });

  it("with a solo, keeps only the soloed stem", () => {
    const out = mod.buildMixSources({ ...base(), soloedStem: "bass" })!;
    expect(out.sources.map((s) => s.path)).toEqual(["C:\\lib\\s1/bass.wav"]);
  });

  it("omits zero-volume stems", () => {
    const out = mod.buildMixSources({ ...base(), stemVolumes: { vocals: 0, drums: 1, bass: 1 } })!;
    expect(out.sources).toHaveLength(2);
  });

  it("adds the active take with its alignment fields", () => {
    const t = take({ audioOffset: 0.2, manualOffset: -0.5, startPosition: 12 });
    const out = mod.buildMixSources({ ...base(), takes: [t], activeTakeId: "t1", takeVolume: 0.6 })!;
    expect(out.sources[out.sources.length - 1]).toEqual({
      path: "/takes/t1.wav", gain: 0.6, isTake: true, startPosition: 12, audioOffset: 0.2, manualOffset: -0.5,
    });
  });

  it("defaults missing take offsets to 0", () => {
    const out = mod.buildMixSources({ ...base(), takes: [take()], activeTakeId: "t1" })!;
    expect(out.sources[out.sources.length - 1]).toMatchObject({ audioOffset: 0, manualOffset: 0 });
  });

  it("ignores a take that is muted, missing, or not selected", () => {
    const withTake = { ...base(), takes: [take()] };
    expect(mod.buildMixSources({ ...withTake, activeTakeId: null })!.sources).toHaveLength(3);
    expect(mod.buildMixSources({ ...withTake, activeTakeId: "ghost" })!.sources).toHaveLength(3);
    expect(mod.buildMixSources({ ...withTake, activeTakeId: "t1", mutedStems: { [mod.TAKE_TRACK_KEY]: true } })!.sources).toHaveLength(3);
  });

  it("can render only the take", () => {
    const out = mod.buildMixSources({ ...base(), takes: [take()], activeTakeId: "t1", soloedStem: mod.TAKE_TRACK_KEY })!;
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].isTake).toBe(true);
  });

  it("limits the render to the punch region", () => {
    const out = mod.buildMixSources({ ...base(), punchIn: 10, punchOut: 30 })!;
    expect([out.startSec, out.endSec]).toEqual([10, 30]);
  });

  it("uses the song start / duration for a half-set punch region", () => {
    expect(mod.buildMixSources({ ...base(), punchIn: 10 })).toMatchObject({ startSec: 10, endSec: 200 });
    expect(mod.buildMixSources({ ...base(), punchOut: 30 })).toMatchObject({ startSec: 0, endSec: 30 });
  });
});

// ─── loading and transport ─────────────────────────────────────────────────

describe("loadSong", () => {
  it("loads the engine with the song's stems and resets playback state", async () => {
    store().setState({ transpose: 3, playbackRate: 0.5, activeTakeId: "x", soloedStem: "drums", mutedStems: { vocals: true } });
    await loadedSong();
    const s = store().getState();
    expect(eng().load).toHaveBeenCalledWith("C:\\lib\\s1", STEMS, {});
    expect(s).toMatchObject({
      duration: 200, currentTime: 0, isPlaying: false, playbackRate: 1, transpose: 0, isTransposing: false,
      activeTakeId: null, soloedStem: null, mutedStems: {}, minPxPerSec: 2, scrollTime: 0, takeVolume: 1,
      stemVolumes: { vocals: 1, drums: 1, bass: 1 },
    });
    expect(s.song?.id).toBe("s1");
    expect(eng().zoomAll).toHaveBeenCalledWith(2, 0);
  });

  it("fetches the song's takes", async () => {
    h.api.listTakes.mockResolvedValue([take()]);
    await loadedSong();
    await vi.waitFor(() => expect(store().getState().takes).toHaveLength(1));
    expect(h.api.listTakes).toHaveBeenCalledWith("s1");
  });

  it("leaves the store untouched when the engine cannot load the stems", async () => {
    await loadedSong(song({ id: "first" }));
    eng().load.mockRejectedValueOnce(new Error("vocals failed to load: bad header"));
    await expect(loadedSong(song({ id: "second" }))).rejects.toThrow("bad header");
    expect(store().getState().song?.id).toBe("first");
  });

  it.each([[-5, 0], [50, 50], [999, 200]])("clamps the stored metronome offset %s to %s", async (stored, expected) => {
    await loadedSong(song({ metronomeOffset: stored }));
    expect(store().getState().metronomeOffset).toBe(expected);
  });

  it("starts the metronome offset at 0 when the song has none", async () => {
    await loadedSong();
    expect(store().getState().metronomeOffset).toBe(0);
  });

  it("does not carry a punch region from the previous song into the next one", async () => {
    await loadedSong(song({ id: "a" }));
    store().setState({ punchIn: 30, punchOut: 60, punchLoop: true });
    await loadedSong(song({ id: "b" }));
    expect(store().getState()).toMatchObject({ punchIn: null, punchOut: null, punchLoop: false });
  });

  it("mirrors engine time updates and scroll changes into the store", async () => {
    await loadedSong();
    h.state.playing = true;
    eng().timeCb(12.5);
    expect(store().getState()).toMatchObject({ currentTime: 12.5, isPlaying: true });
    eng().scrollCb(40, 7);
    expect(store().getState()).toMatchObject({ minPxPerSec: 40, scrollTime: 7 });
  });
});

describe("transport", () => {
  beforeEach(async () => { await loadedSong(); });

  it("play starts the engine and flags playing", () => {
    store().getState().play();
    expect(eng().play).toHaveBeenCalled();
    expect(store().getState().isPlaying).toBe(true);
  });

  it("play jumps to the punch-in first", () => {
    store().setState({ punchIn: 42 });
    store().getState().play();
    expect(eng().seekTo).toHaveBeenCalledWith(42);
    expect(store().getState().currentTime).toBe(42);
  });

  it("pause and togglePlay flip state", () => {
    store().getState().togglePlay();
    expect(store().getState().isPlaying).toBe(true);
    store().getState().togglePlay();
    expect(store().getState().isPlaying).toBe(false);
    expect(eng().pause).toHaveBeenCalled();
  });

  it("stop rewinds to 0", () => {
    store().setState({ currentTime: 30, isPlaying: true });
    store().getState().stop();
    expect(store().getState()).toMatchObject({ currentTime: 0, isPlaying: false });
    expect(eng().stop).toHaveBeenCalled();
  });

  it("seek moves the engine and the store", () => {
    store().getState().seek(33);
    expect(store().getState().currentTime).toBe(33);
    expect(eng().seekTo).toHaveBeenLastCalledWith(33);
  });

  it("skipToStart goes to 0 and skipToEnd stops just short of the end (avoids a false 'finished')", () => {
    store().getState().skipToStart();
    expect(store().getState().currentTime).toBe(0);
    store().getState().skipToEnd();
    expect(store().getState().currentTime).toBeCloseTo(199.95, 9);
  });

  it("skipToEnd never goes negative on a zero-length song", () => {
    store().setState({ duration: 0 });
    store().getState().skipToEnd();
    expect(store().getState().currentTime).toBe(0);
  });

  it("setPlaybackRate drives the engine", () => {
    store().getState().setPlaybackRate(0.75);
    expect(eng().setPlaybackRate).toHaveBeenCalledWith(0.75);
    expect(store().getState().playbackRate).toBe(0.75);
  });

  it("end of song marks playback stopped", () => {
    store().setState({ isPlaying: true });
    eng().finishCb();
    expect(store().getState().isPlaying).toBe(false);
  });
});

describe("mixer", () => {
  beforeEach(async () => { await loadedSong(); });

  const lastVolumes = () => {
    const out: Record<string, number> = {};
    for (const [name, v] of eng().setStemVolume.mock.calls as [string, number][]) out[name] = v;
    return out;
  };

  it("setStemVolume pushes the effective gain of every stem", () => {
    store().getState().setStemVolume("drums", 0.3);
    expect(lastVolumes()).toEqual({ vocals: 1, drums: 0.3, bass: 1 });
    expect(store().getState().stemVolumes.drums).toBe(0.3);
  });

  it("mute silences the engine but remembers the slider, so unmute restores it exactly", () => {
    store().getState().setStemVolume("vocals", 0.35);
    store().getState().toggleMute("vocals");
    expect(lastVolumes().vocals).toBe(0);
    expect(store().getState().stemVolumes.vocals).toBe(0.35);
    store().getState().toggleMute("vocals");
    expect(lastVolumes().vocals).toBe(0.35);
  });

  it("solo silences the others (and the take), and soloing the same stem again releases it", () => {
    store().getState().toggleSolo("drums");
    expect(lastVolumes()).toEqual({ vocals: 0, drums: 1, bass: 0 });
    expect(eng().setTakeVolume).toHaveBeenLastCalledWith(0);
    store().getState().toggleSolo("drums");
    expect(store().getState().soloedStem).toBeNull();
    expect(lastVolumes()).toEqual({ vocals: 1, drums: 1, bass: 1 });
    expect(eng().setTakeVolume).toHaveBeenLastCalledWith(1);
  });

  it("soloing a second stem moves the solo rather than adding to it", () => {
    store().getState().toggleSolo("drums");
    store().getState().toggleSolo("bass");
    expect(store().getState().soloedStem).toBe("bass");
    expect(lastVolumes()).toEqual({ vocals: 0, drums: 0, bass: 1 });
  });

  it("a muted stem stays silent when another stem's volume changes", () => {
    store().getState().toggleMute("bass");
    store().getState().setStemVolume("vocals", 0.5);
    expect(lastVolumes()).toEqual({ vocals: 0.5, drums: 1, bass: 0 });
  });

  it("does not touch the engine when no song is loaded", () => {
    store().setState({ song: null });
    eng().setStemVolume.mockClear();
    store().getState().setStemVolume("vocals", 0.5);
    store().getState().toggleMute("vocals");
    store().getState().toggleSolo("vocals");
    expect(eng().setStemVolume).not.toHaveBeenCalled();
  });

  describe("take volume", () => {
    it("pushes the slider value", () => {
      store().getState().setTakeVolume(0.9);
      expect(eng().setTakeVolume).toHaveBeenLastCalledWith(0.9);
      expect(store().getState().takeVolume).toBe(0.9);
    });

    it("is silenced when the take is muted or another stem is soloed", () => {
      store().setState({ mutedStems: { [mod.TAKE_TRACK_KEY]: true } });
      store().getState().setTakeVolume(0.9);
      expect(eng().setTakeVolume).toHaveBeenLastCalledWith(0);
      store().setState({ mutedStems: {}, soloedStem: "drums" });
      store().getState().setTakeVolume(0.9);
      expect(eng().setTakeVolume).toHaveBeenLastCalledWith(0);
    });

    it("is audible when the take itself is the soloed track", () => {
      store().setState({ soloedStem: mod.TAKE_TRACK_KEY });
      store().getState().setTakeVolume(0.4);
      expect(eng().setTakeVolume).toHaveBeenLastCalledWith(0.4);
    });
  });
});

describe("punch region", () => {
  beforeEach(async () => { await loadedSong(); });

  it("sets and clears the region (clearing also drops the loop flag)", () => {
    store().getState().setPunchIn(10);
    store().getState().setPunchOut(20);
    store().getState().setPunchLoop(true);
    expect(store().getState()).toMatchObject({ punchIn: 10, punchOut: 20, punchLoop: true });
    store().getState().clearPunch();
    expect(store().getState()).toMatchObject({ punchIn: null, punchOut: null, punchLoop: false });
  });

  it("loops back to the punch-in when reaching the punch-out with loop on", () => {
    store().setState({ punchIn: 10, punchOut: 20, punchLoop: true, isPlaying: true });
    h.state.playing = true;
    eng().timeCb(20.01);
    expect(eng().seekTo).toHaveBeenLastCalledWith(10);
    expect(store().getState().currentTime).toBe(10);
    expect(eng().pause).not.toHaveBeenCalled();
  });

  it("stops and rewinds to the punch-in at the punch-out with loop off", () => {
    store().setState({ punchIn: 10, punchOut: 20, punchLoop: false, isPlaying: true });
    h.state.playing = true;
    eng().timeCb(20.5);
    expect(eng().pause).toHaveBeenCalled();
    expect(eng().seekTo).toHaveBeenLastCalledWith(10);
    expect(store().getState()).toMatchObject({ isPlaying: false, currentTime: 10 });
  });

  it("rewinds to 0 when only a punch-out is set", () => {
    store().setState({ punchIn: null, punchOut: 20, isPlaying: true });
    h.state.playing = true;
    eng().timeCb(21);
    expect(store().getState().currentTime).toBe(0);
  });

  it("does nothing before the punch-out", () => {
    store().setState({ punchIn: 10, punchOut: 20, isPlaying: true });
    h.state.playing = true;
    eng().timeCb(19.9);
    expect(eng().pause).not.toHaveBeenCalled();
    expect(store().getState().currentTime).toBe(19.9);
  });

  it("does not act on the punch-out while paused", () => {
    store().setState({ punchIn: 10, punchOut: 20 });
    eng().timeCb(25);
    expect(eng().pause).not.toHaveBeenCalled();
  });

  it("auto-stops an in-progress recording at the punch-out", async () => {
    h.api.saveTake.mockResolvedValue(take());
    store().setState({ isRecording: true, punchOut: 20 });
    eng().timeCb(20);
    await vi.waitFor(() => expect(h.api.saveTake).toHaveBeenCalled());
    expect(store().getState().isRecording).toBe(false);
  });

  it("logs, rather than throwing into the audio loop, when the punch-out auto-stop fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.api.saveTake.mockRejectedValue(new Error("sidecar down"));
    store().setState({ isRecording: true, punchOut: 20 });
    expect(() => eng().timeCb(20)).not.toThrow();
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith("[player] punch-out auto-stop failed:", expect.any(Error)));
  });
});

// ─── devices and latency calibration ───────────────────────────────────────

describe("recording-offset calibration storage", () => {
  const KEY = "songpracticestudio_recording_offsets";
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

  it("setRecordingOffset stores a bare entry, clearing any stale flag and confidence", () => {
    store().getState().applyCalibration("mic", { offset: 80, stale: true, madMs: 3 });
    store().getState().setRecordingOffset("mic", 95);
    expect(store().getState().recordingOffsets.mic).toEqual({ offset: 95 });
    expect(stored().mic).toEqual({ offset: 95 });
  });

  it("applyCalibration keeps the full measured entry", () => {
    store().getState().applyCalibration("mic", { offset: 80, madMs: 2 });
    expect(stored().mic).toEqual({ offset: 80, madMs: 2 });
  });

  it("keeps entries for other devices when one changes", () => {
    store().getState().setRecordingOffset("a", 10);
    store().getState().setRecordingOffset("b", 20);
    expect(Object.keys(stored()).sort()).toEqual(["a", "b"]);
  });

  it("loads the current schema, upgrades legacy bare numbers, and drops malformed entries with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, JSON.stringify({
      cur: { offset: 70, stale: true }, legacy: 55, bad: "x", worse: null, noOffset: { stale: true },
    }));
    await freshModule();
    expect(store().getState().recordingOffsets).toEqual({ cur: { offset: 70, stale: true }, legacy: { offset: 55 } });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("starts empty and warns on corrupt storage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, "{{{");
    await freshModule();
    expect(store().getState().recordingOffsets).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it("still updates memory when storage refuses the write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("full"); });
    store().getState().setRecordingOffset("mic", 12);
    expect(store().getState().recordingOffsets.mic).toEqual({ offset: 12 });
    expect(warn).toHaveBeenCalled();
  });
});

describe("device enumeration", () => {
  it("probes the mic for labels, releases the probe, and splits inputs from outputs", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });
    await store().getState().fetchAudioDevices();
    expect(stop).toHaveBeenCalled();
    expect(store().getState().audioDevices.map((d) => d.deviceId)).toEqual(["mic-ub"]);

    await store().getState().fetchOutputDevices();
    expect(store().getState().outputDevices.map((d) => d.deviceId)).toEqual(["out-def", "out-ub"]);
  });

  it("still lists devices (with a warning) when mic permission is denied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    await store().getState().fetchAudioDevices();
    expect(store().getState().audioDevices).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    await store().getState().fetchOutputDevices();
    expect(store().getState().outputDevices).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("setOutputDevice routes the engine ('' for system default) and records the choice", async () => {
    await store().getState().setOutputDevice("out-ub");
    expect(eng().setOutputDevice).toHaveBeenCalledWith("out-ub");
    expect(store().getState().selectedOutputDeviceId).toBe("out-ub");
    await store().getState().setOutputDevice(null);
    expect(eng().setOutputDevice).toHaveBeenLastCalledWith("");
    expect(store().getState().selectedOutputDeviceId).toBeNull();
  });

  it("setAudioDevice stores the selection", () => {
    store().getState().setAudioDevice("mic-ub");
    expect(store().getState().selectedDeviceId).toBe("mic-ub");
  });
});

describe("device-change watcher marks calibrations stale", () => {
  const KEY = "songpracticestudio_recording_offsets";
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

  async function armWatcher(offsets: Record<string, unknown>) {
    localStorage.setItem(KEY, JSON.stringify(offsets));
    await freshModule();
    await store().getState().fetchAudioDevices();
    expect(deviceChange).toBeTypeOf("function");
  }

  const fire = async (devices: MediaDeviceInfo[]) => {
    currentDevices = devices;
    deviceChange!();
    await new Promise((r) => setTimeout(r, 0));
  };

  it("flags a calibration whose input was unplugged, and persists it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await armWatcher({ "mic-ub": { offset: 90 }, "mic-other": { offset: 40 } });
    await fire(DEVICES.filter((d) => d.deviceId !== "mic-ub").concat(device("audioinput", "mic-other")));
    expect(store().getState().recordingOffsets["mic-ub"].stale).toBe(true);
    expect(store().getState().recordingOffsets["mic-other"].stale).toBeUndefined();
    expect(stored()["mic-ub"].stale).toBe(true);
  });

  it("flags a calibration whose recorded output disappeared", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await armWatcher({ "mic-ub": { offset: 90, outputDeviceId: "out-ub" } });
    await fire(DEVICES.filter((d) => d.deviceId !== "out-ub"));
    expect(store().getState().recordingOffsets["mic-ub"].stale).toBe(true);
  });

  it("never flags the default-microphone key '' (it is not an enumerated id)", async () => {
    await armWatcher({ "": { offset: 60 } });
    await fire(DEVICES.concat(device("audioinput", "new-mic")));
    expect(store().getState().recordingOffsets[""].stale).toBeUndefined();
  });

  it("ignores a devicechange that leaves the device set identical", async () => {
    await armWatcher({ "mic-ub": { offset: 90 } });
    const before = store().getState().recordingOffsets;
    await fire([...DEVICES].reverse());
    expect(store().getState().recordingOffsets).toBe(before);
  });

  it("refreshes the device lists when a device is added without touching calibrations", async () => {
    await armWatcher({ "mic-ub": { offset: 90 } });
    await fire(DEVICES.concat(device("audioinput", "usb2"), device("audiooutput", "out-new")));
    expect(store().getState().audioDevices.map((d) => d.deviceId)).toEqual(["mic-ub", "usb2"]);
    expect(store().getState().outputDevices.map((d) => d.deviceId)).toContain("out-new");
    expect(store().getState().recordingOffsets["mic-ub"].stale).toBeUndefined();
  });

  it("does not re-flag or rewrite an entry that is already stale", async () => {
    await armWatcher({ "mic-ub": { offset: 90, stale: true } });
    const setItem = vi.spyOn(localStorage, "setItem");
    await fire(DEVICES.filter((d) => d.deviceId !== "mic-ub"));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("registers the listener only once across repeated fetches", async () => {
    await freshModule();
    await store().getState().fetchAudioDevices();
    await store().getState().fetchAudioDevices();
    expect((navigator.mediaDevices.addEventListener as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("logs instead of throwing when re-enumeration fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await armWatcher({});
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    deviceChange!();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith("[calibration] devicechange handling failed:", expect.any(Error));
  });
});

// ─── transpose ─────────────────────────────────────────────────────────────

describe("setTranspose", () => {
  it("does nothing without a song, or for the current value", async () => {
    await store().getState().setTranspose(2);
    expect(h.api.pitchShiftSong).not.toHaveBeenCalled();
    await loadedSong();
    await store().getState().setTranspose(0);
    expect(eng().reloadStemsFromPaths).not.toHaveBeenCalled();
  });

  it("asks the sidecar for shifted stems and reloads every stem in place", async () => {
    await loadedSong();
    const stems = { vocals: "/p/v.wav", drums: "/p/d.wav", bass: "/p/b.wav" };
    h.api.pitchShiftSong.mockResolvedValue({ stems });
    await store().getState().setTranspose(-3);
    expect(h.api.pitchShiftSong).toHaveBeenCalledWith("C:\\lib\\s1", STEMS, -3);
    expect(eng().reloadStemsFromPaths).toHaveBeenCalledWith(stems);
    expect(store().getState()).toMatchObject({ transpose: -3, isTransposing: false });
  });

  it("returning to 0 reloads the originals without calling the sidecar (forward slashes)", async () => {
    await loadedSong();
    store().setState({ transpose: 2 });
    await store().getState().setTranspose(0);
    expect(h.api.pitchShiftSong).not.toHaveBeenCalled();
    expect(eng().reloadStemsFromPaths).toHaveBeenCalledWith({
      vocals: "C:/lib/s1/vocals.wav", drums: "C:/lib/s1/drums.wav", bass: "C:/lib/s1/bass.wav",
    });
    expect(store().getState().transpose).toBe(0);
  });

  it("pauses playback while shifting", async () => {
    await loadedSong();
    store().setState({ isPlaying: true });
    let release!: (v: unknown) => void;
    h.api.pitchShiftSong.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = store().getState().setTranspose(1);
    expect(store().getState()).toMatchObject({ isTransposing: true, isPlaying: false });
    expect(eng().pause).toHaveBeenCalled();
    release({ stems: {} });
    await pending;
  });

  it("clears the busy flag and rethrows when the sidecar fails, keeping the previous transpose", async () => {
    await loadedSong();
    h.api.pitchShiftSong.mockRejectedValue(new Error("librosa"));
    await expect(store().getState().setTranspose(5)).rejects.toThrow("librosa");
    expect(store().getState()).toMatchObject({ isTransposing: false, transpose: 0 });
  });

  it("clears the busy flag and rethrows when the engine cannot reload", async () => {
    await loadedSong();
    h.api.pitchShiftSong.mockResolvedValue({ stems: {} });
    eng().reloadStemsFromPaths.mockRejectedValueOnce(new Error("drums failed to reload"));
    await expect(store().getState().setTranspose(5)).rejects.toThrow("drums failed to reload");
    expect(store().getState()).toMatchObject({ isTransposing: false, transpose: 0 });
  });
});

// ─── recording ─────────────────────────────────────────────────────────────

describe("startRecording", () => {
  beforeEach(async () => {
    await loadedSong();
    store().setState({ selectedDeviceId: "mic-ub" });
    h.state.currentTime = 12;
    h.api.saveTake.mockResolvedValue(take({ id: "new" }));
  });

  it("does nothing without a song", async () => {
    store().setState({ song: null });
    await store().getState().startRecording();
    expect(rec().init).not.toHaveBeenCalled();
  });

  it("opens the mic before playback starts, then plays from the playhead", async () => {
    await store().getState().startRecording();
    const order = [eng().pause, rec().init, eng().seekTo, eng().play, rec().start].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(rec().init).toHaveBeenCalledWith("mic-ub");
    expect(eng().seekTo).toHaveBeenCalledWith(12);
    expect(eng().setInteract).toHaveBeenCalledWith(false);
    expect(store().getState()).toMatchObject({ isRecording: true, isPlaying: true });
  });

  it("starts at the punch-in rather than the playhead", async () => {
    store().setState({ punchIn: 30 });
    await store().getState().startRecording();
    expect(eng().seekTo).toHaveBeenCalledWith(30);
  });

  it("deselects and unloads the active take first, so the performer records against the stems alone", async () => {
    store().setState({ activeTakeId: "old" });
    await store().getState().startRecording();
    expect(store().getState().activeTakeId).toBeNull();
    expect(eng().clearTakeTrack).toHaveBeenCalled();
  });

  it("refreshes the input list once the mic is open (labels appear after permission)", async () => {
    store().setState({ audioDevices: [] });
    await store().getState().startRecording();
    expect(store().getState().audioDevices.map((d) => d.deviceId)).toEqual(["mic-ub"]);
  });

  it("aborts with a clear error and unlocks the waveform when the mic is unavailable", async () => {
    rec().init.mockRejectedValueOnce(new Error("NotReadableError"));
    await expect(store().getState().startRecording()).rejects.toThrow("Microphone unavailable: NotReadableError");
    expect(eng().setInteract).toHaveBeenCalledWith(true);
    expect(store().getState().isRecording).toBe(false);
    expect(rec().start).not.toHaveBeenCalled();
  });

  it("describes a non-Error mic failure too", async () => {
    rec().init.mockRejectedValueOnce("denied");
    await expect(store().getState().startRecording()).rejects.toThrow("Microphone unavailable: denied");
  });

  it("uses a fresh calibration and does not flag the fallback", async () => {
    store().getState().applyCalibration("mic-ub", { offset: 100 });
    await store().getState().startRecording();
    expect(store().getState().usedLatencyFallback).toBe(false);
  });

  it.each([
    ["stale", { offset: 100, stale: true }],
    ["zero", { offset: 0 }],
  ])("falls back to the AudioContext estimate for a %s calibration", async (_label, entry) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store().getState().applyCalibration("mic-ub", entry);
    await store().getState().startRecording();
    expect(store().getState().usedLatencyFallback).toBe(true);
    if (entry.offset > 0) expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale"));
  });

  it("falls back and flags it when no calibration exists for the selected device", async () => {
    store().getState().applyCalibration("another-mic", { offset: 100 });
    await store().getState().startRecording();
    expect(store().getState().usedLatencyFallback).toBe(true);
  });

  it("uses the '' calibration for the default microphone", async () => {
    store().setState({ selectedDeviceId: null });
    store().getState().applyCalibration("", { offset: 100 });
    await store().getState().startRecording();
    expect(store().getState().usedLatencyFallback).toBe(false);
  });

  it("disables compensation with a warning when the latency probe throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("no audio"); } });
    await store().getState().startRecording();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("latency measurement failed"), expect.any(Error));
    await store().getState().stopRecording();
    expect(h.api.saveTake.mock.calls[0][2]).toBe(12);
  });
});

describe("stopRecording: latency compensation and take saving", () => {
  beforeEach(async () => {
    await loadedSong();
    store().setState({ selectedDeviceId: "mic-ub" });
    h.api.saveTake.mockResolvedValue(take({ id: "new" }));
  });

  async function recordFrom(start: number, latencyMs: number) {
    h.state.currentTime = start;
    store().getState().applyCalibration("mic-ub", { offset: latencyMs });
    await store().getState().startRecording();
    h.state.currentTime = start + 4;
    await store().getState().stopRecording();
  }

  it("shifts the take earlier by the measured round-trip latency", async () => {
    await recordFrom(20, 120);
    const [songId, data, startPosition, audioOffset] = h.api.saveTake.mock.calls[0];
    expect(songId).toBe("s1");
    expect(data).toEqual([7, 8, 9]);
    expect(startPosition).toBeCloseTo(19.88, 9);
    expect(audioOffset).toBe(0);
  });

  it("keeps startPosition at 0 and stores the remainder as audioOffset when recording from the very start", async () => {
    await recordFrom(0.05, 120);
    const [, , startPosition, audioOffset] = h.api.saveTake.mock.calls[0];
    expect(startPosition).toBe(0);
    expect(audioOffset).toBeCloseTo(0.07, 9);
  });

  it("without a calibration, compensates with the AudioContext round-trip estimate", async () => {
    h.state.currentTime = 20;
    await store().getState().startRecording();
    await store().getState().stopRecording();
    const startPosition = h.api.saveTake.mock.calls[0][2];
    expect(startPosition).toBeCloseTo(20 - (0.02 + 0.01 + 0.01), 9);
  });

  it("selects the new take and releases the mic", async () => {
    await recordFrom(5, 50);
    const s = store().getState();
    expect(s.takes.map((t) => t.id)).toEqual(["new"]);
    expect(s.activeTakeId).toBe("new");
    expect(s).toMatchObject({ isRecording: false, isPlaying: false, isSavingTake: false, currentTime: 0 });
    expect(rec().releaseStream).toHaveBeenCalled();
    expect(eng().stop).toHaveBeenCalled();
    expect(eng().setInteract).toHaveBeenLastCalledWith(true);
  });

  it("appends to the existing takes", async () => {
    store().setState({ takes: [take()] });
    await recordFrom(5, 50);
    expect(store().getState().takes.map((t) => t.id)).toEqual(["t1", "new"]);
  });

  it("shows the saving state while the sidecar works", async () => {
    let release!: (t: Take) => void;
    h.api.saveTake.mockReturnValue(new Promise<Take>((r) => { release = r; }));
    h.state.currentTime = 5;
    await store().getState().startRecording();
    const pending = store().getState().stopRecording();
    await vi.waitFor(() => expect(h.api.saveTake).toHaveBeenCalled());
    expect(store().getState()).toMatchObject({ isRecording: false, isSavingTake: true });
    release(take());
    await pending;
    expect(store().getState().isSavingTake).toBe(false);
  });

  it("logs a drift-check line only for long takes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await recordFrom(5, 50);
    expect(info).not.toHaveBeenCalled();
    h.state.currentTime = 5;
    await store().getState().startRecording();
    h.state.currentTime = 5 + 120;
    await store().getState().stopRecording();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[drift-check] takeDuration=120.0s"));
  });

  it("cleans up and rethrows when saving fails, leaving no take behind", async () => {
    h.api.saveTake.mockRejectedValue(new Error("sidecar down"));
    h.state.currentTime = 5;
    await store().getState().startRecording();
    await expect(store().getState().stopRecording()).rejects.toThrow("sidecar down");
    expect(store().getState()).toMatchObject({ isSavingTake: false, isRecording: false, currentTime: 0 });
    expect(store().getState().takes).toEqual([]);
    expect(rec().releaseStream).toHaveBeenCalled();
  });

  it("cleans up and rethrows when the recorder cannot stop", async () => {
    h.state.currentTime = 5;
    await store().getState().startRecording();
    rec().stop.mockRejectedValueOnce(new Error("Not recording (state: inactive)"));
    await expect(store().getState().stopRecording()).rejects.toThrow("Not recording");
    expect(store().getState().isSavingTake).toBe(false);
    expect(h.api.saveTake).not.toHaveBeenCalled();
  });

  it("does nothing without a song", async () => {
    store().setState({ song: null });
    await store().getState().stopRecording();
    expect(rec().stop).not.toHaveBeenCalled();
  });

  it("stops the recording when the song ends", async () => {
    h.state.currentTime = 5;
    await store().getState().startRecording();
    eng().finishCb();
    await vi.waitFor(() => expect(h.api.saveTake).toHaveBeenCalled());
    expect(store().getState().isRecording).toBe(false);
  });

  it("logs when the end-of-song auto-stop fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.api.saveTake.mockRejectedValue(new Error("down"));
    h.state.currentTime = 5;
    await store().getState().startRecording();
    eng().finishCb();
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith("[player] auto-stop recording failed:", expect.any(Error)));
  });
});

describe("count-in", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await loadedSong(song({ detectedBpm: 120 }));
    store().setState({ selectedDeviceId: "mic-ub" });
    h.api.saveTake.mockResolvedValue(take());
  });

  it("plays the click for the configured bars, then starts capture", async () => {
    store().getState().setCountInBars(1);
    const pending = store().getState().startRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(store().getState()).toMatchObject({ isCountingIn: true, countInBeatsRemaining: 4 });
    expect(h.metronome.start).toHaveBeenCalledWith(120, 0.05, 0);
    expect(rec().start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(store().getState().countInBeatsRemaining).toBe(3);

    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(h.metronome.stop).toHaveBeenCalled();
    expect(store().getState()).toMatchObject({ isCountingIn: false, countInBeatsRemaining: 0, isRecording: true });
    expect(rec().start).toHaveBeenCalled();
  });

  it("two bars last twice as long", async () => {
    store().getState().setCountInBars(2);
    let done = false;
    void store().getState().startRecording().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("scales the count-in tempo by the playback rate", async () => {
    store().setState({ playbackRate: 0.5 });
    store().getState().setCountInBars(1);
    void store().getState().startRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.metronome.start).toHaveBeenCalledWith(60, 0.05, 0);
  });

  it("falls back to 120 bpm when the song has no detected tempo", async () => {
    await loadedSong(song({ detectedBpm: undefined }));
    store().setState({ selectedDeviceId: "mic-ub" });
    store().getState().setCountInBars(2);
    void store().getState().startRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.metronome.start).toHaveBeenCalledWith(120, 0.05, 0);
  });

  it("cancelCountIn abandons the attempt, releasing the mic without ever recording", async () => {
    store().getState().setCountInBars(1);
    const pending = store().getState().startRecording();
    await vi.advanceTimersByTimeAsync(300);
    store().getState().cancelCountIn();
    await pending;
    expect(rec().start).not.toHaveBeenCalled();
    expect(rec().releaseStream).toHaveBeenCalled();
    expect(h.metronome.stop).toHaveBeenCalled();
    expect(eng().setInteract).toHaveBeenLastCalledWith(true);
    expect(store().getState()).toMatchObject({ isCountingIn: false, countInBeatsRemaining: 0, isRecording: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec().start).not.toHaveBeenCalled();
  });

  it("cancelCountIn is a no-op when no count-in is running", () => {
    store().getState().cancelCountIn();
    expect(h.metronome.stop).not.toHaveBeenCalled();
  });

  it("refuses to change the bar count while counting in or recording", () => {
    store().getState().setCountInBars(1);
    store().setState({ isRecording: true });
    store().getState().setCountInBars(2);
    expect(store().getState().countInBars).toBe(1);
    store().setState({ isRecording: false, isCountingIn: true });
    store().getState().setCountInBars(0);
    expect(store().getState().countInBars).toBe(1);
  });
});

// ─── takes ─────────────────────────────────────────────────────────────────

describe("takes", () => {
  beforeEach(async () => { await loadedSong(); });

  it("fetchTakes loads the song's takes (and is a no-op without a song)", async () => {
    h.api.listTakes.mockResolvedValue([take(), take({ id: "t2" })]);
    await store().getState().fetchTakes();
    expect(h.api.listTakes).toHaveBeenCalledWith("s1");
    expect(store().getState().takes).toHaveLength(2);
    store().setState({ song: null, takes: [] });
    h.api.listTakes.mockClear();
    await store().getState().fetchTakes();
    expect(h.api.listTakes).not.toHaveBeenCalled();
  });

  it("deleteTake removes it and deselects it if it was active", async () => {
    store().setState({ takes: [take(), take({ id: "t2" })], activeTakeId: "t1" });
    h.api.deleteTakeApi.mockResolvedValue(undefined);
    await store().getState().deleteTake("t1");
    expect(h.api.deleteTakeApi).toHaveBeenCalledWith("s1", "t1");
    expect(store().getState().takes.map((t) => t.id)).toEqual(["t2"]);
    expect(store().getState().activeTakeId).toBeNull();
  });

  it("deleteTake keeps another active take selected", async () => {
    store().setState({ takes: [take(), take({ id: "t2" })], activeTakeId: "t2" });
    await store().getState().deleteTake("t1");
    expect(store().getState().activeTakeId).toBe("t2");
  });

  it("deleteTake leaves everything in place when the backend rejects", async () => {
    store().setState({ takes: [take()], activeTakeId: "t1" });
    h.api.deleteTakeApi.mockRejectedValue(new Error("locked"));
    await expect(store().getState().deleteTake("t1")).rejects.toThrow("locked");
    expect(store().getState().takes).toHaveLength(1);
    expect(store().getState().activeTakeId).toBe("t1");
  });

  it("renameTake swaps in the backend's copy", async () => {
    store().setState({ takes: [take(), take({ id: "t2" })] });
    h.api.renameTakeApi.mockResolvedValue(take({ name: "Verse" }));
    await store().getState().renameTake("t1", "Verse");
    expect(store().getState().takes[0].name).toBe("Verse");
    expect(store().getState().takes[1].name).toBeUndefined();
  });

  it("take actions do nothing without a song", async () => {
    store().setState({ song: null });
    await store().getState().deleteTake("t1");
    await store().getState().renameTake("t1", "x");
    expect(h.api.deleteTakeApi).not.toHaveBeenCalled();
    expect(h.api.renameTakeApi).not.toHaveBeenCalled();
  });

  it("setActiveTake selects", () => {
    store().getState().setActiveTake("t9");
    expect(store().getState().activeTakeId).toBe("t9");
  });
});

describe("setTakeManualOffset", () => {
  beforeEach(async () => {
    await loadedSong();
    store().setState({ takes: [take()] });
    h.api.setTakeManualOffsetApi.mockResolvedValue(take());
  });

  it("rounds to 10 ms and updates store, engine and backend together", () => {
    store().getState().setTakeManualOffset("t1", 0.12345);
    expect(store().getState().takes[0].manualOffset).toBe(0.12);
    expect(eng().setTakeManualOffset).toHaveBeenCalledWith(0.12);
    expect(h.api.setTakeManualOffsetApi).toHaveBeenCalledWith("s1", "t1", 0.12);
  });

  it("accepts negative offsets (take dragged before song start)", () => {
    store().getState().setTakeManualOffset("t1", -3.456);
    expect(store().getState().takes[0].manualOffset).toBe(-3.46);
  });

  it("stores 0 as 'no manual offset' (undefined) but still tells the backend to reset", () => {
    store().getState().setTakeManualOffset("t1", 0.001);
    expect(store().getState().takes[0].manualOffset).toBeUndefined();
    expect(h.api.setTakeManualOffsetApi).toHaveBeenCalledWith("s1", "t1", 0);
  });

  it("only changes the targeted take", () => {
    store().setState({ takes: [take(), take({ id: "t2" })] });
    store().getState().setTakeManualOffset("t2", 1);
    expect(store().getState().takes[0].manualOffset).toBeUndefined();
    expect(store().getState().takes[1].manualOffset).toBe(1);
  });

  it("ignores unknown takes and a missing song", () => {
    store().getState().setTakeManualOffset("ghost", 1);
    expect(h.api.setTakeManualOffsetApi).not.toHaveBeenCalled();
    store().setState({ song: null });
    store().getState().setTakeManualOffset("t1", 1);
    expect(h.api.setTakeManualOffsetApi).not.toHaveBeenCalled();
  });

  it("logs, but keeps the local change, when persisting fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.api.setTakeManualOffsetApi.mockRejectedValue(new Error("disk"));
    store().getState().setTakeManualOffset("t1", 1);
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(store().getState().takes[0].manualOffset).toBe(1);
  });
});

describe("metronome offset", () => {
  beforeEach(async () => {
    await loadedSong();
    h.api.setMetronomeOffsetApi.mockResolvedValue(song());
  });

  it("clamps into the song, mirrors it onto the song object and persists it", () => {
    store().getState().setMetronomeOffset(12.5);
    expect(store().getState().metronomeOffset).toBe(12.5);
    expect(store().getState().song?.metronomeOffset).toBe(12.5);
    expect(h.api.setMetronomeOffsetApi).toHaveBeenCalledWith("s1", 12.5);
  });

  it.each([[-4, 0], [9999, 200]])("clamps %s to %s", (input, expected) => {
    store().getState().setMetronomeOffset(input);
    expect(store().getState().metronomeOffset).toBe(expected);
  });

  it("does nothing without a song", () => {
    store().setState({ song: null });
    store().getState().setMetronomeOffset(5);
    expect(h.api.setMetronomeOffsetApi).not.toHaveBeenCalled();
  });

  it("logs a persistence failure without throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.api.setMetronomeOffsetApi.mockRejectedValue(new Error("io"));
    store().getState().setMetronomeOffset(3);
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
  });
});

describe("timeline zoom", () => {
  it("stores zoom and scroll", () => {
    store().getState().setZoom(80, 12);
    expect(store().getState()).toMatchObject({ minPxPerSec: 80, scrollTime: 12 });
    store().getState().setScrollTime(3);
    expect(store().getState().scrollTime).toBe(3);
  });
});

describe("cleanup", () => {
  it("destroys the engine and returns the store to its empty state", async () => {
    await loadedSong();
    store().setState({ isRecording: true, takes: [take()], activeTakeId: "t1", soloedStem: "drums", transpose: 2 });
    store().getState().cleanup();
    expect(eng().destroy).toHaveBeenCalled();
    expect(store().getState()).toMatchObject({
      song: null, isPlaying: false, currentTime: 0, duration: 0, stemVolumes: {}, mutedStems: {}, soloedStem: null,
      transpose: 0, isRecording: false, takes: [], activeTakeId: null,
    });
  });

  it("disposes the recorder once one has been created", async () => {
    await loadedSong();
    store().setState({ selectedDeviceId: "mic-ub" });
    h.api.saveTake.mockResolvedValue(take());
    await store().getState().startRecording();
    store().getState().cleanup();
    expect(rec().dispose).toHaveBeenCalled();
  });

  it("works before any recorder exists", () => {
    expect(() => store().getState().cleanup()).not.toThrow();
  });
});
