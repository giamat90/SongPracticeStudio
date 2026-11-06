import { createActivityStore } from "@giamat90/mps-core/activity";

// What the window is busy with, shown by ActivityIndicator. Slow IPC commands arrive
// through lib/trackedInvoke; waits that are not a command (opening a song, decoding a
// take) call `track` themselves.
export const useActivityStore = createActivityStore();
