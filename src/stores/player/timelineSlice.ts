import { addLoop, removeLoop, renameLoop as renameLoopIn } from "@giamat90/mps-core/loops";
import { setMetronomeOffsetApi, setSongLoopsApi } from "../../lib/tauri";
import type { NamedLoop } from "../../lib/types";
import type { Getter, Setter, Slice, TimelineSlice } from "./types";

export function punchReset() {
  return { punchIn: null, punchOut: null, punchLoop: false };
}

async function persistLoops(set: Setter, get: Getter, songId: string, loops: NamedLoop[]): Promise<void> {
  const saved = await setSongLoopsApi(songId, loops);
  const current = get().song;
  if (current && current.id === songId) set({ song: { ...current, loops: saved.loops ?? [] } });
}

export const createTimelineSlice: Slice<TimelineSlice> = (set, get) => ({
  punchIn: null,
  punchOut: null,
  punchLoop: false,
  minPxPerSec: 1,
  scrollTime: 0,
  metronomeOffset: 0,

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set(punchReset()),
  setPunchLoop: (v) => set({ punchLoop: v }),

  setZoom: (minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }),
  setScrollTime: (scrollTime) => set({ scrollTime }),

  setMetronomeOffset: (t) => {
    const { song, duration } = get();
    if (!song) return;
    const clamped = Math.max(0, Math.min(duration > 0 ? duration : Math.max(0, t), t));
    set({ metronomeOffset: clamped, song: { ...song, metronomeOffset: clamped } });
    setMetronomeOffsetApi(song.id, clamped).catch((e: unknown) =>
      console.error("[player] failed to persist metronome offset:", e)
    );
  },

  saveLoop: async (name) => {
    const { song, punchIn, punchOut, duration } = get();
    if (!song) return;
    if (punchIn === null || punchOut === null) throw new Error("Set a punch region first");
    const next = addLoop(song.loops ?? [], { id: crypto.randomUUID(), name, start: punchIn, end: punchOut }, duration);
    await persistLoops(set, get, song.id, next);
  },

  renameLoop: async (id, name) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(set, get, song.id, renameLoopIn(song.loops ?? [], id, name));
  },

  deleteLoop: async (id) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(set, get, song.id, removeLoop(song.loops ?? [], id));
  },

  applyLoopRegion: (start, end) => {
    set({ punchIn: start, punchOut: end, punchLoop: true });
    get().seek(start);
  },
});
