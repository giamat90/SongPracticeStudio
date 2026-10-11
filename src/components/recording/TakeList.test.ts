import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    song: { id: "s1", title: "Song" },
    takes: [] as { id: string; name?: string; recordedAt: string; filepath: string }[],
    activeTakeId: null as string | null,
    shownTakeIds: [] as string[],
    takePlayback: "all" as "all" | "selected",
    mutedTakeIds: [] as string[],
    isRecording: false,
    muteTakesWhileRecording: true,
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
const marks = (html: string) => [...html.matchAll(/take-item__state" aria-label="(\w+)"/g)].map((m) => m[1]);

beforeEach(() => {
  h.state.takes = [mk("a"), mk("b"), mk("c")];
  h.state.activeTakeId = null;
  h.state.shownTakeIds = [];
  h.state.takePlayback = "all";
  h.state.mutedTakeIds = [];
  h.state.isRecording = false;
  h.state.muteTakesWhileRecording = true;
});

describe("takes list", () => {
  it("shows every take as hidden until one is clicked", () => {
    const html = render();
    expect(marks(html)).toEqual(["hidden", "hidden", "hidden"]);
    expect(classes(html)).toEqual(["take-item", "take-item", "take-item"]);
  });

  it("marks every shown take as playing when they are heard together, the selected one highlighted", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(marks(html)).toEqual(["playing", "playing", "hidden"]);
    expect(classes(html)).toEqual(["take-item take-item--shown", "take-item take-item--active", "take-item"]);
  });

  it("marks a take muted on its lane as silent", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.mutedTakeIds = ["a"];
    expect(marks(render())).toEqual(["silent", "playing", "hidden"]);
  });

  it("in selected-only mode only the selected take is playing", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takePlayback = "selected";
    expect(marks(render())).toEqual(["silent", "playing", "hidden"]);
  });

  it("shows the takes as silent while recording when they are muted then", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.isRecording = true;
    expect(marks(render())).toEqual(["silent", "silent", "hidden"]);
    h.state.muteTakesWhileRecording = false;
    expect(marks(render())).toEqual(["playing", "playing", "hidden"]);
  });

  it("says what a click will do", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(item(html, 0)).toContain("Shown. Click to select it");
    expect(item(html, 1)).toContain("Selected. Click to hide this take");
    expect(item(html, 2)).toContain("Click to show this take");
  });

  it("says a click plays the take instead in selected-only mode", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takePlayback = "selected";
    expect(item(render(), 0)).toContain("Shown. Click to play this one");
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
