import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Folder, ProcessingStatus, Song } from "../lib/types";

const api = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  deleteSong: vi.fn(),
  importYoutube: vi.fn(),
  listFolders: vi.fn(),
  listSongs: vi.fn(),
  moveSongs: vi.fn(),
  onProcessingProgress: vi.fn(),
  processSong: vi.fn(),
  renameFolder: vi.fn(),
  reorderFolders: vi.fn(),
}));

vi.mock("../lib/tauri", () => api);

import { useLibraryStore } from "./library";

const song = (id: string, extra: Partial<Song> = {}): Song => ({
  id, title: id, duration: 100, processedAt: "2026-01-01T00:00:00Z", directory: `/lib/${id}`, stems: ["vocals"], sortIndex: 0, ...extra,
});
const folder = (id: string, sortIndex = 0): Folder => ({ id, name: id, sortIndex });

const initial = useLibraryStore.getState();
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  useLibraryStore.setState({ ...initial, songs: [], folders: [], processing: null, isLoading: false, error: null });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe("fetchSongs", () => {
  it("loads songs and clears the loading flag", async () => {
    api.listSongs.mockResolvedValue([song("a"), song("b")]);
    const pending = useLibraryStore.getState().fetchSongs();
    expect(useLibraryStore.getState().isLoading).toBe(true);
    await pending;
    expect(useLibraryStore.getState().songs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(useLibraryStore.getState().isLoading).toBe(false);
  });

  it("logs the failure, keeps existing songs and clears the loading flag", async () => {
    useLibraryStore.setState({ songs: [song("keep")] });
    api.listSongs.mockRejectedValue(new Error("disk"));
    await useLibraryStore.getState().fetchSongs();
    expect(errorSpy).toHaveBeenCalled();
    expect(useLibraryStore.getState().songs.map((s) => s.id)).toEqual(["keep"]);
    expect(useLibraryStore.getState().isLoading).toBe(false);
  });
});

describe("uploadSong", () => {
  it("shows a preparing status, then appends the song and clears processing", async () => {
    let resolve!: (s: Song) => void;
    api.processSong.mockReturnValue(new Promise<Song>((r) => { resolve = r; }));
    const pending = useLibraryStore.getState().uploadSong("/x.mp3", ["vocals", "bass"], true);
    expect(useLibraryStore.getState().processing).toEqual({ songId: "", stage: "Preparing…", progress: 0, isComplete: false });
    resolve(song("new"));
    await pending;
    expect(useLibraryStore.getState().songs.map((s) => s.id)).toEqual(["new"]);
    expect(useLibraryStore.getState().processing).toBeNull();
    expect(api.processSong).toHaveBeenCalledWith("/x.mp3", ["vocals", "bass"], true);
  });

  it("clears a previous error when starting", async () => {
    useLibraryStore.setState({ error: "old" });
    api.processSong.mockResolvedValue(song("n"));
    await useLibraryStore.getState().uploadSong("/x.mp3");
    expect(useLibraryStore.getState().error).toBeNull();
  });

  it("surfaces a friendly error, logs, and leaves songs untouched on failure", async () => {
    useLibraryStore.setState({ songs: [song("a")] });
    api.processSong.mockRejectedValue("decoder exploded");
    await useLibraryStore.getState().uploadSong("/x.mp3");
    const s = useLibraryStore.getState();
    expect(s.error).toBe("Failed to process the audio file. Make sure it is a valid audio format.");
    expect(s.processing).toBeNull();
    expect(s.songs.map((x) => x.id)).toEqual(["a"]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("importYoutube error mapping", () => {
  const fail = async (message: string, cookiesPath?: string | null) => {
    api.importYoutube.mockRejectedValue(message);
    await useLibraryStore.getState().importYoutube("https://youtu.be/x", undefined, false, cookiesPath);
    return useLibraryStore.getState().error ?? "";
  };

  it("passes every argument through and appends the song on success", async () => {
    api.importYoutube.mockResolvedValue(song("yt"));
    await useLibraryStore.getState().importYoutube("u", ["drums"], true, "/c.txt");
    expect(api.importYoutube).toHaveBeenCalledWith("u", ["drums"], true, "/c.txt");
    expect(useLibraryStore.getState().songs.map((s) => s.id)).toEqual(["yt"]);
    expect(useLibraryStore.getState().processing).toBeNull();
  });

  it("starts with a Connecting status", () => {
    api.importYoutube.mockReturnValue(new Promise(() => {}));
    void useLibraryStore.getState().importYoutube("u");
    expect(useLibraryStore.getState().processing?.stage).toBe("Connecting…");
  });

  it("explains an outdated yt-dlp (known-good floor)", async () => {
    expect(await fail("yt-dlp 2025 is older than the known-good floor 2026")).toMatch(/out of date/);
  });

  it.each([
    "ERROR: Sign in to confirm you're not a bot",
    "HTTP Error 403: bot check",
  ])("blames bot detection and points at the cookies setting: %s", async (msg) => {
    expect(await fail(msg)).toMatch(/Settings → YouTube cookies file and add one/);
  });

  it("tells the user their cookies file expired when one was already configured", async () => {
    expect(await fail("Sign in to confirm you're not a bot", "/c.txt")).toMatch(/even with your cookies file/);
  });

  it.each([
    ["VPN is blocking", /VPN or proxy/],
    ["Proxy error 407", /VPN or proxy/],
    ["Private video", /private/],
    ["This video is not available in your country", /region/],
    ["Video unavailable", /unavailable or has been removed/],
    ["This video has been removed by the uploader", /unavailable or has been removed/],
    ["Unsupported URL: foo", /Invalid URL/],
    ["Connection reset (Errno 104)", /Network error/],
    ["socket timeout", /Network error/],
  ])("maps %j to a readable message", async (msg, expected) => {
    expect(await fail(msg)).toMatch(expected);
  });

  it("falls back to a generic YouTube message (cookies hint without a file, expiry hint with one)", async () => {
    expect(await fail("something odd")).toMatch(/adding a YouTube cookies file/);
    expect(await fail("something odd", "/c.txt")).toMatch(/even with your cookies file/);
  });

  it("does not mistake an ordinary word containing 'bot' (e.g. 'both') for bot detection", async () => {
    expect(await fail("Could not merge both audio streams")).not.toMatch(/bot detection/);
  });

  it("matches case-insensitively", async () => {
    expect(await fail("PRIVATE VIDEO")).toMatch(/private/);
  });

  it("handles non-string rejections without throwing", async () => {
    api.importYoutube.mockRejectedValue(undefined);
    await useLibraryStore.getState().importYoutube("u");
    expect(useLibraryStore.getState().error).toMatch(/YouTube import failed/);
  });
});

describe("deleteSong", () => {
  beforeEach(() => useLibraryStore.setState({ songs: [song("a"), song("b")] }));

  it("removes the song after the backend confirms", async () => {
    api.deleteSong.mockResolvedValue(undefined);
    await useLibraryStore.getState().deleteSong("a");
    expect(useLibraryStore.getState().songs.map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps the song and logs when the backend refuses", async () => {
    api.deleteSong.mockRejectedValue("locked");
    await useLibraryStore.getState().deleteSong("a");
    expect(useLibraryStore.getState().songs).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("folders", () => {
  it("fetchFolders replaces the list and tolerates failure", async () => {
    api.listFolders.mockResolvedValueOnce([folder("f1")]);
    await useLibraryStore.getState().fetchFolders();
    expect(useLibraryStore.getState().folders.map((f) => f.id)).toEqual(["f1"]);
    api.listFolders.mockRejectedValueOnce("x");
    await useLibraryStore.getState().fetchFolders();
    expect(useLibraryStore.getState().folders).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("createFolder appends; failure sets error", async () => {
    api.createFolder.mockResolvedValueOnce(folder("n"));
    await useLibraryStore.getState().createFolder("n");
    expect(useLibraryStore.getState().folders.map((f) => f.id)).toEqual(["n"]);
    api.createFolder.mockRejectedValueOnce("Folder name cannot be empty");
    await useLibraryStore.getState().createFolder("");
    expect(useLibraryStore.getState().error).toBe("Folder name cannot be empty");
    expect(useLibraryStore.getState().folders).toHaveLength(1);
  });

  it("renameFolder swaps in the updated folder", async () => {
    useLibraryStore.setState({ folders: [folder("a"), folder("b")] });
    api.renameFolder.mockResolvedValue({ ...folder("b"), name: "Bee" });
    await useLibraryStore.getState().renameFolder("b", "Bee");
    expect(useLibraryStore.getState().folders.map((f) => f.name)).toEqual(["a", "Bee"]);
  });

  it("deleteFolder drops the folder and moves its songs to the root without deleting them", async () => {
    useLibraryStore.setState({
      folders: [folder("f1"), folder("f2")],
      songs: [song("a", { folderId: "f1" }), song("b", { folderId: "f2" }), song("c")],
    });
    api.deleteFolder.mockResolvedValue(undefined);
    await useLibraryStore.getState().deleteFolder("f1");
    const s = useLibraryStore.getState();
    expect(s.folders.map((f) => f.id)).toEqual(["f2"]);
    expect(s.songs.map((x) => [x.id, x.folderId ?? null])).toEqual([["a", null], ["b", "f2"], ["c", null]]);
  });

  it("deleteFolder leaves state alone when the backend fails", async () => {
    useLibraryStore.setState({ folders: [folder("f1")], songs: [song("a", { folderId: "f1" })] });
    api.deleteFolder.mockRejectedValue("nope");
    await useLibraryStore.getState().deleteFolder("f1");
    expect(useLibraryStore.getState().folders).toHaveLength(1);
    expect(useLibraryStore.getState().songs[0].folderId).toBe("f1");
  });

  it("reorderFolders adopts the order the backend returns", async () => {
    api.reorderFolders.mockResolvedValue([folder("b", 0), folder("a", 1)]);
    await useLibraryStore.getState().reorderFolders(["b", "a"]);
    expect(useLibraryStore.getState().folders.map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("moveSongs", () => {
  it("patches only the songs the backend returned, in place", async () => {
    useLibraryStore.setState({ songs: [song("a"), song("b"), song("c")] });
    api.moveSongs.mockResolvedValue([song("c", { folderId: "f1", sortIndex: 0 }), song("a", { folderId: "f1", sortIndex: 1 })]);
    await useLibraryStore.getState().moveSongs("f1", ["c", "a"]);
    const songs = useLibraryStore.getState().songs;
    expect(songs.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(songs.map((s) => s.folderId ?? null)).toEqual(["f1", null, "f1"]);
    expect(songs.map((s) => s.sortIndex)).toEqual([1, 0, 0]);
  });

  it("reports failure through the error field", async () => {
    api.moveSongs.mockRejectedValue("io");
    await useLibraryStore.getState().moveSongs(null, ["a"]);
    expect(useLibraryStore.getState().error).toBe("io");
  });
});

describe("progress listener", () => {
  it("shows in-flight status and clears it on completion", async () => {
    const unlisten = vi.fn();
    api.onProcessingProgress.mockResolvedValue(unlisten);
    const returned = await useLibraryStore.getState().initProgressListener();
    expect(returned).toBe(unlisten);

    const cb = api.onProcessingProgress.mock.calls[0][0] as (s: ProcessingStatus) => void;
    const running: ProcessingStatus = { songId: "s", progress: 0.4, stage: "separating", isComplete: false };
    cb(running);
    expect(useLibraryStore.getState().processing).toEqual(running);
    cb({ ...running, progress: 1, isComplete: true });
    expect(useLibraryStore.getState().processing).toBeNull();
  });
});

describe("clearError", () => {
  it("resets the error", () => {
    useLibraryStore.setState({ error: "boom" });
    useLibraryStore.getState().clearError();
    expect(useLibraryStore.getState().error).toBeNull();
  });
});
