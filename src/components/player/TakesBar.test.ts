import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    takePlayback: "all" as "all" | "selected",
    muteTakesWhileRecording: true,
    takeVolume: 1,
    mutedStems: {} as Record<string, boolean>,
    soloedStem: null as string | null,
    setTakePlayback: () => {},
    setMuteTakesWhileRecording: () => {},
    setTakeVolume: () => {},
    toggleMute: () => {},
    toggleSolo: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.state),
  TAKE_TRACK_KEY: "__take__",
}));

import TakesBar from "./TakesBar";

const render = () => renderToStaticMarkup(createElement(TakesBar));
const labels = (html: string) =>
  [...html.matchAll(/<label class="takes-bar__option"[^>]*>(?:<input[^>]*\/>)([^<]*)</g)].map((m) => m[1]);
const checked = (html: string) => [...html.matchAll(/<input type="checkbox"([^>]*)\/>/g)].map((m) => m[1].includes("checked"));

beforeEach(() => {
  h.state.takePlayback = "all";
  h.state.muteTakesWhileRecording = true;
  h.state.mutedStems = {};
  h.state.soloedStem = null;
});

describe("takes bar", () => {
  it("has one fixed label per option, whatever its state", () => {
    expect(labels(render())).toEqual(["Selected take only", "Mute takes while recording"]);
    h.state.takePlayback = "selected";
    h.state.muteTakesWhileRecording = false;
    expect(labels(render())).toEqual(["Selected take only", "Mute takes while recording"]);
  });

  it("ticks an option when it is on", () => {
    expect(checked(render())).toEqual([false, true]);
    h.state.takePlayback = "selected";
    h.state.muteTakesWhileRecording = false;
    expect(checked(render())).toEqual([true, false]);
  });

  it("keeps the take channel's mute, solo and volume with their tooltips", () => {
    const html = render();
    expect(html).toContain("This main mute wins over the mute and solo on each take");
    expect(html).toContain("Solo on a take then picks one take among them");
    expect(html).toContain('type="range"');
  });
});
