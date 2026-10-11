import { describe, it, expect, vi } from "vitest";
import { buildShortcuts, SEEK_FINE_STEP_S, SEEK_STEP_S, type ShortcutPlayer } from "./shortcuts";

function fakePlayer(over: Partial<ShortcutPlayer> = {}) {
  const p: ShortcutPlayer = {
    isRecording: false,
    isCountingIn: false,
    currentTime: 50,
    duration: 200,
    punchIn: null,
    punchOut: null,
    punchLoop: false,
    togglePlay: vi.fn(),
    skipToStart: vi.fn(),
    skipToEnd: vi.fn(),
    seek: vi.fn(),
    setPunchIn: vi.fn(),
    setPunchOut: vi.fn(),
    setPunchLoop: vi.fn(),
    ...over,
  };
  return p;
}

function run(p: ShortcutPlayer, key: string, shift = false) {
  const binding = buildShortcuts(() => p).find((b) => b.key === key && (b.shift ?? false) === shift);
  if (!binding) throw new Error(`no binding for ${key}`);
  binding.run();
}

describe("buildShortcuts", () => {
  it("plays and pauses on space", () => {
    const p = fakePlayer();
    run(p, "space");
    expect(p.togglePlay).toHaveBeenCalled();
  });

  it("goes to the start and the end on Home and End", () => {
    const p = fakePlayer();
    run(p, "Home");
    run(p, "End");
    expect(p.skipToStart).toHaveBeenCalled();
    expect(p.skipToEnd).toHaveBeenCalled();
  });

  it("steps back and forward, finer with shift, inside the song", () => {
    const p = fakePlayer();
    run(p, "ArrowRight");
    run(p, "ArrowLeft");
    run(p, "ArrowRight", true);
    run(p, "ArrowLeft", true);
    expect((p.seek as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      50 + SEEK_STEP_S, 50 - SEEK_STEP_S, 50 + SEEK_FINE_STEP_S, 50 - SEEK_FINE_STEP_S,
    ]);
  });

  it("does not step past either end of the song", () => {
    const early = fakePlayer({ currentTime: 2 });
    run(early, "ArrowLeft");
    expect(early.seek).toHaveBeenCalledWith(0);
    const late = fakePlayer({ currentTime: 199 });
    run(late, "ArrowRight");
    expect(late.seek).toHaveBeenCalledWith(200);
  });

  it("toggles the loop only when there is a region", () => {
    const without = fakePlayer();
    run(without, "l");
    expect(without.setPunchLoop).not.toHaveBeenCalled();
    const withRegion = fakePlayer({ punchIn: 10, punchOut: 20, punchLoop: false });
    run(withRegion, "l");
    expect(withRegion.setPunchLoop).toHaveBeenCalledWith(true);
  });

  it("marks the region start and end at the playhead", () => {
    const p = fakePlayer({ currentTime: 30 });
    run(p, "[");
    expect(p.setPunchIn).toHaveBeenCalledWith(30);
    run(p, "]");
    expect(p.setPunchOut).toHaveBeenCalledWith(30);
  });

  it("moves the other end out of the way when a mark would cross it", () => {
    const start = fakePlayer({ currentTime: 30, punchIn: 10, punchOut: 20 });
    run(start, "[");
    expect(start.setPunchIn).toHaveBeenCalledWith(30);
    expect(start.setPunchOut).toHaveBeenCalledWith(30 + SEEK_STEP_S);

    const end = fakePlayer({ currentTime: 5, punchIn: 10, punchOut: 20 });
    run(end, "]");
    expect(end.setPunchOut).toHaveBeenCalledWith(5);
    expect(end.setPunchIn).toHaveBeenCalledWith(0);
  });

  it.each(["space", "Home", "End", "ArrowLeft", "ArrowRight", "l", "[", "]"])("%s does nothing while recording", (key) => {
    const p = fakePlayer({ isRecording: true, punchIn: 1, punchOut: 5 });
    run(p, key);
    for (const fn of [p.togglePlay, p.skipToStart, p.skipToEnd, p.seek, p.setPunchIn, p.setPunchOut, p.setPunchLoop]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("does nothing during the count-in", () => {
    const p = fakePlayer({ isCountingIn: true });
    run(p, "space");
    expect(p.togglePlay).not.toHaveBeenCalled();
  });

  it("reads the player when the key is pressed, not when the bindings are built", () => {
    let current = fakePlayer();
    const bindings = buildShortcuts(() => current);
    const next = fakePlayer();
    current = next;
    bindings.find((b) => b.key === "space")!.run();
    expect(next.togglePlay).toHaveBeenCalled();
  });
});
