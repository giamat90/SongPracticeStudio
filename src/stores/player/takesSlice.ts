import { hideTake, reconcileTakes, showTake, toggleTake, type TakeSelection } from "@giamat90/mps-core/takes";
import type { Take } from "../../lib/types";
import { deleteTakeApi, listTakes, renameTakeApi, setTakeManualOffsetApi } from "../../lib/tauri";
import { effectiveStemGain, selectionOf, TAKE_TRACK_KEY } from "./audioMix";
import { loadTakePrefs, persistTakePrefs } from "./prefs";
import { getEngine } from "./singletons";
import type { Getter, Setter, Slice, TakesSlice } from "./types";

export function takesReset() {
  return {
    takes: [],
    shownTakeIds: [],
    activeTakeId: null,
    mutedTakeIds: [],
    soloedTakeId: null,
    takeGains: {},
    takeVolume: 1.0,
  };
}

// The per-take state that must not outlive its take: lane mutes, gains and the solo.
function pruned(state: TakesSlice, keep: (id: string) => boolean) {
  return {
    mutedTakeIds: state.mutedTakeIds.filter(keep),
    takeGains: Object.fromEntries(Object.entries(state.takeGains).filter(([id]) => keep(id))),
    ...(state.soloedTakeId !== null && !keep(state.soloedTakeId) ? { soloedTakeId: null } : {}),
  };
}

function applySelection(set: Setter, get: Getter, next: TakeSelection): void {
  const s = get();
  const lost = s.soloedTakeId !== null && !next.shown.includes(s.soloedTakeId);
  set({
    shownTakeIds: [...next.shown],
    activeTakeId: next.active,
    ...(lost ? { soloedTakeId: null } : {}),
  });
}

async function deleteEach(songId: string, takes: Take[]): Promise<{ deleted: Set<string>; failure: unknown }> {
  const deleted = new Set<string>();
  for (const t of takes) {
    try {
      await deleteTakeApi(songId, t.id);
      deleted.add(t.id);
    } catch (e) {
      return { deleted, failure: e };
    }
  }
  return { deleted, failure: null };
}

export const createTakesSlice: Slice<TakesSlice> = (set, get) => ({
  takes: [],
  shownTakeIds: [],
  activeTakeId: null,
  mutedTakeIds: [],
  soloedTakeId: null,
  takeGains: {},
  ...loadTakePrefs(),
  takeVolume: 1.0,

  fetchTakes: async () => {
    const { song } = get();
    if (!song) return;
    const takes = await listTakes(song.id);
    const ids = takes.map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), ids);
    set((state) => ({
      takes,
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruned(state, (id) => ids.includes(id)),
    }));
  },

  deleteTake: async (takeId) => {
    const { song } = get();
    if (!song) return;
    await deleteTakeApi(song.id, takeId);
    const next = hideTake(selectionOf(get()), takeId);
    set((state) => ({
      takes: state.takes.filter((t) => t.id !== takeId),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruned(state, (id) => id !== takeId),
    }));
  },

  deleteAllTakes: async () => {
    const { song, takes } = get();
    if (!song || takes.length === 0) return;
    const { deleted, failure } = await deleteEach(song.id, takes);
    const remaining = takes.filter((t) => !deleted.has(t.id)).map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), remaining);
    set((state) => ({
      takes: state.takes.filter((t) => !deleted.has(t.id)),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruned(state, (id) => !deleted.has(id)),
    }));
    if (failure) throw failure;
  },

  renameTake: async (takeId, name) => {
    const { song } = get();
    if (!song) return;
    const updated = await renameTakeApi(song.id, takeId, name);
    set((state) => ({
      takes: state.takes.map((t) => (t.id === takeId ? updated : t)),
    }));
  },

  setTakeManualOffset: (takeId, offset) => {
    const { song, takes } = get();
    if (!song) return;
    const take = takes.find((t) => t.id === takeId);
    if (!take) return;
    // Unclamped — a take can be dragged to start before song time 0. Its
    // leading edge just becomes unreachable during playback; the recorded
    // file itself is never trimmed or otherwise modified.
    const rounded = Math.round(offset * 100) / 100;
    const updated = { ...take, manualOffset: rounded || undefined };
    set({ takes: takes.map((t) => (t.id === takeId ? updated : t)) });
    getEngine().setTakeManualOffset(takeId, rounded);
    setTakeManualOffsetApi(song.id, takeId, rounded).catch((e: unknown) =>
      console.error("[player] failed to persist take manual offset:", e)
    );
  },

  toggleTakeSolo: (takeId) => {
    set((s) => ({ soloedTakeId: s.soloedTakeId === takeId ? null : takeId }));
  },

  setTakeGain: (takeId, gain) => {
    set((s) => ({ takeGains: { ...s.takeGains, [takeId]: Math.max(0, Math.min(1, gain)) } }));
  },

  setActiveTake: (takeId) => applySelection(set, get, showTake(selectionOf(get()), takeId)),

  toggleTake: (takeId) => applySelection(set, get, toggleTake(selectionOf(get()), takeId)),

  hideTake: (takeId) => applySelection(set, get, hideTake(selectionOf(get()), takeId)),

  setTakePlayback: (mode) => {
    set({ takePlayback: mode });
    persistTakePrefs({ takePlayback: mode, muteTakesWhileRecording: get().muteTakesWhileRecording });
  },

  toggleTakeMute: (takeId) => {
    set((state) => ({
      mutedTakeIds: state.mutedTakeIds.includes(takeId)
        ? state.mutedTakeIds.filter((id) => id !== takeId)
        : [...state.mutedTakeIds, takeId],
    }));
  },

  setMuteTakesWhileRecording: (mute) => {
    set({ muteTakesWhileRecording: mute });
    persistTakePrefs({ takePlayback: get().takePlayback, muteTakesWhileRecording: mute });
  },

  setTakeVolume: (v) => {
    set({ takeVolume: v });
    const { mutedStems, soloedStem } = get();
    getEngine().setTakeVolume(effectiveStemGain(TAKE_TRACK_KEY, v, mutedStems, soloedStem));
  },
});
