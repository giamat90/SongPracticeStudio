import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── fake WaveSurfer ───────────────────────────────────────────────────────

const ws = vi.hoisted(() => {
  const instances: any[] = [];
  const config = { autoReady: true, failWith: null as unknown, readyDuration: 100, failNames: new Set<string>(), sinkError: null as unknown };

  class FakeWS {
    handlers = new Map<string, Set<(...a: any[]) => void>>();
    duration: number;
    currentTime = 0;
    width = 1000;
    options: any;
    play = vi.fn();
    pause = vi.fn();
    destroy = vi.fn();
    load = vi.fn();
    seekTo = vi.fn((progress: number) => { this.currentTime = progress * this.duration; });
    setTime = vi.fn((t: number) => { this.currentTime = t; });
    setVolume = vi.fn();
    setPlaybackRate = vi.fn();
    setSinkId = vi.fn(async () => { if (config.sinkError !== null) throw config.sinkError; });
    setOptions = vi.fn();
    zoom = vi.fn();
    setScrollTime = vi.fn();
    getWidth = vi.fn(() => this.width);
    getDuration = vi.fn(() => this.duration);
    getCurrentTime = vi.fn(() => this.currentTime);

    constructor(options: any) {
      this.options = options;
      this.duration = config.readyDuration;
      instances.push(this);
      if (config.autoReady) {
        queueMicrotask(() => {
          const failing = config.failWith !== null && (config.failNames.size === 0 || [...config.failNames].some((n) => String(options.url).includes(n)));
          if (failing) this.emit("error", config.failWith);
          else this.emit("ready");
        });
      }
    }

    on(event: string, cb: (...a: any[]) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(cb);
      return () => { this.handlers.get(event)?.delete(cb); };
    }

    emit(event: string, ...args: any[]) {
      [...(this.handlers.get(event) ?? [])].forEach((cb) => cb(...args));
    }
  }

  return { instances, config, FakeWS };
});

