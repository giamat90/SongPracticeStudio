import { describe, expect, it } from "vitest";
import { buildTabScore, defaultTrack, flatSyncPoints, loadAlphaTab, tabTracks, trackRole } from "./tabScore";

// Two tracks, 5 bars of 4/4 at 120 bpm; bars 1-2 repeat once, so 8 bars are played.
const TEX = String.raw`\title "T"
.
\tempo 120
\track "Guitar"
\instrument 29
\ts 4 4
3.3.4*4 | \ro 5.3.4*4 | 0.3.4*4 \rc 2 | 7.3.4*4
\track "Bass"
\instrument 33
3.4.1 | 3.4.1 | 5.4.1 | 5.4.1 | 3.4.1`;

async function score(tex = TEX) {
  const at = await loadAlphaTab();
  return { at, score: at.importer.ScoreLoader.loadAlphaTex(tex, new at.Settings()) };
}

describe("trackRole", () => {
  it("follows the General MIDI program families", () => {
    expect(trackRole(29, false, "Lead")).toBe("g");
    expect(trackRole(33, false, "Bass")).toBe("b");
    expect(trackRole(4, false, "Rhodes")).toBe("k");
    expect(trackRole(48, false, "Strings")).toBeNull();
    expect(trackRole(0, true, "Drums")).toBe("d");
  });

  it("leaves vocals out whatever their program", () => {
    expect(trackRole(0, false, "Lead Vocals")).toBeNull();
    expect(trackRole(52, false, "Choir")).toBeNull();
  });
});

describe("tabTracks / defaultTrack", () => {
  it("lists the tracks with their roles and note counts", async () => {
    const { score: s } = await score();
    const tracks = tabTracks(s);
    expect(tracks.map((t) => [t.name, t.role])).toEqual([["Guitar", "g"], ["Bass", "b"]]);
    expect(tracks[0].noteCount).toBe(16);
    expect(tracks[1].noteCount).toBe(5);
    expect(defaultTrack(tracks)).toBe(0);
  });

  const track = (index: number, role: "g" | "b" | "k" | "d" | null, noteCount: number) => ({ index, name: `T${index}`, role, noteCount });

  it("starts on the busiest guitar, not the first one", () => {
    expect(defaultTrack([track(0, "g", 12), track(1, "g", 900), track(2, "b", 2000)])).toBe(1);
  });

  it("falls back to the busiest bass, then the busiest track", () => {
    expect(defaultTrack([track(0, "k", 10), track(1, "b", 5), track(2, "b", 50)])).toBe(2);
    expect(defaultTrack([track(3, "k", 10), track(4, "d", 90)])).toBe(4);
    expect(defaultTrack([])).toBe(0);
  });
});

describe("buildTabScore", () => {
  it("lists the bars in play order with the pass over each repeated bar", async () => {
    const { at, score: s } = await score();
    const built = buildTabScore(at, s);
    expect(built.version).toBe(1);
    expect(built.division).toBe(960);
    expect(built.bars.map((b) => [b.index, b.occurrence])).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [3, 1], [4, 0],
    ]);
    expect(built.bars[0]).toMatchObject({ tick: 0, end: 3840 });
    expect(built.bars.every((b, i, all) => i === 0 || b.tick === all[i - 1].end)).toBe(true);
  });

  it("carries the tempo map and the notes with their roles", async () => {
    const { at, score: s } = await score();
    const built = buildTabScore(at, s);
    expect(built.tempos).toEqual([[0, 120]]);
    expect(new Set(built.notes.map((n) => n[3]))).toEqual(new Set(["g", "b"]));
    const first = built.notes.filter((n) => n[3] === "g").sort((a, b) => a[0] - b[0])[0];
    expect(first[0]).toBe(0);
    expect(first[1]).toBeGreaterThan(0);
  });

  it("expands the repeat in the notes too", async () => {
    const { at, score: s } = await score();
    const built = buildTabScore(at, s);
    const second = built.bars.find((b) => b.index === 1 && b.occurrence === 1);
    const first = built.bars.find((b) => b.index === 1 && b.occurrence === 0);
    if (!first || !second) throw new Error("bar 1 should be played twice");
    const inBar = (bar: { tick: number; end: number }) =>
      built.notes.filter((n) => n[3] === "g" && n[0] >= bar.tick && n[0] < bar.end).map((n) => [n[0] - bar.tick, n[2]]);
    expect(inBar(first).length).toBeGreaterThan(0);
    expect(inBar(second)).toEqual(inBar(first));
  });

  it("is JSON the sidecar can read", async () => {
    const { at, score: s } = await score();
    const round = JSON.parse(JSON.stringify(buildTabScore(at, s)));
    expect(round.notes[0]).toHaveLength(4);
  });
});

describe("flatSyncPoints", () => {
  it("makes one point per played bar, in milliseconds", () => {
    expect(flatSyncPoints([{ index: 3, occurrence: 1, time: 12.3456 }])).toEqual([
      { barIndex: 3, barPosition: 0, barOccurence: 1, millisecondOffset: 12346 },
    ]);
  });
});
