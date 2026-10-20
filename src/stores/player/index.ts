import { create } from "zustand";
import { pushTakeAudio, takeAudioInputsChanged } from "./audioMix";
import { createChordsSlice } from "./chordsSlice";
import { createDevicesSlice } from "./devicesSlice";
import { createMeterSlice } from "./meterSlice";
import { createMixerSlice } from "./mixerSlice";
import { createRecordingSlice } from "./recordingSlice";
import { createTakesSlice } from "./takesSlice";
import { createTimelineSlice } from "./timelineSlice";
import { createTransportSlice } from "./transportSlice";
import type { PlayerStore } from "./types";

export { TAKE_TRACK_KEY, buildMixSources, effectiveStemGain, takesSilenced } from "./audioMix";
export { MAX_CAPO_FRET } from "./prefs";
export { getEngine } from "./singletons";
export type { CalibrationEntry } from "./types";

export const usePlayerStore = create<PlayerStore>()((...a) => ({
  ...createTransportSlice(...a),
  ...createMixerSlice(...a),
  ...createTimelineSlice(...a),
  ...createDevicesSlice(...a),
  ...createRecordingSlice(...a),
  ...createTakesSlice(...a),
  ...createChordsSlice(...a),
  ...createMeterSlice(...a),
}));

usePlayerStore.subscribe((state, prev) => {
  if (takeAudioInputsChanged(state, prev)) pushTakeAudio(state);
});
