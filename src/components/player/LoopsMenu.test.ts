import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    song: null as unknown,
    punchIn: null as number | null,
    punchOut: null as number | null,
    duration: 100,
    metronomeOffset: 0,
    isRecording: false,
    saveLoop: async () => {},
    renameLoop: async () => {},
    deleteLoop: async () => {},
    applyLoopRegion: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.state),
}));

import LoopsMenu from "./LoopsMenu";

const render = () => renderToStaticMarkup(createElement(LoopsMenu));

beforeEach(() => {
  h.state.song = { id: "s", title: "S", stems: [], detectedBpm: 120, loops: [] };
});

describe("LoopsMenu", () => {
  it("renders nothing without a song", () => {
    h.state.song = null;
    expect(render()).toBe("");
  });

  it("shows only the button while closed, with the number of saved loops", () => {
    expect(render()).toContain("Loops ▾");
    expect(render()).not.toContain("Saved loops");
    h.state.song = { id: "s", title: "S", stems: [], loops: [{ id: "a", name: "A", start: 1, end: 5 }] };
    expect(render()).toContain("Loops (1)");
  });
});
