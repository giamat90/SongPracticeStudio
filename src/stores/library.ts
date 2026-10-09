import { create } from "zustand";
import type { Folder, ProcessingStatus, Song, StemName } from "../lib/types";
import {
  createFolder as createFolderApi,
  deleteFolder as deleteFolderApi,
  deleteSong as apiDeleteSong,
  importYoutube as importYoutubeApi,
  listFolders,
  listSongs,
  moveSongs as moveSongsApi,
  onProcessingProgress,
  processSong,
  renameFolder as renameFolderApi,
  reorderFolders as reorderFoldersApi,
} from "../lib/tauri";

interface LibraryState {
  songs: Song[];
  folders: Folder[];
  processing: ProcessingStatus | null;
  isLoading: boolean;
  error: string | null;

  fetchSongs: () => Promise<void>;
  uploadSong: (filePath: string, stems?: StemName[], highQuality?: boolean) => Promise<void>;
  importYoutube: (url: string, stems?: StemName[], highQuality?: boolean, cookiesPath?: string | null) => Promise<void>;
  deleteSong: (songId: string) => Promise<void>;
  fetchFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  moveSongs: (folderId: string | null, orderedSongIds: string[]) => Promise<void>;
  clearError: () => void;
  initProgressListener: () => Promise<() => void>;
}

function friendlyError(raw: unknown, context: "youtube" | "upload", hasCookiesFile = false): string {
  const msg = String(raw ?? "").toLowerCase();

  if (msg.includes("known-good floor")) {
    return "The YouTube downloader (yt-dlp) is out of date and YouTube has changed something it can't handle. Update it: `pip install -U -r requirements.txt` in the sidecar venv (dev), or reinstall the app (installed build).";
  }
  if (msg.includes("sign in to confirm") || msg.includes("not a bot") || /\bbot\b/.test(msg)) {
    return hasCookiesFile
      ? "YouTube blocked the download even with your cookies file — it has likely expired. Re-export cookies.txt and update it in Settings → YouTube cookies file, then retry."
      : "YouTube blocked the download (bot detection). Fix: open Settings → YouTube cookies file and add one — it's the most reliable fix for this. A VPN can also trigger this; try disabling it too.";
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
    return hasCookiesFile
      ? "YouTube import failed even with your cookies file. It may have expired (re-export it in Settings), or the URL/video itself may be the problem."
      : "YouTube import failed. This is most often fixed by adding a YouTube cookies file in Settings → YouTube cookies file — see the instructions there. Otherwise, check that the URL is public and your internet connection is working.";
  }
  return "Failed to process the audio file. Make sure it is a valid audio format.";
}

export const useLibraryStore = create<LibraryState>((set) => ({
  songs: [],
  folders: [],
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

  uploadSong: async (filePath: string, stems?: StemName[], highQuality?: boolean) => {
    set({ error: null, processing: { songId: "", stage: "Preparing…", progress: 0, isComplete: false } });
    try {
      const song = await processSong(filePath, stems, highQuality);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("Failed to process song:", e);
      set({ processing: null, error: friendlyError(e, "upload") });
    }
  },

  importYoutube: async (url: string, stems?: StemName[], highQuality?: boolean, cookiesPath?: string | null) => {
    set({ error: null, processing: { songId: "", stage: "Connecting…", progress: 0, isComplete: false } });
    try {
      const song = await importYoutubeApi(url, stems, highQuality, cookiesPath);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("YouTube import failed:", e);
      set({ processing: null, error: friendlyError(e, "youtube", !!cookiesPath) });
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

  fetchFolders: async () => {
    try {
      const folders = await listFolders();
      set({ folders });
    } catch (e) {
      console.error("Failed to fetch folders:", e);
    }
  },

  createFolder: async (name: string) => {
    try {
      const folder = await createFolderApi(name);
      set((state) => ({ folders: [...state.folders, folder] }));
    } catch (e) {
      console.error("Failed to create folder:", e);
      set({ error: String(e) });
    }
  },

  renameFolder: async (folderId: string, name: string) => {
    try {
      const updated = await renameFolderApi(folderId, name);
      set((state) => ({
        folders: state.folders.map((f) => (f.id === folderId ? updated : f)),
      }));
    } catch (e) {
      console.error("Failed to rename folder:", e);
      set({ error: String(e) });
    }
  },

  deleteFolder: async (folderId: string) => {
    try {
      await deleteFolderApi(folderId);
      set((state) => ({
        folders: state.folders.filter((f) => f.id !== folderId),
        songs: state.songs.map((s) => (s.folderId === folderId ? { ...s, folderId: null } : s)),
      }));
    } catch (e) {
      console.error("Failed to delete folder:", e);
    }
  },

  reorderFolders: async (orderedIds: string[]) => {
    try {
      const folders = await reorderFoldersApi(orderedIds);
      set({ folders });
    } catch (e) {
      console.error("Failed to reorder folders:", e);
    }
  },

  moveSongs: async (folderId: string | null, orderedSongIds: string[]) => {
    try {
      const updated = await moveSongsApi(folderId, orderedSongIds);
      set((state) => ({
        songs: state.songs.map((s) => updated.find((u) => u.id === s.id) ?? s),
      }));
    } catch (e) {
      console.error("Failed to move/reorder songs:", e);
      set({ error: String(e) });
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
