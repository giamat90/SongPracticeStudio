import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  const stub = (name: string) => async () => {
    const { createElement: el } = await import("react");
    return { default: () => el("div", { "data-c": name }) };
  };
  const state = {
    loadSong: async () => {},
    activeTakeId: null as string | null,
    shownTakeIds: [] as string[],
    takePlayback: "all" as "all" | "selected",
    mutedTakeIds: [] as string[],
    soloedStem: null as string | null,
    soloedTakeId: null as string | null,
    isRecording: false,
    muteTakesWhileRecording: true,
    takes: [] as unknown[],
    takeVolume: 1,
    setTakeVolume: () => {},
  };
  return { stub, state };
});

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }),
  getEngine: () => ({}),
  TAKE_TRACK_KEY: "__take__",
}));
vi.mock("./TimeRuler", h.stub("ruler"));
vi.mock("./ChordRow", h.stub("chordRow"));
vi.mock("./StemTrack", h.stub("stemTrack"));
vi.mock("./TakeTrack", h.stub("takeTrack"));
vi.mock("./TakesBar", h.stub("takesBar"));

// zustand renders the server snapshot under react-dom/server, so choices are
// seeded through storage and the component is imported fresh each time.
async function render(overrides: Record<string, boolean> = {}) {
  localStorage.setItem("sps_panels", JSON.stringify({ overrides }));
  vi.resetModules();
  const { default: StemView } = await import("./StemView");
  const song = { id: "s1", title: "Song", stems: ["vocals", "drums"], duration: 10 };
  return renderToStaticMarkup(createElement(StemView, { song: song as never }));
}

const shown = (html: string) => [...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]);

beforeEach(() => {
  localStorage.clear();
  h.state.activeTakeId = null;
  h.state.shownTakeIds = [];
  h.state.takePlayback = "all";
  h.state.mutedTakeIds = [];
  h.state.isRecording = false;
  h.state.takes = [];
});

describe("StemView chord row", () => {
  it("shows the chord row above the ruler by default", async () => {
    const ids = shown(await render());
    expect(ids.indexOf("chordRow")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("chordRow")).toBeLessThan(ids.indexOf("ruler"));
  });

  it("drops only the chord row when the chords panel is off", async () => {
    const ids = shown(await render({ chords: false }));
    expect(ids).not.toContain("chordRow");
    expect(ids).toEqual(expect.arrayContaining(["ruler", "stemTrack"]));
    expect(ids.filter((c) => c === "stemTrack")).toHaveLength(2);
  });
});

describe("StemView take lanes", () => {
  const mk = (id: string) => ({ id, songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav`, startPosition: 0 });

  it("has no takes bar and no lanes while nothing is shown", async () => {
    h.state.takes = [mk("a"), mk("b")];
    const ids = shown(await render());
    expect(ids).not.toContain("takesBar");
    expect(ids).not.toContain("takeTrack");
  });

  it("has one takes bar and one lane per shown take", async () => {
    h.state.takes = [mk("a"), mk("b"), mk("c")];
    h.state.shownTakeIds = ["c", "a"];
    h.state.activeTakeId = "a";
    const ids = shown(await render());
    expect(ids.filter((c) => c === "takesBar")).toHaveLength(1);
    expect(ids.filter((c) => c === "takeTrack")).toHaveLength(2);
    expect(ids.indexOf("takesBar")).toBeLessThan(ids.indexOf("takeTrack"));
  });

  it("ignores a shown id that is no longer in the list of takes", async () => {
    h.state.takes = [mk("a")];
    h.state.shownTakeIds = ["a", "ghost"];
    const ids = shown(await render());
    expect(ids.filter((c) => c === "takeTrack")).toHaveLength(1);
  });
});
