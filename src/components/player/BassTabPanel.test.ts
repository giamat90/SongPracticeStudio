import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel({ currentTime: 0, seek: () => {}, transpose: 0 }), {
    getState: () => ({ currentTime: 0, transpose: 0 }),
  }),
}));
vi.mock("../../lib/tauri", () => ({ readBassTab: vi.fn(), readSongChords: vi.fn(), exportFile: vi.fn() }));

import BassTabPanel from "./BassTabPanel";
import ExportChartButton from "./ExportChartButton";
import type { Song } from "../../lib/types";

const song = (extra: Partial<Song> = {}): Song => ({
  id: "s", title: "Song", duration: 100, processedAt: "", directory: "/s", stems: ["vocals", "bass"], sortIndex: 0, ...extra,
});

describe("BassTabPanel", () => {
  it("shows nothing until a transcription has been read", () => {
    expect(renderToStaticMarkup(createElement(BassTabPanel, { song: song() }))).toBe("");
  });

  it("shows nothing for a song without a bass stem", () => {
    expect(renderToStaticMarkup(createElement(BassTabPanel, { song: song({ stems: ["vocals"] }) }))).toBe("");
  });
});

describe("ExportChartButton", () => {
  it("is absent for a song without detected chords", () => {
    expect(renderToStaticMarkup(createElement(ExportChartButton, { song: song() }))).toBe("");
  });

  it("offers the export and a capo choice for a song with chords", () => {
    const html = renderToStaticMarkup(createElement(ExportChartButton, { song: song({ hasChords: true }) }));
    expect(html).toContain("Export Chords");
    expect(html).toContain("No capo");
    expect(html).toContain("Capo 7");
  });
});
