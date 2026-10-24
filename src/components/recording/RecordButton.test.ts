import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  rec: {
    isRecording: false,
    isCountingIn: false,
    isSavingTake: false,
    countInBeatsRemaining: 0,
    recordLabel: "Start recording",
    error: null as string | null,
    onRecordClick: () => {},
  },
}));

vi.mock("@giamat90/mps-core/hooks", () => ({ useRecordButton: () => h.rec }));
vi.mock("../../stores/player", () => ({ usePlayerStore: {} }));

import RecordButton from "./RecordButton";

const render = () => renderToStaticMarkup(createElement(RecordButton));

beforeEach(() => {
  Object.assign(h.rec, {
    isRecording: false,
    isCountingIn: false,
    isSavingTake: false,
    countInBeatsRemaining: 0,
    recordLabel: "Start recording",
    error: null,
  });
});

describe("RecordButton", () => {
  it("is a red dot named by the hook's label", () => {
    const html = render();
    expect(html).toContain('aria-label="Start recording"');
    expect(html).toContain("record-btn__dot");
    expect(html).not.toContain("record-btn--active");
  });

  it("marks the active state while recording", () => {
    h.rec.isRecording = true;
    h.rec.recordLabel = "Stop recording";
    const html = render();
    expect(html).toContain("record-btn--active");
    expect(html).toContain('aria-label="Stop recording"');
  });

  it("shows the count-in beats in place of the dot", () => {
    h.rec.isCountingIn = true;
    h.rec.countInBeatsRemaining = 3;
    const html = render();
    expect(html).toContain("record-btn--counting-in");
    expect(html).toContain('<span class="record-btn__countdown">3</span>');
    expect(html).not.toContain("record-btn__dot");
  });

  it("disables the button and says so while the take is saved", () => {
    h.rec.isSavingTake = true;
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('role="status"');
  });

  it("announces an error, and keeps the whole message in the tooltip because the bar clips it", () => {
    h.rec.error = "Microphone unavailable: another application is using it";
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('title="Microphone unavailable: another application is using it"');
  });

  it("renders no status or error when there is none", () => {
    const html = render();
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });
});
