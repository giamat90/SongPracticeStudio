import { create } from "zustand";
import { StartCancelled, type LiveMonitor } from "../audio/liveMonitor";
import type { LiveReading } from "../lib/liveInput";

export type LiveStatus = "off" | "starting" | "on" | "error";

interface LiveInputState {
  status: LiveStatus;
  error: string | null;
  /** Name of the device being listened to. */
  label: string | null;
  /** The latest look at the input, about ten a second while listening. */
  reading: LiveReading | null;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => Promise<void>;
}

interface MonitorHooks {
  publish: (reading: LiveReading) => void;
  lost: (message: string) => void;
}

export function createLiveInputStore(make: (hooks: MonitorHooks) => LiveMonitor, blockedReason: () => string | null) {
  return create<LiveInputState>((set, get) => {
    const monitor = make({
      publish: (reading) => set({ reading }),
      lost: (message) => set({ status: "error", error: message, label: null, reading: null }),
    });
    return {
      status: "off",
      error: null,
      label: null,
      reading: null,

      start: async () => {
        const { status } = get();
        if (status === "starting" || status === "on") return;
        const blocked = blockedReason();
        if (blocked) {
          set({ status: "error", error: blocked });
          return;
        }
        set({ status: "starting", error: null });
        try {
          const label = await monitor.start();
          set({ status: "on", label });
        } catch (e) {
          if (e instanceof StartCancelled) return;
          console.error("[live] could not open the input:", e);
          set({ status: "error", error: e instanceof Error ? e.message : String(e), label: null, reading: null });
        }
      },

      stop: () => {
        monitor.stop();
        set({ status: "off", error: null, label: null, reading: null });
      },

      toggle: async () => {
        if (get().status === "on" || get().status === "starting") get().stop();
        else await get().start();
      },
    };
  });
}
