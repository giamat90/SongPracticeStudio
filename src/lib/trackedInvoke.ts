import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createTrackedInvoke, type InvokeFn } from "@giamat90/mps-core/activity";
import { useActivityStore } from "../stores/activity";
import { ACTIVITY_LABELS } from "./activityLabels";

// ipc.generated.ts calls this instead of Tauri's invoke, so every labelled command
// shows up as activity without the caller doing anything.
export const invoke: InvokeFn = createTrackedInvoke(useActivityStore, ACTIVITY_LABELS, tauriInvoke as InvokeFn);
