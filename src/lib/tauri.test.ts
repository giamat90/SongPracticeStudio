import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));

import * as api from "./tauri";
import type { ProcessingStatus } from "./types";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("tauri.ts wrappers send the exact command name and payload the Rust side expects", () => {
  const cases: [string, () => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
    ["processSong", () => api.processSong("/a.mp3", ["vocals", "bass"], true), "process_song",
      { filePath: "/a.mp3", stemsToExtract: ["vocals", "bass"], highQuality: true }],
    ["listSongs", () => api.listSongs(), "list_songs", undefined],
    ["deleteSong", () => api.deleteSong("s1"), "delete_song", { songId: "s1" }],
    ["importYoutube", () => api.importYoutube("u", ["drums"], false, "/c.txt"), "import_youtube",
      { url: "u", stemsToExtract: ["drums"], highQuality: false, cookiesPath: "/c.txt" }],
    ["readSongChords", () => api.readSongChords("s1"), "read_song_chords", { songId: "s1" }],
    ["listFolders", () => api.listFolders(), "list_folders", undefined],
    ["createFolder", () => api.createFolder("Band"), "create_folder", { name: "Band" }],
    ["renameFolder", () => api.renameFolder("f1", "B"), "rename_folder", { folderId: "f1", name: "B" }],
    ["deleteFolder", () => api.deleteFolder("f1"), "delete_folder", { folderId: "f1" }],
    ["reorderFolders", () => api.reorderFolders(["b", "a"]), "reorder_folders", { orderedIds: ["b", "a"] }],
    ["moveSongs", () => api.moveSongs(null, ["a", "b"]), "move_songs", { folderId: null, orderedSongIds: ["a", "b"] }],
    ["exportStem", () => api.exportStem("/s.wav", "vocals.wav"), "export_stem", { stemPath: "/s.wav", suggestedName: "vocals.wav" }],
    ["exportAll", () => api.exportAll([{ path: "/a", archiveName: "a" }], "all.zip"), "export_all",
      { entries: [{ path: "/a", archiveName: "a" }], suggestedName: "all.zip" }],
    ["saveTake", () => api.saveTake("s1", [1, 2], 3, 0.5), "save_take",
      { songId: "s1", audioData: [1, 2], startPosition: 3, audioOffset: 0.5 }],
    ["listTakes", () => api.listTakes("s1"), "list_takes", { songId: "s1" }],
    ["deleteTakeApi", () => api.deleteTakeApi("s1", "t1"), "delete_take", { songId: "s1", takeId: "t1" }],
    ["renameTakeApi", () => api.renameTakeApi("s1", "t1", "x"), "rename_take", { songId: "s1", takeId: "t1", name: "x" }],
    ["setMetronomeOffsetApi", () => api.setMetronomeOffsetApi("s1", null), "set_metronome_offset", { songId: "s1", offset: null }],
    ["setTakeManualOffsetApi", () => api.setTakeManualOffsetApi("s1", "t1", -0.25), "set_take_manual_offset",
      { songId: "s1", takeId: "t1", offset: -0.25 }],
    ["exportTake", () => api.exportTake("/t.wav", "take.wav"), "export_take", { takePath: "/t.wav", suggestedName: "take.wav" }],
    ["exportMix", () => api.exportMix([{ path: "/p", gain: 1, isTake: false }], 1, 9, "mix.wav"), "export_mix",
      { sources: [{ path: "/p", gain: 1, isTake: false }], startSec: 1, endSec: 9, suggestedName: "mix.wav" }],
    ["pitchShiftSong", () => api.pitchShiftSong("/dir", ["vocals", "bass"], -2), "pitch_shift_song",
      { songDir: "/dir", stemNames: ["vocals", "bass"], nSteps: -2 }],
  ];

  it.each(cases)("%s", async (_name, call, command, payload) => {
    await call();
    expect(invoke).toHaveBeenCalledTimes(1);
    if (payload === undefined) expect(invoke).toHaveBeenCalledWith(command);
    else expect(invoke).toHaveBeenCalledWith(command, payload);
  });

  it("covers every exported command wrapper", () => {
    const wrappers = Object.entries(api).filter(([, v]) => typeof v === "function").map(([k]) => k);
    const covered = new Set(cases.map(([name]) => name).concat("onProcessingProgress"));
    expect(wrappers.filter((w) => !covered.has(w))).toEqual([]);
  });

  it("defaults saveTake's audioOffset to 0", async () => {
    await api.saveTake("s", [1], 2);
    expect(invoke).toHaveBeenCalledWith("save_take", { songId: "s", audioData: [1], startPosition: 2, audioOffset: 0 });
  });

  it("returns what invoke resolves", async () => {
    invoke.mockResolvedValueOnce([{ id: "x" }]);
    await expect(api.listSongs()).resolves.toEqual([{ id: "x" }]);
  });

  it("propagates backend rejections unchanged", async () => {
    invoke.mockRejectedValueOnce("Song not found: nope");
    await expect(api.deleteSong("nope")).rejects.toBe("Song not found: nope");
  });
});

describe("onProcessingProgress", () => {
  it("subscribes to the processing-progress event and unwraps the payload", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    const callback = vi.fn();

    const result = await api.onProcessingProgress(callback);

    expect(result).toBe(unlisten);
    expect(listen).toHaveBeenCalledWith("processing-progress", expect.any(Function));
    const status: ProcessingStatus = { songId: "s", progress: 0.5, stage: "separating", isComplete: false };
    listen.mock.calls[0][1]({ payload: status });
    expect(callback).toHaveBeenCalledWith(status);
  });
});