vi.mock("wavesurfer.js", () => ({ default: { create: (options: unknown) => new ws.FakeWS(options) } }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

import { AudioEngine, STEM_COLORS } from "./engine";

// ─── time and animation-frame control ──────────────────────────────────────

let now = 0;
let frames: Array<() => void> = [];
let nextFrameId = 1;

function runFrame(advanceMs = 16) {
  now += advanceMs;
  const batch = frames;
  frames = [];
  batch.forEach((cb) => cb());
}

const container = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;
const style = (el: HTMLElement) => (el as unknown as { style: Record<string, string> }).style;

const STEMS = ["vocals", "drums", "bass"];

function containersFor(names: string[]): Record<string, HTMLElement> {
  return Object.fromEntries(names.map((n) => [n, container()]));
}

async function loadedEngine(names: string[] = STEMS) {
  const engine = new AudioEngine();
  const before = ws.instances.length;
  await engine.load("C:\\lib\\song", names, containersFor(names));
  const stems = ws.instances.slice(before);
  const byName = Object.fromEntries(names.map((n, i) => [n, stems[i]])) as Record<string, any>;
  return { engine, stems, ...byName } as { engine: AudioEngine; stems: any[]; vocals: any; drums: any; bass: any };
}

async function withTake(engine: AudioEngine, opts: { duration: number; start: number; audioOffset?: number; manual?: number }) {
  ws.config.readyDuration = opts.duration;
  const el = container();
  await engine.loadTakeTrack("/t.wav", el, opts.start, opts.audioOffset ?? 0, opts.manual ?? 0);
  ws.config.readyDuration = 100;
  return { take: ws.instances[ws.instances.length - 1], el };
}

beforeEach(() => {
  ws.instances.length = 0;
  ws.config.autoReady = true;
  ws.config.failWith = null;
  ws.config.failNames.clear();
  ws.config.sinkError = null;
  ws.config.readyDuration = 100;
  now = 1000;
  frames = [];
  nextFrameId = 1;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return nextFrameId++; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
});

afterEach(() => {
  frames = [];
});

// ─── loading ───────────────────────────────────────────────────────────────

describe("load", () => {
  it("creates one WaveSurfer per stem from forward-slashed asset URLs with the stem's colour", async () => {
    const { stems } = await loadedEngine();
    expect(stems.map((s) => s.options.url)).toEqual([
      "asset://C:/lib/song/vocals.wav",
      "asset://C:/lib/song/drums.wav",
      "asset://C:/lib/song/bass.wav",
    ]);
    expect(stems[1].options.waveColor).toBe(STEM_COLORS.drums);
  });

  it("falls back to grey for a stem name without a colour", async () => {
    const { stems } = await loadedEngine(["vocals", "kazoo"]);
    expect(stems[1].options.waveColor).toBe("rgba(160,160,160,0.85)");
  });

  it("takes the duration from the vocals master when present", async () => {
    ws.config.readyDuration = 215;
    const { engine } = await loadedEngine();
    expect(engine.getDuration()).toBe(215);
  });

  it("uses the first available stem as the master clock when there is no vocals stem", async () => {
    const { engine, drums } = await loadedEngine(["drums", "bass"]);
    drums.currentTime = 12;
    expect(engine.getCurrentTime()).toBe(12);
  });

  it("skips stems that have no container", async () => {
    const engine = new AudioEngine();
    await engine.load("/s", ["vocals", "drums"], { vocals: container() });
    expect(ws.instances).toHaveLength(1);
  });

  it("does nothing when no stem could be created", async () => {
    const engine = new AudioEngine();
    await expect(engine.load("/s", ["vocals"], {})).resolves.toBe(true);
    expect(engine.getDuration()).toBe(0);
    expect(engine.getCurrentTime()).toBe(0);
    expect(() => engine.play()).not.toThrow();
  });

  it("reports that the stems are live once they have decoded", async () => {
    const engine = new AudioEngine();
    await expect(engine.load("/s", STEMS, containersFor(STEMS))).resolves.toBe(true);
  });

  it("resolves false when destroyed while still loading (React StrictMode cleanup)", async () => {
    ws.config.autoReady = false;
    const engine = new AudioEngine();
    const loading = engine.load("/s", STEMS, containersFor(STEMS));
    engine.destroy();
    ws.instances.forEach((s) => s.emit("ready"));
    await expect(loading).resolves.toBe(false);
    expect(engine.getDuration()).toBe(0);
  });

  it("tells a load that a newer load replaced it, even when its own stems finish decoding late", async () => {
    ws.config.autoReady = false;
    const engine = new AudioEngine();
    const first = engine.load("/s", STEMS, containersFor(STEMS));
    const firstStems = [...ws.instances];
    const second = engine.load("/s", STEMS, containersFor(STEMS));
    const secondStems = ws.instances.slice(firstStems.length);
    firstStems.forEach((s) => s.emit("ready"));
    await expect(first).resolves.toBe(false);
    expect(engine.getDuration()).toBe(0);
    secondStems.forEach((s) => s.emit("ready"));
    await expect(second).resolves.toBe(true);
    expect(engine.getDuration()).toBe(100);
  });

  it("rejects with the stem name and the WaveSurfer message when a stem fails to decode", async () => {
    ws.config.failWith = new Error("bad header");
    ws.config.failNames.add("bass.wav");
    const engine = new AudioEngine();
    await expect(engine.load("/s", STEMS, containersFor(STEMS))).rejects.toThrow("bass failed to load: bad header");
  });

  it("re-applies the remembered output device to every stem", async () => {
    const engine = new AudioEngine();
    await engine.setOutputDevice("out-1");
    await engine.load("/s", STEMS, containersFor(STEMS));
    for (const s of ws.instances) expect(s.setSinkId).toHaveBeenCalledWith("out-1");
  });

  it("warns, but still loads, when a stem refuses the output device", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ws.config.sinkError = new Error("denied");
    const { engine } = await loadedEngine(["vocals"]);
    expect(engine.getDuration()).toBe(100);
    expect(warn).toHaveBeenCalledWith('[engine] setSinkId failed for stem "vocals":', expect.any(Error));
  });

  it("destroys previous instances when loading again", async () => {
    const { engine, stems } = await loadedEngine();
    await engine.load("/other", STEMS, containersFor(STEMS));
    for (const s of stems) expect(s.destroy).toHaveBeenCalled();
  });

  it("reports the end of the song from the master and stops ticking", async () => {
    const { engine, vocals } = await loadedEngine();
    const finish = vi.fn();
    engine.onFinish(finish);
    engine.play();
    vocals.emit("finish");
    expect(finish).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(frames).toHaveLength(0);
  });
});

// ─── transport ─────────────────────────────────────────────────────────────

describe("transport", () => {
  it("plays and pauses every stem and reports state", async () => {
    const { engine, stems } = await loadedEngine();
    engine.play();
    stems.forEach((s) => expect(s.play).toHaveBeenCalled());
    expect(engine.isPlaying).toBe(true);
    engine.pause();
    stems.forEach((s) => expect(s.pause).toHaveBeenCalled());
    expect(engine.isPlaying).toBe(false);
  });

  it("togglePlay flips", async () => {
    const { engine } = await loadedEngine();
    engine.togglePlay();
    expect(engine.isPlaying).toBe(true);
    engine.togglePlay();
    expect(engine.isPlaying).toBe(false);
  });

  it("does nothing before a song is loaded", () => {
    const engine = new AudioEngine();
    engine.play();
    expect(engine.isPlaying).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("stop pauses and rewinds every stem", async () => {
    const { engine, stems } = await loadedEngine();
    engine.play();
    engine.stop();
    expect(engine.isPlaying).toBe(false);
    stems.forEach((s) => expect(s.seekTo).toHaveBeenLastCalledWith(0));
  });

  it("seekTo converts seconds to a clamped 0..1 progress on every stem", async () => {
    const { engine, stems } = await loadedEngine();
    engine.seekTo(25);
    stems.forEach((s) => expect(s.seekTo).toHaveBeenLastCalledWith(0.25));
    engine.seekTo(-5);
    stems.forEach((s) => expect(s.seekTo).toHaveBeenLastCalledWith(0));
    engine.seekTo(500);
    stems.forEach((s) => expect(s.seekTo).toHaveBeenLastCalledWith(1));
  });

  it("applies and remembers playback rate for stems and a later take", async () => {
    const { engine, stems } = await loadedEngine();
    engine.setPlaybackRate(0.75);
    stems.forEach((s) => expect(s.setPlaybackRate).toHaveBeenCalledWith(0.75));
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    expect(take.setPlaybackRate).toHaveBeenCalledWith(0.75);
  });

  it("setStemVolume reaches only the named stem", async () => {
    const { engine, vocals, drums, bass } = await loadedEngine();
    engine.setStemVolume("drums", 0.3);
    expect(drums.setVolume).toHaveBeenCalledWith(0.3);
    expect(vocals.setVolume).not.toHaveBeenCalled();
    expect(bass.setVolume).not.toHaveBeenCalled();
    expect(() => engine.setStemVolume("nope", 1)).not.toThrow();
  });

  it("setTakeVolume reaches the take and is harmless without one", async () => {
    const { engine } = await loadedEngine();
    expect(() => engine.setTakeVolume(0.5)).not.toThrow();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.setTakeVolume(0.5);
    expect(take.setVolume).toHaveBeenCalledWith(0.5);
  });

  it("setInteract toggles click-to-seek on every stem and the take", async () => {
    const { engine, stems } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.setInteract(false);
    [...stems, take].forEach((s) => expect(s.setOptions).toHaveBeenCalledWith({ interact: false }));
  });

  it("setOutputDevice reaches every live instance and survives having none", async () => {
    await expect(new AudioEngine().setOutputDevice("x")).resolves.toBeUndefined();
    const { engine, stems } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    await engine.setOutputDevice("out-2");
    [...stems, take].forEach((s) => expect(s.setSinkId).toHaveBeenCalledWith("out-2"));
  });
});

describe("user clicks on a waveform keep the others in sync", () => {
  it("clicking one stem seeks every other stem (not itself) to the same progress", async () => {
    const { vocals, drums, bass } = await loadedEngine();
    vocals.seekTo.mockClear(); drums.seekTo.mockClear(); bass.seekTo.mockClear();
    drums.emit("interaction", 40);
    expect(vocals.seekTo).toHaveBeenCalledWith(0.4);
    expect(bass.seekTo).toHaveBeenCalledWith(0.4);
    expect(drums.seekTo).not.toHaveBeenCalled();
  });

  it("clamps the clicked time to the song", async () => {
    const { vocals, drums } = await loadedEngine();
    vocals.seekTo.mockClear();
    drums.emit("interaction", 400);
    expect(vocals.seekTo).toHaveBeenCalledWith(1);
  });

  it("also moves the take to the matching file position", async () => {
    const { engine, drums } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 40, start: 20 });
    drums.emit("interaction", 30);
    expect(take.seekTo).toHaveBeenLastCalledWith(10 / 40);
  });
});

describe("a click on a waveform while paused tells the UI the new position", () => {
  it("a stem click reports the clicked song time", async () => {
    const { engine, drums } = await loadedEngine();
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    drums.emit("interaction", 40);
    expect(cb).toHaveBeenLastCalledWith(40);
  });

  it("never reports a time outside the song", async () => {
    const { engine, drums } = await loadedEngine();
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    drums.emit("interaction", 400);
    expect(cb).toHaveBeenLastCalledWith(100);
    drums.emit("interaction", -5);
    expect(cb).toHaveBeenLastCalledWith(0);
  });

  it("a take click reports song time through the take's start, audio offset and manual offset", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 30, start: 20, audioOffset: 2, manual: 1 });
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    take.emit("interaction", 5);
    expect(cb).toHaveBeenLastCalledWith(5 - 2 + 20 + 1);
  });

  it("does not need a registered listener", async () => {
    const { drums } = await loadedEngine();
    expect(() => drums.emit("interaction", 10)).not.toThrow();
  });
});

