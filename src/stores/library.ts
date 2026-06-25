import { create } from "zustand";
import type { ProcessingStatus, Song } from "../lib/types";
import {
  deleteSong as apiDeleteSong,
  importYoutube as importYoutubeApi,
  listSongs,
  onProcessingProgress,
  processSong,
} from "../lib/tauri";

interface LibraryState {
  songs: Song[];
  processing: ProcessingStatus | null;
  isLoading: boolean;
  error: string | null;

  fetchSongs: () => Promise<void>;
  uploadSong: (filePath: string) => Promise<void>;
  importYoutube: (url: string) => Promise<void>;
  deleteSong: (songId: string) => Promise<void>;
  clearError: () => void;
  initProgressListener: () => Promise<() => void>;
}

function friendlyError(raw: unknown, context: "youtube" | "upload"): string {
  const msg = String(raw ?? "").toLowerCase();

  if (msg.includes("sign in to confirm") || msg.includes("not a bot") || msg.includes("bot")) {
    return "YouTube blocked the download (bot detection). Try disabling your VPN, then retry.";
  }
  if (msg.includes("vpn") || msg.includes("proxy")) {
    return "A VPN or proxy may be blocking the connection. Disable it and retry.";
  }
  if (msg.includes("private video") || msg.includes("private")) {
    return "This video is private and cannot be downloaded.";
  }
  if (msg.includes("not available in your country") || msg.includes("geo")) {
    return "This video is not available in your region.";
  }
  if (msg.includes("unavailable") || msg.includes("has been removed") || msg.includes("no longer available")) {
    return "This video is unavailable or has been removed.";
  }
  if (msg.includes("invalid url") || msg.includes("unsupported url")) {
    return "Invalid URL. Make sure you paste a valid YouTube link.";
  }
  if (
    msg.includes("network") ||
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("errno") ||
    msg.includes("socket")
  ) {
    return "Network error. Check your internet connection (and disable VPN if active), then retry.";
  }
  if (context === "youtube") {
    return "YouTube import failed. Check that the URL is public and your internet connection is working.";
  }
  return "Failed to process the audio file. Make sure it is a valid audio format.";
}

export const useLibraryStore = create<LibraryState>((set) => ({
  songs: [],
  processing: null,
  isLoading: false,
  error: null,

  fetchSongs: async () => {
    set({ isLoading: true });
    try {
      const songs = await listSongs();
      set({ songs, isLoading: false });
    } catch (e) {
      console.error("Failed to fetch songs:", e);
      set({ isLoading: false });
    }
  },

  uploadSong: async (filePath: string) => {
    set({ error: null });
    try {
      const song = await processSong(filePath);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("Failed to process song:", e);
      set({ processing: null, error: friendlyError(e, "upload") });
    }
  },

  importYoutube: async (url: string) => {
    set({ error: null });
    try {
      const song = await importYoutubeApi(url);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("YouTube import failed:", e);
      set({ processing: null, error: friendlyError(e, "youtube") });
    }
  },

  deleteSong: async (songId: string) => {
    try {
      await apiDeleteSong(songId);
      set((state) => ({
        songs: state.songs.filter((s) => s.id !== songId),
      }));
    } catch (e) {
      console.error("Failed to delete song:", e);
    }
  },

  clearError: () => set({ error: null }),

  initProgressListener: async () => {
    const unlisten = await onProcessingProgress((status) => {
      set({ processing: status.isComplete ? null : status });
    });
    return unlisten;
  },
}));
