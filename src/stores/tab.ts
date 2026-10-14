import { create } from "zustand";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  alignSongTab, deleteSongTab, importSongTab, readSongTab, saveTabBars,
} from "../lib/tauri";
import { buildTabScore, loadAlphaTab, readScore } from "../lib/tabScore";
import type { TabBar, TabRecord } from "../lib/types";

export type TabStatus = "idle" | "loading" | "importing" | "aligning" | "error";

interface TabState {
  songId: string | null;
  record: TabRecord | null;
  status: TabStatus;
  /** 0-1 while aligning. */
  progress: number;
  stage: string;
  error: string | null;

  load: (songId: string) => Promise<void>;
  /** Store the chosen file as the song's tab and align it. */
  importTab: (songId: string, sourcePath: string) => Promise<void>;
  /** Align the stored tab again (after a better algorithm, or to drop hand corrections). */
  align: (songId: string) => Promise<void>;
  saveBars: (songId: string, bars: TabBar[]) => Promise<void>;
  remove: (songId: string) => Promise<void>;
  setProgress: (songId: string, progress: number, stage: string) => void;
  clearError: () => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The stored tab file as bytes, through the asset protocol like the stems. */
export async function fetchTabBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Could not read the tab file (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Parse the stored tab and hand the compact score to the sidecar. */
async function alignStored(record: TabRecord, songId: string) {
  const at = await loadAlphaTab();
  const score = readScore(at, await fetchTabBytes(record.path));
  const built = buildTabScore(at, score);
  if (built.bars.length === 0) throw new Error("This tab has no bars.");
  return alignSongTab(songId, JSON.stringify(built));
}

export const useTabStore = create<TabState>((set, get) => {
  /** A result only applies if the user is still on the song the job was for. */
  const current = (songId: string) => get().songId === songId;

  const fail = (songId: string, e: unknown) => {
    console.error("[tab] failed:", e);
    if (current(songId)) set({ status: "error", error: message(e), progress: 0, stage: "" });
  };

  return {
    songId: null,
    record: null,
    status: "idle",
    progress: 0,
    stage: "",
    error: null,

    load: async (songId) => {
      set({ songId, record: null, status: "loading", progress: 0, stage: "", error: null });
      try {
        const record = await readSongTab(songId);
        if (current(songId)) set({ record, status: "idle" });
      } catch (e) {
        fail(songId, e);
      }
    },

    importTab: async (songId, sourcePath) => {
      if (!current(songId)) set({ songId, record: null });
      set({ status: "importing", error: null, progress: 0, stage: "" });
      try {
        const record = await importSongTab(songId, sourcePath);
        if (!current(songId)) return;
        set({ record, status: "aligning" });
        const sync = await alignStored(record, songId);
        if (current(songId)) set({ record: { ...record, sync }, status: "idle", progress: 1, stage: "" });
      } catch (e) {
        fail(songId, e);
        if (current(songId)) {
          try {
            const record = await readSongTab(songId);
            if (current(songId)) set({ record });
          } catch (readError) {
            console.error("[tab] could not re-read the tab after a failure:", readError);
          }
        }
      }
    },

    align: async (songId) => {
      const record = get().record;
      if (!record || !current(songId)) return;
      set({ status: "aligning", error: null, progress: 0, stage: "" });
      try {
        const sync = await alignStored(record, songId);
        if (current(songId)) set({ record: { ...record, sync }, status: "idle", progress: 1, stage: "" });
      } catch (e) {
        fail(songId, e);
      }
    },

    saveBars: async (songId, bars) => {
      const record = get().record;
      if (!record || !current(songId)) return;
      try {
        const sync = await saveTabBars(songId, bars);
        if (current(songId)) set({ record: { ...record, sync }, error: null });
      } catch (e) {
        fail(songId, e);
      }
    },

    remove: async (songId) => {
      try {
        await deleteSongTab(songId);
        if (current(songId)) set({ record: null, status: "idle", error: null, progress: 0, stage: "" });
      } catch (e) {
        fail(songId, e);
      }
    },

    setProgress: (songId, progress, stage) => {
      if (current(songId) && get().status === "aligning") set({ progress, stage });
    },

    clearError: () => set({ error: null, status: get().status === "error" ? "idle" : get().status }),
  };
});