// ─── transpose reload ──────────────────────────────────────────────────────

describe("reloadStemsFromPaths", () => {
  async function reload(engine: AudioEngine, stems: any[], paths: Record<string, string>) {
    const loading = engine.reloadStemsFromPaths(paths);
    await Promise.resolve();
    stems.forEach((s) => s.emit("ready"));
    await loading;
  }

  it("is a no-op without a loaded song", async () => {
    await expect(new AudioEngine().reloadStemsFromPaths({ vocals: "/v.wav" })).resolves.toBeUndefined();
  });

  it("loads each named stem from its asset URL and leaves the others alone", async () => {
    const { engine, vocals, drums, bass } = await loadedEngine();
    const loading = engine.reloadStemsFromPaths({ vocals: "C:\\p\\v.wav", bass: "/p/b.wav" });
    await Promise.resolve();
    vocals.emit("ready");
    bass.emit("ready");
    await loading;
    expect(vocals.load).toHaveBeenCalledWith("asset://C:/p/v.wav");
    expect(bass.load).toHaveBeenCalledWith("asset://" + "/p/b.wav");
    expect(drums.load).not.toHaveBeenCalled();
  });

  it("restores the playhead and resumes playback if it was playing", async () => {
    const { engine, stems, vocals } = await loadedEngine();
    vocals.currentTime = 33;
    engine.play();
    stems.forEach((s) => s.play.mockClear());
    await reload(engine, stems, { vocals: "/a", drums: "/b", bass: "/c" });
    expect(stems.every((s) => s.pause.mock.calls.length > 0)).toBe(true);
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0.33);
    stems.forEach((s) => expect(s.play).toHaveBeenCalled());
    expect(engine.isPlaying).toBe(true);
  });

  it("stays paused if it was paused", async () => {
    const { engine, stems } = await loadedEngine();
    await reload(engine, stems, { vocals: "/a", drums: "/b", bass: "/c" });
    expect(engine.isPlaying).toBe(false);
  });

  it("adopts the new duration of the master", async () => {
    const { engine, stems, vocals } = await loadedEngine();
    const loading = engine.reloadStemsFromPaths({ vocals: "/a" });
    await Promise.resolve();
    vocals.duration = 90;
    stems.forEach((s) => s.emit("ready"));
    await loading;
    expect(engine.getDuration()).toBe(90);
  });

  it("rejects naming the stem when the new file cannot be decoded", async () => {
    const { engine, drums } = await loadedEngine();
    const loading = engine.reloadStemsFromPaths({ drums: "/bad.wav" });
    await Promise.resolve();
    drums.emit("error", new Error("corrupt"));
    await expect(loading).rejects.toThrow("drums failed to reload: corrupt");
  });
});

