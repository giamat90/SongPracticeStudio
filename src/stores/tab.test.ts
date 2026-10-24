import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabRecord, TabSync } from "../lib/types";

const readSongTab = vi.fn();
const importSongTab = vi.fn();
const alignSongTab = vi.fn();
const saveTabBars = vi.fn();
const saveEditedTab = vi.fn();
const revertTabEdits = vi.fn();
const deleteSongTab = vi.fn();
const buildTabScore = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("../lib/tauri", () => ({
  readSongTab: (...a: unknown[]) => readSongTab(...a),
  importSongTab: (...a: unknown[]) => importSongTab(...a),
  alignSongTab: (...a: unknown[]) => alignSongTab(...a),
  saveTabBars: (...a: unknown[]) => saveTabBars(...a),
  saveEditedTab: (...a: unknown[]) => saveEditedTab(...a),
  revertTabEdits: (...a: unknown[]) => revertTabEdits(...a),
  deleteSongTab: (...a: unknown[]) => deleteSongTab(...a),
}));
vi.mock("../lib/tabScore", () => ({
  loadAlphaTab: async () => ({}),
  readScore: () => ({}),
  buildTabScore: (...a: unknown[]) => buildTabScore(...a),
}));

import { useTabStore } from "./tab";

const sync = (quality = "good"): TabSync => ({
  version: 1, algorithm: "x", alignedAt: "t", offset: 0, transpose: 0, usedDrums: true, peak: 0.7,
  meanCost: 0.3, steadiness: 1, quality, edited: false,
  bars: [{ index: 0, occurrence: 0, time: 1 }, { index: 1, occurrence: 0, time: 3 }],
});
const record = (s: TabSync | null = null): TabRecord => ({ fileName: "tab.gp", originalName: "a.gp", path: "/t/tab.gp", hasOriginal: false, sync: s });

