import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    song: { id: "s1", title: "Song" },
    takes: [] as { id: string; name?: string; recordedAt: string; filepath: string }[],
    activeTakeId: null as string | null,
    shownTakeIds: [] as string[],
    toggleTake: () => {},
    deleteTake: () => {},
    renameTake: () => {},
    fetchTakes: async () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.state),
}));
vi.mock("../../lib/tauri", () => ({ exportTake: async () => {} }));

import TakeList from "./TakeList";

const mk = (id: string) => ({ id, recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav` });
const render = () => renderToStaticMarkup(createElement(TakeList));
const classes = (html: string) => [...html.matchAll(/<div class="(take-item(?: take-item--\w+)?)"/g)].map((m) => m[1]);
const item = (html: string, n: number) => html.split(/<div class="take-item(?: take-item--\w+)?"/)[n + 1] ?? "";

beforeEach(() => {
  h.state.takes = [mk("a"), mk("b"), mk("c")];
  h.state.activeTakeId = null;
  h.state.shownTakeIds = [];
});

describe("takes list", () => {
  it("shows every take as hidden until one is clicked", () => {
    const html = render();
    expect(html.match(/aria-label="hidden"/g)).toHaveLength(3);
    expect(classes(html)).toEqual(["take-item", "take-item", "take-item"]);
  });

  it("marks the take that is playing and the others that are shown", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(classes(html)).toEqual(["take-item take-item--shown", "take-item take-item--active", "take-item"]);
    expect(item(html, 0)).toContain('aria-label="shown"');
    expect(item(html, 1)).toContain('aria-label="playing"');
    expect(item(html, 2)).toContain('aria-label="hidden"');
  });

  it("says what a click will do", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(item(html, 0)).toContain("Click to play this one");
    expect(item(html, 1)).toContain("Click to hide this take");
    expect(item(html, 2)).toContain("Click to show this take");
  });

  it("reports whether a take is shown for assistive technology", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = render();
    expect(item(html, 0)).toContain('aria-pressed="true"');
    expect(item(html, 1)).toContain('aria-pressed="false"');
  });

  it("says there are no recordings when there are none", () => {
    h.state.takes = [];
    expect(render()).toContain("No recordings yet.");
  });
});
