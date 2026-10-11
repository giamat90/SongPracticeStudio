import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  const stub = (name: string) => async () => {
    const { createElement: el } = await import("react");
    return { default: () => el("div", { "data-c": name }) };
  };
  return {
    stub,
    library: { songs: [] as unknown[] },
    player: { cleanup: () => {} },
    detached: {} as Record<string, boolean>,
  };
});

vi.mock("../stores/library", () => ({ useLibraryStore: (sel: (s: unknown) => unknown) => sel(h.library) }));
vi.mock("../stores/player", () => ({ usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.player) }));

vi.mock("../stores/detached", () => ({
  useDetachedStore: (sel: (s: unknown) => unknown) => sel({ detached: h.detached }),
}));
vi.mock("../windows/useMainBridge", () => ({ useMainBridge: () => {} }));
vi.mock("../components/panels/DetachHandle", async () => {
  const { createElement: el } = await import("react");
  return { default: ({ panel }: { panel: string }) => el("i", { "data-c": "handle", "data-panel": panel }) };
});

vi.mock("../components/player/StemView", h.stub("stems"));
vi.mock("../components/player/DownloadAllButton", h.stub("downloadAll"));
vi.mock("../components/player/ExportMixButton", h.stub("exportMix"));
vi.mock("../components/player/TransportControls", h.stub("transport"));
vi.mock("../components/player/LoopButton", h.stub("loop"));
vi.mock("../components/player/TempoControl", h.stub("tempo"));
vi.mock("../components/player/KeyTranspose", h.stub("transpose"));
vi.mock("../components/player/ChordCarousel", h.stub("chords"));
vi.mock("../components/player/CapoSelect", h.stub("capo"));
vi.mock("../components/player/ExportChartButton", h.stub("exportChart"));
vi.mock("../components/player/LoopsMenu", h.stub("loops"));
vi.mock("../components/player/BassTabPanel", h.stub("bassTab"));
vi.mock("../components/player/OutputSelector", h.stub("output"));
vi.mock("../components/recording/MicSelector", h.stub("mic"));
vi.mock("../components/recording/RecordButton", h.stub("record"));
vi.mock("../components/recording/TakeList", h.stub("takes"));
vi.mock("../components/lyrics/LyricsPanel", h.stub("lyrics"));
vi.mock("../components/panels/PanelMenu", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({ panels }: { panels: { id: string }[] }) =>
      el("div", { "data-c": "panelMenu", "data-ids": panels.map((p) => p.id).join(",") }),
  };
});

// zustand renders the server snapshot (the store's initial state) under
// react-dom/server, so choices are seeded through storage and the page is
// imported fresh for every render.
async function render(overrides: Record<string, boolean> = {}) {
  localStorage.setItem("sps_panels", JSON.stringify({ overrides }));
  vi.resetModules();
  const { default: AnalyzerPage } = await import("./AnalyzerPage");
  return renderToStaticMarkup(createElement(AnalyzerPage, { songId: "s1", onBack: () => {} }));
}

const shown = (html: string) => [...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]);
const OPTIONAL = ["chords", "lyrics", "takes"];

beforeEach(() => {
  localStorage.clear();
  h.detached = {};
  h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120 }];
});

describe("AnalyzerPage panels", () => {
  it("shows everything by default", async () => {
    expect(shown(await render())).toEqual(expect.arrayContaining([...OPTIONAL, "stems", "transport", "record"]));
  });

  it("always keeps the stems and the controls, however much is hidden", async () => {
    const ids = shown(await render({ chords: false, lyrics: false, takes: false }));
    expect(ids).toEqual(expect.arrayContaining(["stems", "transport", "loop", "tempo", "transpose", "mic", "output", "record"]));
    expect(ids.filter((c) => OPTIONAL.includes(c))).toEqual([]);
  });

  it.each(OPTIONAL)("hiding %s removes only that panel", async (id) => {
    const before = shown(await render());
    const after = shown(await render({ [id]: false }));
    expect(before.filter((c) => !after.includes(c))).toEqual([id]);
  });

  it("drops the takes wrapper along with the list", async () => {
    expect(await render({ takes: false })).not.toContain("analyzer-page__takes");
    expect(await render()).toContain("analyzer-page__takes");
  });

  it("puts a detach handle on every docked optional panel, and none on the stems", async () => {
    const html = await render();
    expect([...html.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["chords", "lyrics", "takes"]);
  });

  it.each(OPTIONAL)("a detached %s leaves the page, its handle with it, and nothing else", async (id) => {
    const before = shown(await render());
    h.detached = { [id]: true };
    const html = await render();
    expect(html).not.toContain(`data-panel="${id}"`);
    expect(before.filter((c) => !shown(html).includes(c))).toEqual([id]);
  });

  it("a panel that is hidden stays hidden even when it is also marked detached", async () => {
    h.detached = { lyrics: true };
    expect(shown(await render({ lyrics: false }))).not.toContain("lyrics");
  });

  it("offers the menu every optional panel", async () => {
    const html = await render();
    expect(/data-ids="([^"]*)"/.exec(html)?.[1]).toBe("chords,lyrics,takes");
  });
});
