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
    player: {
      cleanup: () => {}, takes: [] as { id: string }[], shownTakeIds: [] as string[],
      mutedStems: {} as Record<string, boolean>, soloedStem: null as string | null,
    },
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
vi.mock("../components/player/ChordRoll", h.stub("roll"));
vi.mock("../components/player/MeterPanel", h.stub("meter"));
vi.mock("../components/tab/TabPanel", h.stub("songTab"));
vi.mock("../components/player/OutputSelector", h.stub("output"));
vi.mock("../components/player/MonitorControl", h.stub("monitor"));
vi.mock("../components/recording/MicSelector", h.stub("mic"));
vi.mock("../components/recording/RecordButton", h.stub("record"));
vi.mock("../components/recording/TakeList", h.stub("takes"));
vi.mock("../components/lyrics/LyricsPanel", h.stub("lyrics"));
vi.mock("../components/panels/PanelMenu", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({
      panels, fixed,
    }: {
      panels: { id: string }[];
      fixed?: { items: { id: string; parts?: { id: string }[] }[]; tags?: Record<string, string> };
    }) =>
      el("div", {
        "data-c": "panelMenu",
        "data-ids": panels.map((p) => p.id).join(","),
        "data-fixed": fixed?.items.flatMap((i) => [i.id, ...(i.parts ?? []).map((p) => p.id)]).join(","),
        "data-tags": JSON.stringify(fixed?.tags ?? {}),
      }),
  };
});

// zustand renders the server snapshot (the store's initial state) under
// react-dom/server, so choices are seeded through storage and the page is
// imported fresh for every render.
async function render(
  overrides: Record<string, boolean> = {},
  order?: string[],
  waveforms: Record<string, boolean> = {},
  cards: Record<string, boolean> = {},
) {
  localStorage.setItem("sps_panels", JSON.stringify({ overrides, order }));
  if (Object.keys(cards).length > 0) {
    const saved = JSON.parse(localStorage.getItem("sps_topbar") ?? "{}") as object;
    localStorage.setItem("sps_topbar", JSON.stringify({ ...saved, overrides: cards }));
  }
  localStorage.setItem("sps_waveforms", JSON.stringify({ overrides: waveforms }));
  vi.resetModules();
  const { default: AnalyzerPage } = await import("./AnalyzerPage");
  return renderToStaticMarkup(createElement(AnalyzerPage, { songId: "s1", onBack: () => {} }));
}

const shown = (html: string) => [...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]);
const OPTIONAL = ["lyrics", "takes"];
const DETACHABLE = ["chords", ...OPTIONAL];

beforeEach(() => {
  localStorage.clear();
  h.detached = {};
  h.player.takes = [];
  h.player.shownTakeIds = [];
  h.player.mutedStems = {};
  h.player.soloedStem = null;
  h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120, hasChords: true }];
});