// ─── take track ────────────────────────────────────────────────────────────

describe("take track", () => {
  it("sizes and positions the take rail from its start time, audio offset and the current zoom", async () => {
    const { engine } = await loadedEngine();
    engine.zoomAll(10, 5);
    const { take, el } = await withTake(engine, { duration: 30, start: 20, audioOffset: 2, manual: 1 });
    expect(style(el).width).toBe(`${(30 - 2) * 10}px`);
    expect(style(el).marginLeft).toBe(`${(20 + 1 - 5) * 10}px`);
    expect(take.setOptions).toHaveBeenCalledWith({ width: 280 });
  });

  it("seeks the take to the file position that matches the song position", async () => {
    const { engine, vocals } = await loadedEngine();
    vocals.currentTime = 25;
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2 });
    expect(take.seekTo).toHaveBeenLastCalledWith((2 + 5) / 40);
  });

  it("keeps the take at its first playable sample before the take starts", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2 });
    engine.seekTo(5);
    expect(take.seekTo).toHaveBeenLastCalledWith(2 / 40);
  });

  it("clamps the take position at its last sample when seeking past its end", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    engine.seekTo(90);
    expect(take.seekTo).toHaveBeenLastCalledWith(1);
  });

  it("starts playing the take only when the playhead is inside its window", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    vocals.currentTime = 5;
    engine.play();
    expect(take.play).not.toHaveBeenCalled();
    engine.pause();
    vocals.currentTime = 22;
    engine.play();
    expect(take.play).toHaveBeenCalledTimes(1);
  });

  it("the take window ends where the playable audio ends (file length minus audio offset)", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20, audioOffset: 4 });
    vocals.currentTime = 26.5;
    engine.play();
    expect(take.play).not.toHaveBeenCalled();
  });

  it("clicking the take seeks the song to the matching time (undoing audio and manual offsets)", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2, manual: 1 });
    vocals.seekTo.mockClear();
    drums.seekTo.mockClear();
    take.emit("interaction", 12);
    const songTime = 12 - 2 + 20 + 1;
    expect(vocals.seekTo).toHaveBeenLastCalledWith(songTime / 100);
    expect(drums.seekTo).toHaveBeenLastCalledWith(songTime / 100);
  });

  it("setTakeManualOffset moves the rail and re-aims the take at the playhead", async () => {
    const { engine, vocals } = await loadedEngine();
    engine.zoomAll(10, 0);
    const { take, el } = await withTake(engine, { duration: 20, start: 10 });
    vocals.currentTime = 15;
    engine.setTakeManualOffset(2);
    expect(style(el).marginLeft).toBe(`${(10 + 2) * 10}px`);
    expect(take.seekTo).toHaveBeenLastCalledWith((15 - 12) / 20);
  });

  it("supports a negative manual offset that pushes the take before song time 0", async () => {
    const { engine } = await loadedEngine();
    engine.zoomAll(10, 0);
    const { el } = await withTake(engine, { duration: 20, start: 1 });
    engine.setTakeManualOffset(-3);
    expect(style(el).marginLeft).toBe(`${(1 - 3) * 10}px`);
  });

  it("clearTakeTrack destroys it and forgets its offsets", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 20, start: 10 });
    engine.clearTakeTrack();
    expect(take.destroy).toHaveBeenCalled();
    expect(() => engine.setTakeManualOffset(1)).not.toThrow();
    vocals.currentTime = 15;
    engine.play();
    expect(take.play).not.toHaveBeenCalled();
  });

  it("replacing the take destroys the old one", async () => {
    const { engine } = await loadedEngine();
    const first = await withTake(engine, { duration: 20, start: 0 });
    await withTake(engine, { duration: 20, start: 0 });
    expect(first.take.destroy).toHaveBeenCalled();
  });

  it("rejects with the WaveSurfer message when the take cannot load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { engine } = await loadedEngine();
    ws.config.failWith = new Error("decode failure");
    await expect(engine.loadTakeTrack("/t.wav", container())).rejects.toThrow("decode failure");
  });

  it("resumes the take mid-play when loaded while the playhead is inside its window", async () => {
    const { engine, vocals } = await loadedEngine();
    vocals.currentTime = 12;
    engine.play();
    const { take } = await withTake(engine, { duration: 10, start: 10 });
    expect(take.play).toHaveBeenCalled();
  });

  it("does not start a take that was loaded while paused", async () => {
    const { engine, vocals } = await loadedEngine();
    vocals.currentTime = 12;
    const { take } = await withTake(engine, { duration: 10, start: 10 });
    expect(take.play).not.toHaveBeenCalled();
  });

  it("pausing also pauses the take", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    vocals.currentTime = 1;
    engine.play();
    engine.pause();
    expect(take.pause).toHaveBeenCalled();
  });
});