function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  for (const f of [readSongTab, importSongTab, alignSongTab, saveTabBars, saveEditedTab, revertTabEdits, deleteSongTab, buildTabScore]) f.mockReset();
  useTabStore.setState({ songId: null, record: null, status: "idle", progress: 0, stage: "", error: null, reloadKey: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })));
  buildTabScore.mockReturnValue({ version: 1, bars: [{ tick: 0 }], notes: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("load", () => {
  it("shows a song's stored tab", async () => {
    readSongTab.mockResolvedValue(record(sync()));
    await useTabStore.getState().load("s1");
    const s = useTabStore.getState();
    expect(s.songId).toBe("s1");
    expect(s.record?.sync?.quality).toBe("good");
    expect(s.status).toBe("idle");
  });

  it("clears the previous song's tab while loading the next", async () => {
    readSongTab.mockResolvedValueOnce(record(sync()));
    await useTabStore.getState().load("s1");
    const pending = defer<TabRecord | null>();
    readSongTab.mockReturnValueOnce(pending.promise);
    const loading = useTabStore.getState().load("s2");
    expect(useTabStore.getState().record).toBeNull();
    pending.resolve(null);
    await loading;
    expect(useTabStore.getState().record).toBeNull();
  });

  it("ignores a result that arrives after the user moved to another song", async () => {
    const slow = defer<TabRecord | null>();
    readSongTab.mockReturnValueOnce(slow.promise);
    const first = useTabStore.getState().load("s1");
    readSongTab.mockResolvedValueOnce(null);
    await useTabStore.getState().load("s2");
    slow.resolve(record(sync()));
    await first;
    expect(useTabStore.getState().songId).toBe("s2");
    expect(useTabStore.getState().record).toBeNull();
  });

  it("reports a failure instead of swallowing it", async () => {
    readSongTab.mockRejectedValue(new Error("Parse tab sync: bad"));
    await useTabStore.getState().load("s1");
    expect(useTabStore.getState()).toMatchObject({ status: "error", error: "Parse tab sync: bad" });
  });
});

describe("importTab", () => {
  it("stores the file, builds the score from it and aligns", async () => {
    useTabStore.setState({ songId: "s1" });
    importSongTab.mockResolvedValue(record());
    alignSongTab.mockResolvedValue(sync("check"));
    await useTabStore.getState().importTab("s1", "/x/a.gp");
    expect(importSongTab).toHaveBeenCalledWith("s1", "/x/a.gp");
    expect(JSON.parse(alignSongTab.mock.calls[0][1])).toMatchObject({ version: 1 });
    expect(useTabStore.getState().record?.sync?.quality).toBe("check");
    expect(useTabStore.getState().status).toBe("idle");
  });

  it("keeps the imported tab and shows the reason when alignment fails", async () => {
    useTabStore.setState({ songId: "s1" });
    importSongTab.mockResolvedValue(record());
    alignSongTab.mockRejectedValue("The tab and the recording do not overlap");
    readSongTab.mockResolvedValue(record());
    await useTabStore.getState().importTab("s1", "/x/a.gp");
    const s = useTabStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("The tab and the recording do not overlap");
    expect(s.record?.fileName).toBe("tab.gp");
  });

  it("reports an unreadable stored file", async () => {
    useTabStore.setState({ songId: "s1" });
    importSongTab.mockResolvedValue(record());
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    readSongTab.mockResolvedValue(record());
    await useTabStore.getState().importTab("s1", "/x/a.gp");
    expect(useTabStore.getState().error).toMatch(/Could not read the tab file \(404\)/);
    expect(alignSongTab).not.toHaveBeenCalled();
  });

  it("refuses a tab with no bars before starting the sidecar", async () => {
    useTabStore.setState({ songId: "s1" });
    importSongTab.mockResolvedValue(record());
    buildTabScore.mockReturnValue({ version: 1, bars: [], notes: [] });
    readSongTab.mockResolvedValue(record());
    await useTabStore.getState().importTab("s1", "/x/a.gp");
    expect(useTabStore.getState().error).toBe("This tab has no bars.");
    expect(alignSongTab).not.toHaveBeenCalled();
  });

  it("drops the alignment when the user left the song meanwhile", async () => {
    useTabStore.setState({ songId: "s1" });
    importSongTab.mockResolvedValue(record());
    const slow = defer<TabSync>();
    alignSongTab.mockReturnValue(slow.promise);
    const running = useTabStore.getState().importTab("s1", "/x/a.gp");
    await vi.waitFor(() => expect(alignSongTab).toHaveBeenCalled());
    readSongTab.mockResolvedValue(null);
    await useTabStore.getState().load("s2");
    slow.resolve(sync());
    await running;
    expect(useTabStore.getState().songId).toBe("s2");
    expect(useTabStore.getState().record).toBeNull();
  });
});

describe("align", () => {
  it("aligns the stored tab again and replaces hand corrections", async () => {
    useTabStore.setState({ songId: "s1", record: record({ ...sync(), edited: true }) });
    alignSongTab.mockResolvedValue(sync());
    await useTabStore.getState().align("s1");
    expect(useTabStore.getState().record?.sync?.edited).toBe(false);
  });

  it("does nothing without a stored tab", async () => {
    useTabStore.setState({ songId: "s1", record: null });
    await useTabStore.getState().align("s1");
    expect(alignSongTab).not.toHaveBeenCalled();
  });
});

describe("saveBars / remove / progress", () => {
  it("stores corrected bar lines", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    saveTabBars.mockResolvedValue({ ...sync(), edited: true });
    await useTabStore.getState().saveBars("s1", sync().bars);
    expect(useTabStore.getState().record?.sync?.edited).toBe(true);
  });

  it("shows why a correction was refused and keeps the old bars", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    saveTabBars.mockRejectedValue("Bar lines cannot run backwards.");
    await useTabStore.getState().saveBars("s1", sync().bars);
    expect(useTabStore.getState().error).toBe("Bar lines cannot run backwards.");
    expect(useTabStore.getState().record?.sync?.edited).toBe(false);
  });

  it("stores the edited tab and shows the record it returns", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    saveEditedTab.mockResolvedValue({ ...record(sync()), hasOriginal: true });
    await useTabStore.getState().saveEdited("s1", new Uint8Array([1, 2, 3]));
    expect(saveEditedTab).toHaveBeenCalledWith("s1", [1, 2, 3]);
    const s = useTabStore.getState();
    expect(s.record?.hasOriginal).toBe(true);
    expect(s.record?.sync?.quality).toBe("good");
    expect(s.reloadKey).toBe(0);
  });

  it("saves edits one after another so the last one is what stays", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    const first = defer<TabRecord>();
    saveEditedTab.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...record(sync()), hasOriginal: true });
    const a = useTabStore.getState().saveEdited("s1", new Uint8Array([1]));
    const b = useTabStore.getState().saveEdited("s1", new Uint8Array([2]));
    await Promise.resolve();
    expect(saveEditedTab).toHaveBeenCalledTimes(1);
    first.resolve(record(sync()));
    await Promise.all([a, b]);
    expect(saveEditedTab.mock.calls.map((c) => c[1])).toEqual([[1], [2]]);
    expect(useTabStore.getState().record?.hasOriginal).toBe(true);
  });

  it("shows why an edit could not be saved and keeps working afterwards", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    saveEditedTab.mockRejectedValueOnce("The edited tab is empty.").mockResolvedValueOnce(record(sync()));
    await useTabStore.getState().saveEdited("s1", new Uint8Array([1]));
    expect(useTabStore.getState()).toMatchObject({ status: "error", error: "The edited tab is empty." });
    await useTabStore.getState().saveEdited("s1", new Uint8Array([2]));
    expect(useTabStore.getState().error).toBeNull();
  });

  it("reverts the edits and tells the panel to read the file again", async () => {
    useTabStore.setState({ songId: "s1", record: { ...record(sync()), hasOriginal: true } });
    revertTabEdits.mockResolvedValue(record(sync()));
    await useTabStore.getState().revertEdits("s1");
    const s = useTabStore.getState();
    expect(s.record?.hasOriginal).toBe(false);
    expect(s.reloadKey).toBe(1);
  });

  it("removes the tab", async () => {
    useTabStore.setState({ songId: "s1", record: record(sync()) });
    deleteSongTab.mockResolvedValue(undefined);
    await useTabStore.getState().remove("s1");
    expect(deleteSongTab).toHaveBeenCalledWith("s1");
    expect(useTabStore.getState().record).toBeNull();
  });

  it("takes progress only for the current song while aligning", () => {
    useTabStore.setState({ songId: "s1", status: "aligning" });
    useTabStore.getState().setProgress("other", 0.9, "x");
    expect(useTabStore.getState().progress).toBe(0);
    useTabStore.getState().setProgress("s1", 0.5, "alignment");
    expect(useTabStore.getState()).toMatchObject({ progress: 0.5, stage: "alignment" });
  });

  it("clearError returns an errored panel to idle", () => {
    useTabStore.setState({ status: "error", error: "x" });
    useTabStore.getState().clearError();
    expect(useTabStore.getState()).toMatchObject({ status: "idle", error: null });
  });
});
