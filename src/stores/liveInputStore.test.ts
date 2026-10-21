import { describe, expect, it, vi } from "vitest";
import { StartCancelled, type LiveMonitor } from "../audio/liveMonitor";
import type { LiveReading } from "../lib/liveInput";
import { createLiveInputStore } from "./liveInputStore";

const reading: LiveReading = { db: null, sampleRate: 44100, notes: new Uint8Array(61), levelDb: -80, clipped: false };

function setup(start: () => Promise<string> = async () => "Focusrite", blocked: () => string | null = () => null) {
  const hooks: { publish: (r: LiveReading) => void; lost: (m: string) => void } = { publish: () => {}, lost: () => {} };
  const monitor: LiveMonitor = { running: false, start: vi.fn(start), stop: vi.fn() };
  const store = createLiveInputStore((h) => {
    hooks.publish = h.publish;
    hooks.lost = h.lost;
    return monitor;
  }, blocked);
  return { store, monitor, hooks };
}

describe("live input store", () => {
  it("starts off", () => {
    const { store } = setup();
    expect(store.getState()).toMatchObject({ status: "off", error: null, label: null, reading: null });
  });

  it("shows starting while the input opens, then on with the device's name", async () => {
    let finish: (label: string) => void = () => {};
    const { store } = setup(() => new Promise<string>((resolve) => { finish = resolve; }));
    const started = store.getState().start();
    expect(store.getState().status).toBe("starting");
    finish("Analogue 1 + 2");
    await started;
    expect(store.getState()).toMatchObject({ status: "on", label: "Analogue 1 + 2", error: null });
  });

  it("keeps the latest reading", async () => {
    const { store, hooks } = setup();
    await store.getState().start();
    hooks.publish(reading);
    expect(store.getState().reading).toBe(reading);
  });

  it("does not open twice", async () => {
    const { store, monitor } = setup();
    await store.getState().start();
    await store.getState().start();
    expect(monitor.start).toHaveBeenCalledTimes(1);
  });

  it("refuses with the reason when something else holds the input", async () => {
    const { store, monitor } = setup(undefined, () => "Stop recording before listening to the input.");
    await store.getState().start();
    expect(monitor.start).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ status: "error", error: "Stop recording before listening to the input." });
  });

  it("reports an input that cannot be opened and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = setup(async () => { throw new Error("Input unavailable: busy"); });
    await store.getState().start();
    expect(store.getState()).toMatchObject({ status: "error", error: "Input unavailable: busy", label: null });
    expect(log).toHaveBeenCalled();
  });

  it("can try again after an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const start = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce("Focusrite");
    const { store } = setup(start);
    await store.getState().start();
    await store.getState().start();
    expect(store.getState()).toMatchObject({ status: "on", error: null, label: "Focusrite" });
  });

  it("stays off when it was stopped before it finished opening", async () => {
    let fail: (e: Error) => void = () => {};
    const { store } = setup(() => new Promise<string>((_, reject) => { fail = reject; }));
    const started = store.getState().start();
    store.getState().stop();
    fail(new StartCancelled());
    await started;
    expect(store.getState()).toMatchObject({ status: "off", error: null });
  });

  it("stops: back to off with nothing left to show", async () => {
    const { store, monitor, hooks } = setup();
    await store.getState().start();
    hooks.publish(reading);
    store.getState().stop();
    expect(monitor.stop).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ status: "off", label: null, reading: null });
  });

  it("toggles", async () => {
    const { store } = setup();
    await store.getState().toggle();
    expect(store.getState().status).toBe("on");
    await store.getState().toggle();
    expect(store.getState().status).toBe("off");
  });

  it("shows an error when the device is lost while listening", async () => {
    const { store, hooks } = setup();
    await store.getState().start();
    hooks.publish(reading);
    hooks.lost("The input was disconnected.");
    expect(store.getState()).toMatchObject({ status: "error", error: "The input was disconnected.", reading: null, label: null });
  });
});
