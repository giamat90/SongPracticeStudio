import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    minPxPerSec: 1,
    punchIn: null,
    punchOut: null,
    duration: 100,
    scrollTime: 0,
    takePlayback: "all" as "all" | "selected",
    mutedTakeIds: [] as string[],
    soloedStem: null as string | null,
    soloedTakeId: null as string | null,
    takeGains: {} as Record<string, number>,
    toggleTakeMute: () => {},
    toggleTakeSolo: () => {},
    setTakeGain: () => {},
    setActiveTake: () => {},
    hideTake: () => {},
    setTakeManualOffset: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }),
  getEngine: () => ({}),
  TAKE_TRACK_KEY: "__take__",
}));
vi.mock("../../lib/tauri", () => ({ exportTake: async () => {} }));

import TakeTrack from "./TakeTrack";

const take = { id: "t1", songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: "/t/t1.wav", startPosition: 0 };
const render = (over: { isActive?: boolean; isAudible?: boolean; silence?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(TakeTrack, {
      take,
      label: "Take 1",
      isActive: over.isActive ?? true,
      isAudible: over.isAudible ?? true,
      silence: (over.silence ?? null) as never,
      song: { id: "s1", title: "Song" } as never,
      containerRef: () => {},
    }),
  );

beforeEach(() => {
  h.state.takePlayback = "all";
  h.state.mutedTakeIds = [];
  h.state.soloedStem = null;
  h.state.soloedTakeId = null;
  h.state.takeGains = {};
});

describe("take lane", () => {
  it("has the offset next to the other controls, then mute, solo, volume and download, in that order", () => {
    const html = render();
    const order = [
      "waveform__take-sync",
      'aria-label="Mute Take 1"',
      'aria-label="Solo Take 1"',
      'aria-label="Take 1 volume"',
      'aria-label="Download Take 1"',
    ].map((m) => html.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts the name and the hide button together, before everything else", () => {
    const html = render();
    expect(html.indexOf("stem-track__take-name")).toBeLessThan(html.indexOf("stem-track__take-hide"));
    expect(html.indexOf("stem-track__take-hide")).toBeLessThan(html.indexOf("waveform__take-sync"));
  });

  it("keeps mute, solo and volume in selected-only mode as well", () => {
    h.state.takePlayback = "selected";
    const html = render({ isActive: false });
    expect(html).toContain('aria-label="Mute Take 1"');
    expect(html).toContain('aria-label="Solo Take 1"');
  });

  it("shows the take's own volume", () => {
    h.state.takeGains = { t1: 0.4 };
    expect(render()).toContain('value="0.4"');
  });

  it("marks a muted and a soloed lane", () => {
    h.state.mutedTakeIds = ["t1"];
    h.state.soloedTakeId = "t1";
    const html = render();
    expect(html).toContain('aria-label="Unmute Take 1"');
    expect(html).toContain('aria-label="Unsolo Take 1"');
  });

  it("says in its tooltips that it leaves the stems alone and that the main buttons come first", () => {
    const html = render();
    expect(html).toContain("The stems are not affected, and the main take mute and solo above still come first");
    expect(html).toContain("The main take mute and solo above still come first");
  });

  it("marks the selected lane even when it is silent, and says why", () => {
    const cases: [string | null, string][] = [
      [null, "Selected"],
      ["muted", "Selected \u00B7 muted"],
      ["channel", "Selected \u00B7 takes muted"],
      ["recording", "Selected \u00B7 silent while recording"],
      ["soloed-other", "Selected \u00B7 another take soloed"],
    ];
    for (const [silence, text] of cases) {
      const html = render({ isActive: true, isAudible: silence === null, silence });
      expect(html, String(silence)).toContain("waveform__take-state");
      expect(html, String(silence)).toContain(text);
      expect(html.includes("waveform__take-state--silent"), String(silence)).toBe(silence !== null);
    }
  });

  it("says Playing for the selected take in selected-only mode", () => {
    h.state.takePlayback = "selected";
    expect(render({ isActive: true })).toContain("\u25B6 Playing");
  });

  it("shows no selection label on a lane that is not selected, silent or not", () => {
    expect(render({ isActive: false, isAudible: false, silence: "not-selected" })).not.toContain("waveform__take-state");
    expect(render({ isActive: false })).not.toContain("waveform__take-state");
  });

  it("dims a lane that is not heard", () => {
    expect(render({ isAudible: false })).toContain("stem-track--silent");
    expect(render({ isAudible: true })).not.toContain("stem-track--silent");
  });
});
