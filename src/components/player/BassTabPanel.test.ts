import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../stores/player", () => ({
  MAX_CAPO_FRET: 7,
  usePlayerStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ currentTime: 0, seek: () => {}, transpose: 0, capo: 0, setCapo: () => {} }),
    { getState: () => ({ currentTime: 0, transpose: 0, capo: 0 }) },
  ),
}));
vi.mock("../../stores/library", () => ({ useLibraryStore: { getState: () => ({ fetchSongs: async () => {} }) } }));
vi.mock("../../lib/tauri", () => ({
  readBassTab: vi.fn(), readSongChords: vi.fn(), exportFile: vi.fn(), redetectSongChords: vi.fn(),
}));

import BassTabPanel from "./BassTabPanel";
import ExportChartButton from "./ExportChartButton";
import CapoSelect from "./CapoSelect";
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
  it("offers only the detection for a song without chords", () => {
    const html = renderToStaticMarkup(createElement(ExportChartButton, { song: song() }));
    expect(html).toContain("Detect chords");
    expect(html).not.toContain("Export Chords");
  });

  it("offers the export and a re-detection for a song with chords", () => {
    const html = renderToStaticMarkup(createElement(ExportChartButton, { song: song({ hasChords: true }) }));
    expect(html).toContain("Export Chords");
    expect(html).toContain("Re-detect chords");
  });
});

describe("CapoSelect", () => {
  it("is absent for a song without chords", () => {
    expect(renderToStaticMarkup(createElement(CapoSelect, { song: song() }))).toBe("");
  });

  it("lists no capo and frets one to seven", () => {
    const html = renderToStaticMarkup(createElement(CapoSelect, { song: song({ hasChords: true }) }));
    expect(html).toContain("No capo");
    expect(html).toContain("Capo 7");
    expect(html).not.toContain("Capo 8");
  });
});
