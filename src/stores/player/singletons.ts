import { AudioEngine } from "../../audio/engine";
import { VocalRecorder } from "@giamat90/mps-core/recorder";

let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;

export function getEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}

export function getRecorder(): VocalRecorder {
  if (!recorder) recorder = new VocalRecorder();
  return recorder;
}

export function disposeRecorder(): void {
  recorder?.dispose();
}

// startRecording and stopRecording are separate actions, so what one measures
// the other reads: where the take began, and the round-trip latency (output +
// input) measured at rec.start(), applied when the take is saved.
export const recordingSession = { startPos: 0, latencyS: 0 };

// The live monitor (stores/liveInput) registers how to stop itself here: startRecording gives the input back
// before it opens its own, and the player store cannot import the monitor's store (which imports the player store).
export const liveMonitorGate: { stop: (() => void) | null } = { stop: null };

// Where the playhead is, for what draws every frame (the meter lane, the overview). In the main window that is the
// audio engine; a detached window has no stems, so its bridge installs the mirrored clock instead.
let playheadSource: (() => number) | null = null;

export function getPlayheadTime(): number {
  return playheadSource ? playheadSource() : getEngine().getCurrentTime();
}

/** Returns the function that puts the engine back. */
export function installPlayheadSource(source: () => number): () => void {
  playheadSource = source;
  return () => {
    if (playheadSource === source) playheadSource = null;
  };
}
