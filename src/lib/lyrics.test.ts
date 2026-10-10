import { describe, it, expect } from "vitest";
import { canSyncLyrics } from "./lyrics";

describe("canSyncLyrics", () => {
  it("needs the vocals stem, which a song can be imported without", () => {
    expect(canSyncLyrics(["vocals", "drums", "bass"])).toBe(true);
    expect(canSyncLyrics(["drums", "bass", "other"])).toBe(false);
    expect(canSyncLyrics([])).toBe(false);
  });
});
