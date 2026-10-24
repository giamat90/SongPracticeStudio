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
    ["renameSongApi", () => api.renameSongApi("s1", "New"), "rename_song", { songId: "s1", title: "New" }],
    ["setSongIdentityApi", () => api.setSongIdentityApi("s1", "Hallelujah", null), "set_song_identity",
      { songId: "s1", officialTitle: "Hallelujah", officialArtist: null }],
    ["setSongLoopsApi", () => api.setSongLoopsApi("s1", [{ id: "l", name: "V", start: 1, end: 2 }]), "set_song_loops",
      { songId: "s1", loops: [{ id: "l", name: "V", start: 1, end: 2 }] }],
    ["cancelLyricsSync", () => api.cancelLyricsSync(), "cancel_lyrics_sync", undefined],
    ["redetectSongChords", () => api.redetectSongChords("s1"), "redetect_song_chords", { songId: "s1" }],
    ["readSongTab", () => api.readSongTab("s1"), "read_song_tab", { songId: "s1" }],
    ["importSongTab", () => api.importSongTab("s1", "/t.gp"), "import_song_tab", { songId: "s1", sourcePath: "/t.gp" }],
    ["alignSongTab", () => api.alignSongTab("s1", "{}"), "align_song_tab", { songId: "s1", scoreJson: "{}" }],
    ["saveTabBars", () => api.saveTabBars("s1", [{ index: 0, occurrence: 0, time: 1 }]), "save_tab_bars",
      { songId: "s1", bars: [{ index: 0, occurrence: 0, time: 1 }] }],
    ["saveEditedTab", () => api.saveEditedTab("s1", [1, 2]), "save_edited_tab", { songId: "s1", data: [1, 2] }],
    ["revertTabEdits", () => api.revertTabEdits("s1"), "revert_tab_edits", { songId: "s1" }],
    ["deleteSongTab", () => api.deleteSongTab("s1"), "delete_song_tab", { songId: "s1" }],
    ["exportFile", () => api.exportFile([1, 2], "a.txt"), "export_file", { data: [1, 2], suggestedName: "a.txt" }],
    ["readSongChords", () => api.readSongChords("s1"), "read_song_chords", { songId: "s1" }],
    ["readChordTuning", () => api.readChordTuning("s1"), "read_chord_tuning", { songId: "s1" }],
    ["readNoteRoll", () => api.readNoteRoll("s1"), "read_note_roll", { songId: "s1" }],
    ["saveNoteRoll", () => api.saveNoteRoll("s1", "{}"), "save_note_roll", { songId: "s1", body: "{}" }],
    ["saveChordEdits", () => api.saveChordEdits("s1", [{ start: 0, end: 2, chord: "C:maj" }]), "save_chord_edits",
      { songId: "s1", segments: [{ start: 0, end: 2, chord: "C:maj" }] }],
    ["clearChordEdits", () => api.clearChordEdits("s1"), "clear_chord_edits", { songId: "s1" }],
    ["hasChordEdits", () => api.hasChordEdits("s1"), "has_chord_edits", { songId: "s1" }],
    ["readSongMeter", () => api.readSongMeter("s1"), "read_song_meter", { songId: "s1" }],
    ["hasMeterEdits", () => api.hasMeterEdits("s1"), "has_meter_edits", { songId: "s1" }],
    ["saveMeterEdits", () => api.saveMeterEdits("s1", { version: 1 as const, bars: [{ start: 0, num: 4, den: 4 }], end: 8, source: "edited" as const }), "save_meter_edits",
      { songId: "s1", doc: { version: 1 as const, bars: [{ start: 0, num: 4, den: 4 }], end: 8, source: "edited" as const } }],
    ["clearMeterEdits", () => api.clearMeterEdits("s1"), "clear_meter_edits", { songId: "s1" }],
    ["redetectSongMeter", () => api.redetectSongMeter("s1"), "redetect_song_meter", { songId: "s1" }],
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
    ["detachPanel", () => api.detachPanel("lyrics", 2460, 584), "detach_panel", { panelId: "lyrics", x: 2460, y: 584 }],
    ["detachPanelRemembered", () => api.detachPanel("takes"), "detach_panel", { panelId: "takes", x: null, y: null }],
    ["closeDetachedPanel", () => api.closeDetachedPanel("chords"), "close_detached_panel", { panelId: "chords" }],
    ["dockPanel", () => api.dockPanel(), "dock_panel", undefined],
    ["cursorOverMain", () => api.cursorOverMain(), "cursor_over_main", undefined],
    ["closeDetachedWindows", () => api.closeDetachedWindows(), "close_detached_windows", undefined],
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
    const covered = new Set(cases.map(([name]) => name).concat("onProcessingProgress", "onTabProgress"));
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

describe("onTabProgress", () => {
  it("subscribes to the tab-progress event and unwraps the payload", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    const callback = vi.fn();

    const result = await api.onTabProgress(callback);

    expect(result).toBe(unlisten);
    expect(listen).toHaveBeenCalledWith("tab-progress", expect.any(Function));
    const handler = listen.mock.calls[listen.mock.calls.length - 1]?.[1] as (e: { payload: unknown }) => void;
    handler({ payload: { songId: "s1", progress: 0.5, stage: "alignment" } });
    expect(callback).toHaveBeenCalledWith({ songId: "s1", progress: 0.5, stage: "alignment" });
  });
});
