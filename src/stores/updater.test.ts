import { describe, it, expect, vi, beforeEach } from "vitest";

const check = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

import { useUpdaterStore } from "./updater";

type Handler = (event: { event: string; data?: Record<string, number> }) => void;

function fakeUpdate(run: (cb: Handler) => Promise<void> | void) {
  return { available: true, version: "9.9.9", downloadAndInstall: vi.fn(async (cb: Handler) => { await run(cb); }) };
}

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
  useUpdaterStore.setState({ status: "idle", update: null, progress: 0, dismissed: false });
});

describe("checkForUpdates", () => {
  it("goes to 'available' and keeps the update when one exists", async () => {
    const update = fakeUpdate(() => {});
    check.mockResolvedValue(update);
    const pending = useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status).toBe("checking");
    await pending;
    expect(useUpdaterStore.getState().status).toBe("available");
    expect(useUpdaterStore.getState().update).toBe(update);
  });

  it("returns to idle when up to date (null)", async () => {
    check.mockResolvedValue(null);
    await useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status).toBe("idle");
    expect(useUpdaterStore.getState().update).toBeNull();
  });

  it("returns to idle when the update is flagged unavailable", async () => {
    check.mockResolvedValue({ available: false });
    await useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status).toBe("idle");
  });

  it("logs and returns to idle when the check fails (offline must not break startup)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    check.mockRejectedValue(new Error("offline"));
    await useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status).toBe("idle");
    expect(warn).toHaveBeenCalled();
  });
});

describe("installAndRestart", () => {
  it("does nothing without a pending update", async () => {
    await useUpdaterStore.getState().installAndRestart();
    expect(useUpdaterStore.getState().status).toBe("idle");
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("tracks download progress as a fraction, then relaunches", async () => {
    const seen: number[] = [];
    const update = fakeUpdate((cb) => {
      cb({ event: "Started", data: { contentLength: 1000 } });
      cb({ event: "Progress", data: { chunkLength: 250 } });
      seen.push(useUpdaterStore.getState().progress);
      cb({ event: "Progress", data: { chunkLength: 250 } });
      seen.push(useUpdaterStore.getState().progress);
      cb({ event: "Finished" });
    });
    useUpdaterStore.setState({ status: "available", update: update as never });
    await useUpdaterStore.getState().installAndRestart();
    expect(seen).toEqual([0.25, 0.5]);
    expect(useUpdaterStore.getState().status).toBe("ready");
    expect(useUpdaterStore.getState().progress).toBe(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports 0 progress when the server sends no content length", async () => {
    const update = fakeUpdate((cb) => {
      cb({ event: "Started", data: {} });
      cb({ event: "Progress", data: { chunkLength: 500 } });
    });
    useUpdaterStore.setState({ update: update as never });
    await useUpdaterStore.getState().installAndRestart();
    expect(useUpdaterStore.getState().progress).toBe(0);
  });

  it("enters the error state and does not relaunch when the install fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const update = fakeUpdate(() => { throw new Error("signature mismatch"); });
    useUpdaterStore.setState({ update: update as never });
    await useUpdaterStore.getState().installAndRestart();
    expect(useUpdaterStore.getState().status).toBe("error");
    expect(relaunch).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it("enters the error state when the relaunch itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    relaunch.mockRejectedValue(new Error("no relaunch"));
    useUpdaterStore.setState({ update: fakeUpdate(() => {}) as never });
    await useUpdaterStore.getState().installAndRestart();
    expect(useUpdaterStore.getState().status).toBe("error");
  });
});

describe("dismiss", () => {
  it("hides the banner without discarding the update", () => {
    const update = fakeUpdate(() => {});
    useUpdaterStore.setState({ status: "available", update: update as never });
    useUpdaterStore.getState().dismiss();
    expect(useUpdaterStore.getState().dismissed).toBe(true);
    expect(useUpdaterStore.getState().update).toBe(update);
  });
});
