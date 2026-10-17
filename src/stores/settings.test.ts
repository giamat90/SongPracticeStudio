import { describe, it, expect, vi, beforeEach } from "vitest";

const KEY = "sps_settings";

async function freshStore() {
  vi.resetModules();
  return (await import("./settings")).useSettingsStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("settings store of this app", () => {
  it("restores what was saved under sps_settings", async () => {
    localStorage.setItem(KEY, JSON.stringify({ youtubeCookiesPath: "/c.txt", collapsedFolders: { f1: true } }));
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBe("/c.txt");
    expect(s.collapsedFolders).toEqual({ f1: true });
  });

  it("saves under sps_settings only, in the shape older versions read", async () => {
    (await freshStore()).getState().setFolderCollapsed("a", true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ youtubeCookiesPath: null, collapsedFolders: { a: true } });
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe(KEY);
  });
});
