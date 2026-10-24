import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    isPlaying: false,
    currentTime: 65,
    duration: 200,
    isRecording: false,
    isCountingIn: false,
    countInFor: null as string | null,
    countInBeatsRemaining: 0,
    togglePlay: () => {},
    stop: () => {},
    stopRecording: async () => {},
    skipToStart: () => {},
    skipToEnd: () => {},
  },
}));

vi.mock("../../stores/player", () => ({ usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.state) }));
vi.mock("../recording/RecordButton", async () => {
  const { createElement: el } = await import("react");
  return { default: () => el("div", { "data-c": "record" }) };
});
vi.mock("./CountInButton", async () => {
  const { createElement: el } = await import("react");
  return { default: () => el("div", { "data-c": "countIn" }) };
});

import TransportControls from "./TransportControls";

const render = () => renderToStaticMarkup(createElement(TransportControls));
const buttonTagFor = (html: string, label: string) =>
  (html.match(/<button[^>]*>/g) ?? []).find((tag) => tag.includes(`aria-label="${label}"`));

beforeEach(() => {
  h.state.isPlaying = false;
  h.state.isRecording = false;
  h.state.isCountingIn = false;
  h.state.countInFor = null;
});

describe("TransportControls", () => {
  it("lays the cluster out as skip, Stop, Play, Record, skip, count-in, time", () => {
    const html = render();
    const at = (needle: string) => html.indexOf(needle);
    const order = [
      at("transport__playback"),
      at('aria-label="Skip to start"'),
      at('aria-label="Stop"'),
      at('aria-label="Play"'),
      at('data-c="record"'),
      at('aria-label="Skip to end"'),
      at('data-c="countIn"'),
      at('role="timer"'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("shows the elapsed and total time", () => {
    expect(render()).toContain("1:05 / 3:20");
  });

  it("disables the skip buttons but never Stop while recording", () => {
    h.state.isRecording = true;
    const html = render();
    expect(buttonTagFor(html, "Skip to start")).toContain("disabled");
    expect(buttonTagFor(html, "Skip to end")).toContain("disabled");
    expect(buttonTagFor(html, "Stop")).not.toContain("disabled");
  });

  it("turns Play into a cancel button while the count-in before Play runs", () => {
    h.state.isCountingIn = true;
    h.state.countInFor = "play";
    h.state.countInBeatsRemaining = 3;
    const html = render();
    expect(buttonTagFor(html, "Cancel count-in")).toBeDefined();
    expect(html).toContain("transport__btn--counting-in");
  });
});
