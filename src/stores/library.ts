import { create } from "zustand";
import { isSessionExpiredError, signInYoutube } from "@giamat90/mps-core/youtube";
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
  renameSongApi,
  setSongIdentityApi,
  reorderFolders as reorderFoldersApi,
} from "../lib/tauri";
import { useSettingsStore } from "./settings";

interface LibraryState {
  songs: Song[];
  folders: Folder[];
  processing: ProcessingStatus | null;
  isLoading: boolean;
  error: string | null;
  /** The last YouTube import was turned down in a way a fresh sign-in can fix. */
  sessionExpired: boolean;
  retryableYoutubeImport: { url: string; stems?: StemName[]; highQuality?: boolean } | null;

  fetchSongs: () => Promise<void>;
  uploadSong: (filePath: string, stems?: StemName[], highQuality?: boolean) => Promise<void>;
  importYoutube: (
    url: string,
    stems?: StemName[],
    highQuality?: boolean,
    cookiesPath?: string | null,
    options?: { freshSession?: boolean },
  ) => Promise<void>;
  signInAndRetryYoutube: () => Promise<void>;
  deleteSong: (songId: string) => Promise<void>;
  renameSong: (songId: string, title: string) => Promise<void>;
  /** Returns the saved song, or null when the backend refused (the reason is in `error`) */
  setSongIdentity: (songId: string, officialTitle: string, officialArtist: string) => Promise<Song | null>;
  fetchFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  moveSongs: (folderId: string | null, orderedSongIds: string[]) => Promise<void>;
  clearError: () => void;
  initProgressListener: () => Promise<() => void>;
}

function friendlyError(
  raw: unknown,
  context: "youtube" | "upload",
  hasCookiesFile = false,
  freshSession = false,
): string {
  const msg = String(raw ?? "").toLowerCase();

  if (msg.includes("known-good floor")) {
    return "The YouTube downloader (yt-dlp) is out of date and YouTube has changed something it can't handle. Update it: `pip install -U -r requirements.txt` in the sidecar venv (dev), or reinstall the app (installed build).";
  }
  if (msg.includes("page needs to be reloaded") || msg.includes("signature solving failed")) {
    return "YouTube could not be read: its challenge needs the JavaScript runtime (Deno) bundled with the app, which did not run. Retry once; if it keeps failing, reinstall the app (a build without the bundled Deno is broken).";
  }
  if (freshSession && isSessionExpiredError(raw)) {
    return "YouTube turned the download down right after signing in, so your session is not the problem: this network or VPN is probably flagged. Try again without the VPN or proxy, or from another connection.";
  }
  if (msg.includes("sign in to confirm") || msg.includes("not a bot") || /\bbot\b/.test(msg)) {
    return hasCookiesFile
      ? "YouTube blocked the download even with your saved YouTube session (sign-in or cookies file) — it has likely expired. Sign in again in Settings → YouTube, then retry."
      : "YouTube blocked the download (bot detection). Fix: open Settings → YouTube and sign in — it's the most reliable fix for this. A VPN can also trigger this; try disabling it too.";
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
      ? "YouTube import failed even with your saved YouTube session. It may have expired (sign in again in Settings → YouTube), or the URL/video itself may be the problem."
      : "YouTube import failed. This is most often fixed by signing in to YouTube in Settings → YouTube. Otherwise, check that the URL is public and your internet connection is working.";
  }
  return "Failed to process the audio file. Make sure it is a valid audio format.";
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  songs: [],
  folders: [],
  processing: null,
  isLoading: false,
  error: null,
  sessionExpired: false,
  retryableYoutubeImport: null,

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

  importYoutube: async (
    url: string,
    stems?: StemName[],
    highQuality?: boolean,
    cookiesPath?: string | null,
    options?: { freshSession?: boolean },
  ) => {
    const fresh = !!options?.freshSession;
    set({
      error: null,
      sessionExpired: false,
      retryableYoutubeImport: null,
      processing: { songId: "", stage: "Connecting…", progress: 0, isComplete: false },
    });
    try {
      const song = await importYoutubeApi(url, stems, highQuality, cookiesPath);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("YouTube import failed:", e);
      const expired = !!cookiesPath && !fresh && isSessionExpiredError(e);
      set({
        processing: null,
        error: friendlyError(e, "youtube", !!cookiesPath, fresh),
        sessionExpired: expired,
        retryableYoutubeImport: expired ? { url, stems, highQuality } : null,
      });
    }
  },

  signInAndRetryYoutube: async () => {
    const request = get().retryableYoutubeImport;
    if (!request) return;
    set({ error: null, sessionExpired: false });
    let cookiesPath: string;
    try {
      cookiesPath = await signInYoutube();
    } catch (e) {
      console.warn("[youtube] sign-in before retry failed:", e);
      set({ error: String(e), sessionExpired: true });
      return;
    }
    useSettingsStore.getState().setYoutubeCookiesPath(cookiesPath);
    await get().importYoutube(request.url, request.stems, request.highQuality, cookiesPath, { freshSession: true });
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

  renameSong: async (songId: string, title: string) => {
    try {
      const updated = await renameSongApi(songId, title);
      set((state) => ({
        songs: state.songs.map((s) => (s.id === songId ? updated : s)),
      }));
    } catch (e) {
      console.error("Failed to rename song:", e);
      set({ error: String(e) });
    }
  },

  setSongIdentity: async (songId: string, officialTitle: string, officialArtist: string) => {
    try {
      const updated = await setSongIdentityApi(songId, officialTitle.trim() || null, officialArtist.trim() || null);
      set((state) => ({
        songs: state.songs.map((s) => (s.id === songId ? updated : s)),
      }));
      return updated;
    } catch (e) {
      console.error("Failed to set song identity:", e);
      set({ error: String(e) });
      return null;
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

  clearError: () => set({ error: null, sessionExpired: false, retryableYoutubeImport: null }),

  initProgressListener: async () => {
    const unlisten = await onProcessingProgress((status) => {
      set({ processing: status.isComplete ? null : status });
    });
    return unlisten;
  },
}));
