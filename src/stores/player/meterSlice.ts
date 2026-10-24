import {
  barsFromBarTaps,
  barsFromBeatTaps,
  gridMap,
  replaceBars,
  validateMap,
  type BarMap,
} from "@giamat90/mps-core/meter";
import { clearMeterEdits, hasMeterEdits, readSongMeter, redetectSongMeter, saveMeterEdits } from "../../lib/tauri";
import { persistClickDensity, readClickDensity } from "./prefs";
import { getEngine } from "./singletons";
import type { MeterEntry, MeterSlice, Slice } from "./types";

const HISTORY_LIMIT = 40;
const DOES_NOT_FIT = "That does not fit here: a pulse needs at least a twentieth of a second.";

export function meterReset() {
  return { meterMap: null, meterEdited: false, meterHistory: [], meterSelected: null, meterBusy: false, meterError: null, tapSession: null };
}

// Saves go out one at a time and in order, so a quick run of edits cannot land on disk shuffled.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

const remember = (history: MeterEntry[], entry: MeterEntry): MeterEntry[] => [...history, entry].slice(-HISTORY_LIMIT);

export const createMeterSlice: Slice<MeterSlice> = (set, get) => {
  const store = async (songId: string, entry: MeterEntry) => {
    await enqueue(async () => {
      if (entry.edited && entry.map) await saveMeterEdits(songId, entry.map);
      else await clearMeterEdits(songId);
    });
  };

  const fail = (message: string, e: unknown) => {
    console.error(`[meter] ${message}:`, e);
    set({ meterError: `${message}: ${String(e)}`, meterBusy: false });
  };

  return {
    meterMap: null,
    meterEdited: false,
    meterHistory: [],
    meterSelected: null,
    meterBusy: false,
    meterError: null,
    clickDensity: readClickDensity(),
    tapSession: null,

    loadMeter: async (songId) => {
      const [doc, edited] = await Promise.all([readSongMeter(songId), hasMeterEdits(songId)]);
      if (get().song?.id !== songId) return;
      set({ meterMap: doc, meterEdited: edited && doc !== null, meterHistory: [], meterSelected: null, meterError: null });
    },

    applyMeter: async (next, select) => {
      const { song, meterMap, meterEdited, meterHistory } = get();
      if (!song) return;
      if (next === null) {
        set({ meterError: DOES_NOT_FIT });
        return;
      }
      const problem = validateMap(next);
      if (problem) {
        set({ meterError: problem });
        return;
      }
      set({
        meterMap: next,
        meterEdited: true,
        meterHistory: remember(meterHistory, { map: meterMap, edited: meterEdited }),
        meterError: null,
        ...(select === undefined ? {} : { meterSelected: select }),
      });
      try {
        await store(song.id, { map: next, edited: true });
      } catch (e) {
        fail("Saving the bars failed", e);
        await get().loadMeter(song.id);
      }
    },

    undoMeter: async () => {
      const { song, meterHistory, meterSelected } = get();
      const entry = meterHistory[meterHistory.length - 1];
      if (!song || !entry) return;
      const bars = entry.map?.bars.length ?? 0;
      set({
        meterMap: entry.map,
        meterEdited: entry.edited,
        meterHistory: meterHistory.slice(0, -1),
        meterSelected: meterSelected !== null && meterSelected < bars ? meterSelected : null,
        meterError: null,
      });
      try {
        await store(song.id, entry);
      } catch (e) {
        fail("Undoing failed", e);
        await get().loadMeter(song.id);
      }
    },

    resetMeter: async () => {
      const { song, meterMap, meterEdited, meterHistory } = get();
      if (!song || !meterEdited) return;
      try {
        await enqueue(() => clearMeterEdits(song.id));
        const detected = await readSongMeter(song.id);
        if (get().song?.id !== song.id) return;
        set({
          meterMap: detected,
          meterEdited: false,
          meterHistory: remember(meterHistory, { map: meterMap, edited: true }),
          meterSelected: null,
          meterError: null,
        });
      } catch (e) {
        fail("Going back to the detected bars failed", e);
      }
    },

    detectMeter: async () => {
      const { song, meterMap, meterEdited, meterHistory } = get();
      if (!song || get().meterBusy) return;
      set({ meterBusy: true, meterError: null });
      try {
        const doc = await redetectSongMeter(song.id);
        if (get().song?.id !== song.id) return;
        set({
          meterMap: doc,
          meterEdited: false,
          meterHistory: meterMap ? remember(meterHistory, { map: meterMap, edited: meterEdited }) : meterHistory,
          meterSelected: null,
          meterBusy: false,
        });
      } catch (e) {
        fail("Finding the bars failed", e);
      }
    },

    startMeterFromGrid: async () => {
      const { song, duration, metronomeOffset } = get();
      if (!song) return;
      const bpm = song.detectedBpm ?? 120;
      const grid = gridMap({ first: metronomeOffset, pulse: 60 / bpm, num: 4, den: 4, end: duration, source: "grid" });
      await get().applyMeter(grid, 0);
    },

    selectBar: (index) => set({ meterSelected: index }),

    setClickDensity: (density) => {
      set({ clickDensity: density });
      persistClickDensity(density);
    },

    startTapping: (session) => set({ tapSession: { ...session, taps: [] }, meterError: null }),

    tapNow: () => {
      const session = get().tapSession;
      if (!session) return;
      set({ tapSession: { ...session, taps: [...session.taps, getEngine().getCurrentTime()] } });
    },

    finishTapping: async () => {
      const { tapSession, meterMap } = get();
      set({ tapSession: null });
      if (!tapSession) return;
      const built =
        tapSession.kind === "bars"
          ? barsFromBarTaps(tapSession.taps, { den: tapSession.den, pulse: tapSession.pulse })
          : barsFromBeatTaps(tapSession.taps, { den: tapSession.den, perBar: tapSession.perBar });
      if (!built) {
        set({ meterError: "Tap at least twice: on the first beat of two bars, or on two beats." });
        return;
      }
      const from = built.bars[0].start;
      const next: BarMap | null = meterMap
        ? replaceBars(meterMap, from, built.closing, built.bars)
        : { version: 1, bars: built.bars, end: built.closing, source: "tapped" };
      const select = next ? next.bars.findIndex((b) => b.start === from) : -1;
      await get().applyMeter(next, select === -1 ? null : select);
    },

    cancelTapping: () => set({ tapSession: null }),

    clearMeterError: () => set({ meterError: null }),
  };
};
