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

// Count-in scheduling handles — module-level so cancelCountIn (a separate
// store action) can reach across and abort the setTimeout/interval that
// startRecording's in-flight promise is awaiting.
export const countIn: {
  timeoutId: number | null;
  intervalId: number | null;
  resolve: ((completed: boolean) => void) | null;
} = { timeoutId: null, intervalId: null, resolve: null };
