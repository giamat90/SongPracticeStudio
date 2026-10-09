import { describe, it, expect, vi, beforeEach } from "vitest";

const KEY = "sps_settings";

async function freshStore() {
  vi.resetModules();
  return (await import("./settings")).useSettingsStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("loading persisted settings", () => {
  it("falls back to defaults when nothing is stored", async () => {
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
  });

  it("restores valid stored values", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      youtubeCookiesPath: "/c.txt", collapsedFolders: { f1: true },
    }));
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBe("/c.txt");
    expect(s.collapsedFolders).toEqual({ f1: true });
  });

  it("ignores wrongly-typed cookies path and collapsedFolders", async () => {
    localStorage.setItem(KEY, JSON.stringify({ youtubeCookiesPath: 5, collapsedFolders: ["a"] }));
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
  });

  it("ignores a null collapsedFolders", async () => {
    localStorage.setItem(KEY, JSON.stringify({ collapsedFolders: null }));
    expect((await freshStore()).getState().collapsedFolders).toEqual({});
  });

  it("survives corrupt JSON, warning instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, "{not json");
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it("survives localStorage itself throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe("persisting changes", () => {
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

  it("writes and clears the cookies path", async () => {
    const store = await freshStore();
    store.getState().setYoutubeCookiesPath("/c.txt");
    expect(stored().youtubeCookiesPath).toBe("/c.txt");
    store.getState().setYoutubeCookiesPath(null);
    expect(stored().youtubeCookiesPath).toBeNull();
  });

  it("merges folder collapse flags instead of replacing them", async () => {
    const store = await freshStore();
    store.getState().setFolderCollapsed("a", true);
    store.getState().setFolderCollapsed("b", true);
    store.getState().setFolderCollapsed("a", false);
    expect(store.getState().collapsedFolders).toEqual({ a: false, b: true });
    expect(stored().collapsedFolders).toEqual({ a: false, b: true });
  });

  it("round-trips through a fresh module load", async () => {
    const first = await freshStore();
    first.getState().setYoutubeCookiesPath("/c.txt");
    first.getState().setFolderCollapsed("x", true);
    const second = (await freshStore()).getState();
    expect(second.youtubeCookiesPath).toBe("/c.txt");
    expect(second.collapsedFolders).toEqual({ x: true });
  });

  it("keeps the in-memory value and warns when storage rejects the write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await freshStore();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    store.getState().setYoutubeCookiesPath("/c.txt");
    expect(store.getState().youtubeCookiesPath).toBe("/c.txt");
    expect(warn).toHaveBeenCalled();
  });
});