// ─── animation-frame tick ──────────────────────────────────────────────────

describe("playback tick", () => {
  it("notifies the UI at most every 33 ms but runs every frame", async () => {
    const { engine, vocals } = await loadedEngine();
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    vocals.currentTime = 1;
    engine.play();
    for (let i = 0; i < 4; i++) runFrame(16);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(cb.mock.calls.length).toBeLessThanOrEqual(3);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("stops scheduling frames after pause", async () => {
    const { engine } = await loadedEngine();
    engine.play();
    engine.pause();
    expect(frames).toHaveLength(0);
  });

  it("loops from loopEnd back to loopStart on every stem", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    engine.setLoop(10, 20);
    engine.play();
    vocals.currentTime = 20.01;
    runFrame();
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0.1);
    expect(drums.seekTo).toHaveBeenLastCalledWith(0.1);
    engine.clearLoop();
    vocals.seekTo.mockClear();
    vocals.currentTime = 25;
    runFrame();
    expect(vocals.seekTo).not.toHaveBeenCalled();
  });

  it("does not loop before the loop end", async () => {
    const { engine, vocals } = await loadedEngine();
    engine.setLoop(10, 20);
    engine.play();
    vocals.currentTime = 19.9;
    runFrame();
    expect(vocals.seekTo).not.toHaveBeenCalled();
  });

  it("starts and stops the take as the playhead enters and leaves its window", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    vocals.currentTime = 5;
    engine.play();
    runFrame();
    expect(take.play).not.toHaveBeenCalled();

    vocals.currentTime = 21;
    runFrame();
    expect(take.play).toHaveBeenCalledTimes(1);
    runFrame();
    expect(take.play).toHaveBeenCalledTimes(1);

    vocals.currentTime = 31;
    runFrame();
    expect(take.pause).toHaveBeenCalled();
  });

  it("pulls a stem back when it drifts more than 50 ms from the master", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    vocals.currentTime = 10;
    drums.currentTime = 10.2;
    engine.play();
    runFrame(300);
    expect(drums.setTime).toHaveBeenCalledWith(10);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("leaves a stem alone within tolerance", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    vocals.currentTime = 10;
    drums.currentTime = 10.03;
    engine.play();
    runFrame(300);
    expect(drums.setTime).not.toHaveBeenCalled();
  });

  it("checks drift at most every 250 ms", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    vocals.currentTime = 10;
    drums.currentTime = 11;
    engine.play();
    runFrame(300);
    drums.setTime.mockClear();
    drums.currentTime = 11;
    runFrame(100);
    expect(drums.setTime).not.toHaveBeenCalled();
    runFrame(200);
    expect(drums.setTime).toHaveBeenCalled();
  });

  it("when the master is silent, pulls it toward the first audible stem and never the reverse", async () => {
    const { engine, vocals, drums, bass } = await loadedEngine();
    engine.setStemVolume("vocals", 0);
    vocals.currentTime = 11;
    drums.currentTime = 10;
    bass.currentTime = 10;
    engine.play();
    runFrame(300);
    expect(vocals.setTime).toHaveBeenCalledWith(10);
    expect(drums.setTime).not.toHaveBeenCalled();
    expect(bass.setTime).not.toHaveBeenCalled();
  });

  it("keeps the master as reference when everything is silent", async () => {
    const { engine, vocals, drums, bass } = await loadedEngine();
    for (const n of STEMS) engine.setStemVolume(n, 0);
    vocals.currentTime = 10;
    drums.currentTime = 12;
    bass.currentTime = 12;
    engine.play();
    runFrame(300);
    expect(drums.setTime).toHaveBeenCalledWith(10);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("un-silences a stem when its volume comes back", async () => {
    const { engine, vocals, drums } = await loadedEngine();
    engine.setStemVolume("vocals", 0);
    engine.setStemVolume("vocals", 0.5);
    vocals.currentTime = 11;
    drums.currentTime = 10;
    engine.play();
    runFrame(300);
    expect(drums.setTime).toHaveBeenCalledWith(11);
  });

  it("forgets which stems were silent when a new song is loaded", async () => {
    const { engine } = await loadedEngine();
    engine.setStemVolume("vocals", 0);
    await engine.load("/next", STEMS, containersFor(STEMS));
    const [vocals, drums] = ws.instances.slice(-3);
    vocals.currentTime = 11;
    drums.currentTime = 10;
    engine.play();
    runFrame(300);
    expect(drums.setTime).toHaveBeenCalledWith(11);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("re-aims a drifting take", async () => {
    const { engine, vocals } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 30, start: 10 });
    vocals.currentTime = 15;
    engine.play();
    take.currentTime = 7;
    runFrame(300);
    expect(take.setTime).toHaveBeenCalledWith(5);
  });

  it("auto-follows the playhead when zoomed in and it passes the right margin", async () => {
    const { engine, vocals } = await loadedEngine();
    engine.zoomAll(20, 0);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    vocals.currentTime = 48;
    engine.play();
    runFrame(1000);
    expect(scroll).toHaveBeenCalled();
    const [px, t] = scroll.mock.calls[0];
    expect(px).toBe(20);
    expect(t).toBeCloseTo(48 - 50 * 0.85, 9);
  });

  it("does not auto-follow right after a manual pan or zoom", async () => {
    const { engine, vocals } = await loadedEngine();
    engine.zoomAll(20, 0);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    vocals.currentTime = 48;
    engine.play();
    engine.noteManualScrollInteraction();
    runFrame(100);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("does not auto-follow when fully zoomed out", async () => {
    const { engine, vocals } = await loadedEngine();
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    engine.zoomAll(engine.getMinPxPerSec(), 0);
    vocals.currentTime = 99;
    engine.play();
    runFrame(1000);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("scrolls back when the playhead is left of the visible window", async () => {
    const { engine, vocals } = await loadedEngine();
    engine.zoomAll(20, 30);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    vocals.currentTime = 10;
    engine.play();
    runFrame(1000);
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.calls[0][1]).toBeLessThan(30);
  });
});

describe("zoom", () => {
  it("baseline zoom makes the whole song fill the viewport", async () => {
    const { vocals, engine } = await loadedEngine();
    vocals.width = 800;
    expect(engine.getMinPxPerSec()).toBe(8);
  });

  it("falls back to 1 px/s with no song or zero width", async () => {
    expect(new AudioEngine().getMinPxPerSec()).toBe(1);
    const { engine, vocals } = await loadedEngine();
    vocals.width = 0;
    expect(engine.getMinPxPerSec()).toBe(1);
  });

  it("zoomAll and setScrollAll drive every instance including the take", async () => {
    const { engine, stems } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.zoomAll(15, 4);
    for (const i of [...stems, take]) {
      expect(i.zoom).toHaveBeenCalledWith(15);
      expect(i.setScrollTime).toHaveBeenCalledWith(4);
    }
    engine.setScrollAll(9);
    expect(take.setScrollTime).toHaveBeenLastCalledWith(9);
  });
});

describe("destroy", () => {
  it("tears down every instance and resets state", async () => {
    const { engine, stems } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.play();
    engine.destroy();
    for (const i of [...stems, take]) expect(i.destroy).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(engine.getDuration()).toBe(0);
    expect(engine.getCurrentTime()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it("resets the zoom baseline so a following song starts unzoomed", async () => {
    const { engine } = await loadedEngine();
    engine.zoomAll(40, 10);
    engine.destroy();
    const next = await loadedEngine();
    const scroll = vi.fn();
    next.engine.onScrollChange(scroll);
    next.vocals.currentTime = 99;
    next.engine.play();
    runFrame(1000);
    expect(scroll).not.toHaveBeenCalled();
  });
});
