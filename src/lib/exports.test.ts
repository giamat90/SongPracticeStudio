import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({ exportFile: vi.fn() }));
vi.mock("./tauri", () => api);

import { exportChordChart, safeFileName } from "./exports";

beforeEach(() => {
  api.exportFile.mockReset().mockResolvedValue(undefined);
});

describe("safeFileName", () => {
  it("replaces characters a file name cannot hold and never returns an empty name", () => {
    expect(safeFileName('AC/DC: "Back" in Black?')).toBe("AC_DC_ _Back_ in Black_");
    expect(safeFileName("   ")).toBe("Song");
  });
});

describe("exportChordChart", () => {
  it("offers the chart as UTF-8 text named after the song", async () => {
    await exportChordChart({ title: "Café", key: "C major", bpm: 90, segments: [{ start: 0, end: 4, chord: "C:maj" }], transpose: 0, capo: 0 });
    const [data, name] = api.exportFile.mock.calls[0];
    expect(name).toBe("Café - Chords.txt");
    const text = new TextDecoder().decode(new Uint8Array(data));
    expect(text.startsWith("Café\nKey: C major")).toBe(true);
    expect(text).toContain("0:00  C");
  });
});
