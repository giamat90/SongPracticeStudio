import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProcessingStatus } from "./types";

// Every command wrapper is generated from the Rust command signatures; see ipc.generated.ts.
export * from "./ipc.generated";
export type { MixSource, ZipExportEntry } from "./ipcTypes";

export interface TabProgress {
  songId: string;
  progress: number;
  stage: string;
}

export function onTabProgress(callback: (progress: TabProgress) => void): Promise<UnlistenFn> {
  return listen<TabProgress>("tab-progress", (event) => callback(event.payload));
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
