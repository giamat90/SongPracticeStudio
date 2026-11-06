import { describe, it, expect, vi, beforeEach } from "vitest";
import generated from "./ipc.generated.ts?raw";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

import { ACTIVITY_LABELS } from "./activityLabels";
import { useActivityStore } from "../stores/activity";
import { pitchShiftSong, listSongs } from "./ipc.generated";

const commands = new Set([...generated.matchAll(/invoke<.*>\("([a-z_]+)"/g)].map((m) => m[1]));

beforeEach(() => {
  tauriInvoke.mockReset();
  useActivityStore.setState({ tasks: [] });
});

describe("activity labels", () => {
  it("only name commands that exist", () => {
    for (const name of Object.keys(ACTIVITY_LABELS)) expect(commands, name).toContain(name);
  });

  it("are sentences that end in an ellipsis", () => {
    for (const label of Object.values(ACTIVITY_LABELS)) expect(label).toMatch(/…$/);
  });

  it("do not label commands that report their own progress", () => {
    for (const own of ["process_song", "import_youtube", "sync_lyrics"]) expect(ACTIVITY_LABELS).not.toHaveProperty(own);
  });
});

describe("the generated wrappers", () => {
  it("run a labelled command as activity and finish it", async () => {
    let during: string[] = [];
    tauriInvoke.mockImplementation(async () => {
      during = useActivityStore.getState().tasks.map((t) => t.label);
      return { stems: {} };
    });
    await pitchShiftSong("dir", ["vocals"], 2);
    expect(during).toEqual(["Transposing…"]);
    expect(useActivityStore.getState().tasks).toEqual([]);
  });

  it("leave an unlabelled command alone and end the task when a labelled one fails", async () => {
    tauriInvoke.mockResolvedValue([]);
    await listSongs();
    expect(tauriInvoke).toHaveBeenCalledWith("list_songs");
    tauriInvoke.mockRejectedValue(new Error("sidecar down"));
    await expect(pitchShiftSong("dir", ["vocals"], 1)).rejects.toThrow("sidecar down");
    expect(useActivityStore.getState().tasks).toEqual([]);
  });
});
