import { LiveAnalyser, liveFrameTime, type LiveReading, type LiveTrace } from "../lib/liveInput";
import type { LiveSource } from "./liveInput";

/** How often the input is looked at: the window is 0.37 s long, so more often than this only repeats itself. */
export const TICK_MS = 100;

/** `start()` was overtaken by a `stop()` while the device was still opening; the device has been given back. */
export class StartCancelled extends Error {
  constructor() {
    super("Monitor stopped before the input was open.");
  }
}

export interface MonitorDeps {
  open: (deviceId: string | null) => Promise<LiveSource>;
  deviceId: () => string | null;
  /** Where the song is, whether it plays, and the round trip (s) between hearing the song and capturing what is played to it. */
  clock: () => { playing: boolean; time: number; latencyS: number };
  trace: LiveTrace;
  publish: (reading: LiveReading) => void;
  /** The device went away while listening. */
  lost: (message: string) => void;
  every: (callback: () => void, ms: number) => number;
  cancelEvery: (id: number) => void;
}

export interface LiveMonitor {
  readonly running: boolean;
  /** Opens the input and starts reading it; resolves with the device's name. Does nothing when already running. */
  start(): Promise<string>;
  stop(): void;
}

/**
 * Listens to the input every TICK_MS: the spectrum and notes go to `publish`, the notes also into `trace` at the
 * song time they belong to. It owns no UI and no store, so it runs the same with a fake input in the tests.
 */
export function createLiveMonitor(deps: MonitorDeps): LiveMonitor {
  const analyser = new LiveAnalyser();
  let source: LiveSource | null = null;
  let timer: number | null = null;
  let opening: Promise<string> | null = null;
  // Bumped by stop(): a start() that finds it changed was stopped before it finished opening.
  let epoch = 0;

  const tick = () => {
    if (!source) return;
    const samples = source.read();
    if (!samples) return;
    const reading = analyser.process(samples, source.sampleRate);
    const { playing, time, latencyS } = deps.clock();
    deps.trace.write(liveFrameTime(playing, time, source.sampleRate, latencyS), reading.notes);
    deps.publish(reading);
  };

  const release = () => {
    if (timer !== null) deps.cancelEvery(timer);
    timer = null;
    source?.close();
    source = null;
    analyser.reset();
  };

  return {
    get running() {
      return source !== null;
    },

    start() {
      if (source) return Promise.resolve(source.label);
      if (opening) return opening;
      const started = epoch;
      opening = (async () => {
        const opened = await deps.open(deps.deviceId());
        if (started !== epoch) {
          opened.close();
          throw new StartCancelled();
        }
        opened.onEnded(() => {
          if (source !== opened) return;
          release();
          deps.lost("The input was disconnected.");
        });
        source = opened;
        timer = deps.every(tick, TICK_MS);
        return opened.label;
      })().finally(() => {
        opening = null;
      });
      return opening;
    },

    stop() {
      epoch++;
      release();
      deps.trace.clear();
    },
  };
}
