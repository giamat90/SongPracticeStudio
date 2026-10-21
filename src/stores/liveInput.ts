import { openLiveInput } from "../audio/liveInput";
import { createLiveMonitor } from "../audio/liveMonitor";
import { LiveTrace, calibratedLatencyS } from "../lib/liveInput";
import { createLiveInputStore } from "./liveInputStore";
import { getEngine, usePlayerStore } from "./player";
import { liveMonitorGate } from "./player/singletons";

export type { LiveStatus } from "./liveInputStore";

/** The notes heard on the input, read by the chord roll's draw loop every frame (not state: nothing re-renders for it). */
export const liveTrace = new LiveTrace();

export const useLiveInput = createLiveInputStore(
  ({ publish, lost }) => createLiveMonitor({
    open: async (deviceId) => {
      const source = await openLiveInput(deviceId);
      // Opening an input can move Windows' default output to the communications device; keep the one the user chose.
      const output = usePlayerStore.getState().selectedOutputDeviceId;
      if (output) {
        try {
          await getEngine().setOutputDevice(output);
        } catch (e) {
          console.warn("[live] could not keep the chosen output:", e);
        }
      }
      return source;
    },
    deviceId: () => usePlayerStore.getState().selectedDeviceId,
    clock: () => {
      const player = usePlayerStore.getState();
      return {
        playing: player.isPlaying,
        time: getEngine().getCurrentTime(),
        latencyS: calibratedLatencyS(player.recordingOffsets, player.selectedDeviceId),
      };
    },
    trace: liveTrace,
    publish,
    lost,
    every: (callback, ms) => window.setInterval(callback, ms),
    cancelEvery: (id) => window.clearInterval(id),
  }),
  () => {
    const player = usePlayerStore.getState();
    return player.isRecording || player.isSavingTake || player.isCountingIn ? "Stop recording before listening to the input." : null;
  },
);

// startRecording releases the input first through the gate (the player store cannot import this one).
liveMonitorGate.stop = () => useLiveInput.getState().stop();

// A different input chosen while listening: listen to that one.
usePlayerStore.subscribe((state, previous) => {
  if (state.selectedDeviceId === previous.selectedDeviceId || useLiveInput.getState().status !== "on") return;
  useLiveInput.getState().stop();
  void useLiveInput.getState().start();
});
