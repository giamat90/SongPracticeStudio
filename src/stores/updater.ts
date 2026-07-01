import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type UpdaterStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

interface UpdaterState {
  status: UpdaterStatus;
  update: Update | null;
  progress: number;
  dismissed: boolean;

  checkForUpdates: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  update: null,
  progress: 0,
  dismissed: false,

  checkForUpdates: async () => {
    set({ status: "checking" });
    try {
      const update = await check();
      if (update?.available) {
        set({ status: "available", update });
      } else {
        set({ status: "idle" });
      }
    } catch (e) {
      console.warn("[updater] check failed:", e);
      set({ status: "idle" });
    }
  },

  installAndRestart: async () => {
    const { update } = get();
    if (!update) return;

    set({ status: "downloading", progress: 0 });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ progress: total ? downloaded / total : 0 });
            break;
          case "Finished":
            set({ status: "ready", progress: 1 });
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error("[updater] downloadAndInstall failed:", e);
      set({ status: "error" });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
