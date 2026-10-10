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
    takes: [] as unknown[],
    takeVolume: 1,
    setTakeVolume: () => {},
  };
  return { stub, state };
});

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }),
  getEngine: () => ({}),
}));
vi.mock("./TimeRuler", h.stub("ruler"));
vi.mock("./ChordRow", h.stub("chordRow"));
vi.mock("./StemTrack", h.stub("stemTrack"));
vi.mock("./TakeTrack", h.stub("takeTrack"));

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