describe("AnalyzerPage panels", () => {
  it("shows everything by default", async () => {
    expect(shown(await render())).toEqual(expect.arrayContaining([...DETACHABLE, "stems", "transport"]));
  });

  it("leaves Record to the transport: the topbar no longer renders it", async () => {
    expect(shown(await render())).not.toContain("record");
  });

  it("lays the topbar out like VPS: tempo, then the input strip, then Transpose", async () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120 }];
    const ids = shown(await render());
    expect(ids.indexOf("tempo")).toBeLessThan(ids.indexOf("mic"));
    expect(ids.indexOf("mic") + 1).toBe(ids.indexOf("output"));
    expect(ids.indexOf("output")).toBeLessThan(ids.indexOf("transpose"));
  });

  it("puts the Monitor in the input strip between the mic and the output when the song has chords", async () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120, hasChords: true }];
    const ids = shown(await render());
    expect(ids.indexOf("mic") + 1).toBe(ids.indexOf("monitor"));
    expect(ids.indexOf("monitor") + 1).toBe(ids.indexOf("output"));
  });

  it("has no Monitor without chords or with the chord roll hidden: it draws only there", async () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120 }];
    expect(shown(await render())).not.toContain("monitor");
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120, hasChords: true }];
    expect(shown(await render({ roll: false }))).not.toContain("monitor");
  });

  const withChords = () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120, hasChords: true }];
  };
  const topbar = (html: string) => html.split("analyzer-page__topbar")[1].split("analyzer-page__body")[0];

  it("draws the topbar as six cards in one wrapping bar, in the default order", async () => {
    withChords();
    const bar = topbar(await render());
    expect(bar.match(/class="topbar-section/g)).toHaveLength(6);
    expect(bar).not.toContain("topbar-row");
    const ids = shown(bar);
    const at = (c: string) => ids.indexOf(c);
    expect(at("transport")).toBeLessThan(at("loop"));
    expect(at("loops")).toBeLessThan(at("tempo"));
    expect(at("tempo")).toBeLessThan(at("mic"));
    expect(at("output")).toBeLessThan(at("transpose"));
    expect(at("capo")).toBeLessThan(at("chords"));
  });

  it("has no Chords card for a song without chords: nothing in it to show", async () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums"], detectedBpm: 120 }];
    const bar = topbar(await render());
    expect(bar.match(/class="topbar-section/g)).toHaveLength(5);
    expect(bar).not.toContain('aria-label="Chords"');
  });

  it("draws the cards in the user's order, any card first, wherever it was", async () => {
    withChords();
    localStorage.setItem("sps_topbar", JSON.stringify({ overrides: {}, order: ["chords", "transpose", "tempo", "devices", "transport", "loop"] }));
    const ids = shown(topbar(await render()));
    const at = (c: string) => ids.indexOf(c);
    expect(at("transpose")).toBeLessThan(at("tempo"));
    expect(at("tempo")).toBeLessThan(at("mic"));
    expect(at("output")).toBeLessThan(at("transport"));
    expect(at("transport")).toBeLessThan(at("loop"));
  });

  it("always keeps the stems and the controls, however much is hidden", async () => {
    const ids = shown(await render({ lyrics: false, takes: false }));
    expect(ids).toEqual(expect.arrayContaining(["stems", "transport", "loop", "tempo", "transpose", "mic", "output", "chords"]));
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

  it.each(DETACHABLE)("a detached %s leaves the page, its handle with it, and nothing else", async (id) => {
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

  it("lays the body out as tracks first, then lyrics, then takes", async () => {
    const body = (await render()).split("analyzer-page__body")[1];
    const at = (c: string) => body.indexOf(`data-c="${c}"`);
    expect(at("stems")).toBeGreaterThan(-1);
    expect(at("stems")).toBeLessThan(at("bassTab"));
    expect(at("bassTab")).toBeLessThan(at("lyrics"));
    expect(at("lyrics")).toBeLessThan(at("takes"));
  });

  it("draws takes above lyrics when the user moved them, still under the tracks", async () => {
    const body = (await render({}, ["takes", "lyrics"])).split("analyzer-page__body")[1];
    const at = (c: string) => body.indexOf(`data-c="${c}"`);
    expect(at("bassTab")).toBeLessThan(at("takes"));
    expect(at("takes")).toBeLessThan(at("lyrics"));
  });

  it("keeps each panel's sizing class with the panel, wherever it is", async () => {
    const html = await render({}, ["takes", "lyrics"]);
    expect(html.indexOf("analyzer-page__takes")).toBeLessThan(html.indexOf("analyzer-page__lyrics"));
  });

  it("keeps the chord carousel in the topbar, a card of its own and not a panel", async () => {
    const html = await render({}, ["takes", "lyrics"]);
    expect(html.indexOf('data-c="chords"')).toBeLessThan(html.indexOf("analyzer-page__body"));
    expect(/data-ids="([^"]*)"/.exec(html)?.[1]).not.toContain("chords");
  });

  it("gives the roll, meter, lyrics and takes a movable slot", async () => {
    expect((await render()).match(/class="sortable-panel/g)).toHaveLength(4);
  });

  it("offers the Panels menu every optional panel, and not the chords", async () => {
    const html = await render();
    expect(/data-ids="([^"]*)"/.exec(html)?.[1]).toBe("roll,meter,lyrics,takes");
  });

  it("offers a second menu, Cards, with every card of the top bar", async () => {
    const html = await render();
    expect([...html.matchAll(/data-ids="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "roll,meter,lyrics,takes",
      "transport,loop,tempo,devices,transpose,chords",
    ]);
  });

  it("shows the meter between the chord roll and the lyrics, and cannot be detached", async () => {
    const html = await render();
    const at = (c: string) => html.indexOf(`data-c="${c}"`);
    expect(at("meter")).toBeGreaterThan(at("roll"));
    expect(at("meter")).toBeLessThan(at("lyrics"));
    expect(html).not.toContain('data-panel="meter"');
  });

  it("hiding the meter removes only that panel", async () => {
    const html = await render({ meter: false });
    expect(html).not.toContain('data-c="meter"');
    for (const c of ["roll", "lyrics", "takes", "chords", "stems"]) expect(html).toContain(`data-c="${c}"`);
  });
});

describe("AnalyzerPage cards", () => {
  const bar = (html: string) => html.split("analyzer-page__topbar")[1].split("analyzer-page__body")[0];

  it("hiding a card removes it, its grip and what it holds, and nothing else", async () => {
    const before = bar(await render());
    const after = bar(await render({}, undefined, {}, { loop: false }));
    expect(before.match(/class="topbar-grip"/g)).toHaveLength(6);
    expect(after.match(/class="topbar-grip"/g)).toHaveLength(5);
    expect(shown(before).filter((c) => !shown(after).includes(c))).toEqual(["loop", "loops"]);
  });

  it("hiding the Chords card removes the carousel and the detail select, and the Panels menu is unchanged", async () => {
    const html = await render({}, undefined, {}, { chords: false });
    expect(bar(html)).not.toContain('data-c="chords"');
    expect(bar(html)).not.toContain('aria-label="Chords"');
    expect(/data-ids="([^"]*)"/.exec(html)?.[1]).toBe("roll,meter,lyrics,takes");
  });

  it("is not affected by hiding panels, and does not hide them", async () => {
    const html = await render({ roll: false, meter: false, lyrics: false, takes: false });
    expect(bar(html).match(/class="topbar-section/g)).toHaveLength(6);
    const cardsHidden = await render({}, undefined, {}, { transport: false, loop: false, tempo: false, devices: false, transpose: false, chords: false });
    expect(bar(cardsHidden)).not.toContain("topbar-section");
    for (const c of ["roll", "meter", "lyrics", "takes", "stems"]) expect(cardsHidden).toContain(`data-c="${c}"`);
  });

  it("a Chords card whose carousel is in a window of its own keeps the detail select", async () => {
    h.detached = { chords: true };
    const html = bar(await render());
    expect(html).toContain('aria-label="Chords"');
    expect(html).not.toContain('data-c="chords"');
  });
});

describe("AnalyzerPage waveform area", () => {
  const COLLAPSED = "analyzer-page__waveforms--collapsed";
  const withBass = () => {
    h.library.songs = [{ id: "s1", title: "Song", stems: ["vocals", "drums", "bass"], detectedBpm: 120 }];
  };

  it("shows the stems by default", async () => {
    const html = await render();
    expect(html).toContain('class="analyzer-page__waveforms"');
    expect(html).not.toContain(COLLAPSED);
  });

  it("collapses the area when it is switched off, and still mounts it so the audio keeps loading", async () => {
    const html = await render({}, undefined, { waveforms: false });
    expect(html).toContain(COLLAPSED);
    expect(shown(html)).toContain("stems");
  });

  it("keeps the area, and so the strips, when every stem is minimized", async () => {
    expect(await render({}, undefined, { vocals: false, drums: false })).not.toContain(COLLAPSED);
  });

  it("is not affected by the other panels being hidden", async () => {
    expect(await render({ chords: false, lyrics: false, takes: false })).not.toContain(COLLAPSED);
  });

  it("lists the song's own stems under the waveforms in the Panels menu", async () => {
    const fixed = (html: string) => /data-fixed="([^"]*)"/.exec(html)?.[1];
    expect(fixed(await render())).toBe("waveforms,vocals,drums,songTab");
    withBass();
    expect(fixed(await render())).toBe("waveforms,vocals,drums,bass,bassTab,songTab");
  });

  it("hides the bass tab on its own, leaving the stems and the rest alone", async () => {
    withBass();
    const before = shown(await render());
    const after = shown(await render({}, undefined, { bassTab: false }));
    expect(before.filter((c) => !after.includes(c))).toEqual(["bassTab"]);
    expect(await render({}, undefined, { bassTab: false })).not.toContain(COLLAPSED);
  });

  it("tells the menu which hidden stem is muted or soloed", async () => {
    const tags = (html: string) => JSON.parse((/data-tags="([^"]*)"/.exec(html)?.[1] ?? "{}").replace(/&quot;/g, '"'));
    h.player.mutedStems = { drums: true };
    expect(tags(await render({}, undefined, { drums: false }))).toEqual({ drums: "muted" });
    h.player.soloedStem = "vocals";
    expect(tags(await render({}, undefined, { vocals: false }))).toEqual({ vocals: "solo" });
  });
});
