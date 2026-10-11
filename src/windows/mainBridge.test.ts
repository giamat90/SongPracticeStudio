import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startMainBridge, type PlayerPort } from "./mainBridge";
import { EVT_COMMAND, EVT_DOCKED, EVT_HELLO, EVT_STATE } from "./protocol";

const take = (id: string) => ({ id, songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav`, startPosition: 0 });

function harness() {
  const state: PlayerPort = {
    song: { id: "s1", title: "Song", stems: ["vocals"] } as PlayerPort["song"],
    isPlaying: false,
    currentTime: 0,
    duration: 200,
    playbackRate: 1,
    activeTakeId: null,
    takes: [take("t1"), take("t2")],
    seek: vi.fn(),
    setActiveTake: vi.fn(),
    deleteTake: vi.fn(async () => {}),
    renameTake: vi.fn(async () => {}),
  };
  let notify: () => void = () => {};
  const handlers = new Map<string, (p: unknown) => void>();
  const emitted: { event: string; payload: unknown }[] = [];
  const bridge = startMainBridge({
    player: { getState: () => state, subscribe: (l) => ((notify = l), () => {}) },
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    listen: async (event, cb) => {
      handlers.set(event, cb);
      return () => {};
    },
    now: () => 5000,
  });
  return { state, emitted, bridge, fire: (e: string, p: unknown) => handlers.get(e)?.(p), notify: () => notify() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("analyzer main bridge", () => {
  it("sends nothing before a window says hello", async () => {
    const h = harness();
    await h.bridge;
    h.state.currentTime = 10;
    h.notify();
    expect(h.emitted).toEqual([]);
  });

  it("answers hello with the song, the takes and the transport", async () => {
    const h = harness();
    await h.bridge;
    h.state.currentTime = 42;
    h.state.activeTakeId = "t2";
    h.fire(EVT_HELLO, { panelId: "takes" });
    expect(h.emitted).toHaveLength(1);
    const msg = h.emitted[0].payload as { transport: { time: number }; shared: Record<string, unknown> };
    expect(h.emitted[0].event).toBe(EVT_STATE);
    expect(msg.transport.time).toBe(42);
    expect(msg.shared).toMatchObject({ duration: 200, activeTakeId: "t2" });
    expect((msg.shared.takes as unknown[]).length).toBe(2);
    expect((msg.shared.song as { id: string }).id).toBe("s1");
  });

  it("sends a new state when a take is added", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "takes" });
    h.state.takes = [...h.state.takes, take("t3")];
    h.notify();
    expect(h.emitted).toHaveLength(2);
    expect(((h.emitted[1].payload as { shared: { takes: unknown[] } }).shared.takes)).toHaveLength(3);
  });

  it("runs seek and the take commands against the main player", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "seek", time: 7 });
    h.fire(EVT_COMMAND, { type: "setActiveTake", id: "t2" });
    h.fire(EVT_COMMAND, { type: "renameTake", id: "t1", name: "Chorus" });
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "t1" });
    expect(h.state.seek).toHaveBeenCalledWith(7);
    expect(h.state.setActiveTake).toHaveBeenCalledWith("t2");
    expect(h.state.renameTake).toHaveBeenCalledWith("t1", "Chorus");
    expect(h.state.deleteTake).toHaveBeenCalledWith("t1");
  });

  it("does not act on a take that does not exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "nope" });
    h.fire(EVT_COMMAND, { type: "setActiveTake", id: "nope" });
    expect(h.state.deleteTake).not.toHaveBeenCalled();
    expect(h.state.setActiveTake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("drops commands it does not know", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "setPunchIn", time: 3 });
    h.fire(EVT_COMMAND, "seek");
    expect(h.state.seek).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reports a failed delete instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    (h.state.deleteTake as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk"));
    await h.bridge;
    h.fire(EVT_COMMAND, { type: "deleteTake", id: "t1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalled();
  });

  it("stops publishing once every window is docked", async () => {
    const h = harness();
    await h.bridge;
    h.fire(EVT_HELLO, { panelId: "lyrics" });
    h.fire(EVT_DOCKED, "lyrics");
    const before = h.emitted.length;
    h.state.currentTime = 99;
    h.notify();
    vi.advanceTimersByTime(500);
    expect(h.emitted.length).toBe(before);
  });
});
