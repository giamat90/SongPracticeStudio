import { create } from "zustand";
import { deleteLyrics, findLyrics, loadLyrics, onLyricsProgress, syncLyrics } from "../lib/tauri";
import type { Lyrics } from "../lib/types";

type Status = "idle" | "loading" | "finding" | "syncing";
type DraftSource = "paste" | "lrclib";

interface LyricsState {
  songId: string | null;
  lyrics: Lyrics | null;
  /** The text box: what the next sync will align */
  draft: string;
  draftSource: DraftSource;
  status: Status;
  progress: number;
  stage: string;
  error: string | null;
  notice: string | null;

  load: (songId: string) => Promise<void>;
  setDraft: (text: string) => void;
  findOnline: (songId: string) => Promise<void>;
  sync: (songId: string) => Promise<void>;
  remove: (songId: string) => Promise<void>;
  clear: () => void;
}

const EMPTY = {
  songId: null,
  lyrics: null,
  draft: "",
  draftSource: "paste" as DraftSource,
  status: "idle" as Status,
  progress: 0,
  stage: "",
  error: null,
  notice: null,
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  ...EMPTY,

  load: async (songId) => {
    set({ ...EMPTY, songId, status: "loading" });
    try {
      const lyrics = await loadLyrics(songId);
      if (get().songId !== songId) return;
      set({ lyrics, draft: lyrics?.text ?? "", status: "idle" });
    } catch (e) {
      console.warn("[lyrics] Could not load lyrics:", e);
      if (get().songId !== songId) return;
      set({ error: message(e), status: "idle" });
    }
  },

  setDraft: (text) => set({ draft: text, error: null, notice: null }),

  findOnline: async (songId) => {
    set({ status: "finding", error: null, notice: null });
    try {
      const found = await findLyrics(songId);
      if (get().songId !== songId) return;
      const what = `${found.title}${found.artist ? ` by ${found.artist}` : ""}`;
      set({
        draft: found.text,
        draftSource: "lrclib",
        status: "idle",
        notice: found.synced
          ? `Found "${what}". Review the text, then sync.`
          : `Found "${what}" as plain text. Check that every repeated chorus is written out in full, then sync.`,
      });
    } catch (e) {
      console.error("[lyrics] Lookup failed:", e);
      if (get().songId !== songId) return;
      set({ status: "idle", error: message(e) });
    }
  },

  sync: async (songId) => {
    const { draft, draftSource, status } = get();
    if (status === "syncing") return;
    if (!draft.trim()) {
      set({ error: "Paste the lyrics first." });
      return;
    }
    set({ status: "syncing", progress: 0, stage: "Starting", error: null, notice: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onLyricsProgress((p) => {
        if (p.songId === songId) set({ progress: p.progress, stage: p.stage });
      });
    } catch (e) {
      console.warn("[lyrics] Progress updates unavailable:", e);
    }

    try {
      const lyrics = await syncLyrics(songId, draft, draftSource);
      if (get().songId !== songId) return;
      set({ lyrics, status: "idle", progress: 1 });
    } catch (e) {
      console.error("[lyrics] Sync failed:", e);
      if (get().songId !== songId) return;
      set({ status: "idle", error: message(e) });
    } finally {
      unlisten?.();
    }
  },

  remove: async (songId) => {
    try {
      await deleteLyrics(songId);
      if (get().songId !== songId) return;
      set({ lyrics: null, error: null, notice: null });
    } catch (e) {
      console.error("[lyrics] Could not delete lyrics:", e);
      if (get().songId !== songId) return;
      set({ error: message(e) });
    }
  },

  clear: () => set({ ...EMPTY }),
}));
