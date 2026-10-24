import { showTake } from "@giamat90/mps-core/takes";
import type { AudioEngine } from "../../audio/engine";
import { saveTake } from "../../lib/tauri";
import type { Song } from "../../lib/types";
import { pushTakeAudio, selectionOf } from "./audioMix";
import { countInPlan } from "./countInSlice";
import { getEngine, getRecorder, liveMonitorGate, recordingSession } from "./singletons";
import type { Getter, RecordingSlice, Setter, Slice } from "./types";

// Takes shorter than this carry too little accumulated drift to be worth logging.
const DRIFT_CHECK_MIN_TAKE_S = 90;

export function recordingReset() {
  return { isRecording: false, isSavingTake: false };
}

// Opens the microphone and returns the input latency the browser reports.
async function openMic(set: Setter, get: Getter, eng: AudioEngine): Promise<number> {
  const rec = getRecorder();
  try {
    await rec.init(get().selectedDeviceId);
    // Re-enumerate after getUserMedia succeeds — browser now populates device labels
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    return (rec.getStream()?.getAudioTracks()[0].getSettings() as MediaTrackSettings & { latency?: number })?.latency ?? 0;
  } catch (e) {
    eng.setInteract(true);
    throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
  }
}

// Calibrated value takes full priority — skip AudioContext measurement when present.
// Stale entries (a device they were measured with disappeared) are not trusted.
function measureLatency(set: Setter, get: Getter, inputLatencyS: number): void {
  const calib = get().recordingOffsets[get().selectedDeviceId ?? ""];
  if (calib !== undefined && calib.offset > 0 && !calib.stale) {
    set({ usedLatencyFallback: false });
    recordingSession.latencyS = calib.offset / 1000;
    console.log("[recording] using calibrated compensation:", calib.offset, "ms");
    return;
  }
  if (calib !== undefined && calib.offset > 0) {
    console.warn("[recording] stored calibration is stale — falling back to AudioContext estimate");
  }
  set({ usedLatencyFallback: true });
  // No calibration: fall back to AudioContext round-trip estimate.
  try {
    const latencyCtx = new AudioContext();
    const outputLatencyS = (latencyCtx.outputLatency ?? 0) + (latencyCtx.baseLatency ?? 0);
    latencyCtx.close().catch((e: unknown) => console.warn("[latency] ctx close:", e));
    recordingSession.latencyS = outputLatencyS + inputLatencyS;
    console.log("[recording] latency — output:", outputLatencyS, "input:", inputLatencyS, "total:", recordingSession.latencyS);
  } catch (e) {
    console.warn("[recording] latency measurement failed, compensation disabled:", e);
    recordingSession.latencyS = 0;
  }
}

function beginCapture(get: Getter, eng: AudioEngine): void {
  eng.setInteract(false);
  // isRecording only flips afterwards; silence the takes first so none is heard in between.
  if (get().muteTakesWhileRecording) eng.setAudibleTakeTracks([]);
  try {
    eng.seekTo(recordingSession.startPos);
    eng.play();
    getRecorder().start();
  } catch (e) {
    // The takes were silenced above for a recording that did not start.
    pushTakeAudio(get());
    throw e;
  }
}

// Shift startPosition back by round-trip latency.
// When that pushes startPos below 0 (recording from song start), keep startPos at 0
// and store the remainder as audioOffset so a future consumer can skip that many
// seconds into the audio file to align take[audioOffset] with song position 0.
function compensate(startPos: number, latencyS: number): { startPosition: number; audioOffset: number } {
  const raw = startPos - latencyS;
  return { startPosition: Math.max(0, raw), audioOffset: raw < 0 ? -raw : 0 };
}

async function saveRecordedTake(set: Setter, get: Getter, song: Song, takeDurationS: number): Promise<void> {
  const blob = await getRecorder().stop();
  getRecorder().releaseStream();

  // Convert blob to byte array for Tauri
  const audioData = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const { startPosition, audioOffset } = compensate(recordingSession.startPos, recordingSession.latencyS);
  const take = await saveTake(song.id, audioData, startPosition, audioOffset);

  // Instrumentation only: correlate future misalignment reports with take length
  // before deciding whether within-take clock drift is worth correcting.
  if (takeDurationS > DRIFT_CHECK_MIN_TAKE_S) {
    console.info(
      `[drift-check] takeDuration=${takeDurationS.toFixed(1)}s input=${get().selectedDeviceId ?? "default"} output=${get().selectedOutputDeviceId ?? "default"}`,
    );
  }

  // Show and select the new take — StemView loads it into a lane of its
  // own; the takes already shown stay where they are.
  const next = showTake(selectionOf(get()), take.id);
  set((state) => ({
    isSavingTake: false,
    currentTime: 0,
    takes: [...state.takes, take],
    shownTakeIds: [...next.shown],
    activeTakeId: next.active,
  }));
}

export const createRecordingSlice: Slice<RecordingSlice> = (set, get) => ({
  isRecording: false,
  isSavingTake: false,

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    // With "mute takes while recording" on (the default), drop the selected take
    // before recording a new one: every take stays saved (takes.json is never
    // touched) and shown, but none is heard, so the performer records against the
    // stem mix alone — not their last attempt. With it off the takes keep playing
    // and the selection is left alone.
    if (get().muteTakesWhileRecording && get().activeTakeId) {
      set({ activeTakeId: null });
    }

    const eng = getEngine();
    // Honour punch-in: start recording from the punch point, not the playhead
    recordingSession.startPos = get().punchIn ?? eng.getCurrentTime();
    eng.pause();
    // eng.pause() only touches the engine, not the store — flip isPlaying
    // synchronously so TempoControl's metronome effect releases the shared
    // `metronome` singleton before the count-in below claims it.
    set({ isPlaying: false });

    liveMonitorGate.stop?.();
    const inputLatencyS = await openMic(set, get, eng);

    const bars = get().countInBars;
    if (bars > 0 && !(await get().runCountIn(countInPlan(get, recordingSession.startPos), "record"))) {
      // Cancelled mid-count — abandon this recording attempt, releasing
      // the mic already opened above.
      getRecorder().releaseStream();
      eng.setInteract(true);
      return;
    }

    beginCapture(get, eng);
    measureLatency(set, get, inputLatencyS);
    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    const takeDurationS = eng.getCurrentTime() - recordingSession.startPos;
    eng.stop();
    eng.setInteract(true);

    // Immediately flip recording off so the button stops pulsing,
    // then show a saving indicator while the blob is flushed to disk.
    set({ isRecording: false, isPlaying: false, isSavingTake: true });

    try {
      await saveRecordedTake(set, get, song, takeDurationS);
    } catch (e) {
      rec.releaseStream();
      set({ isSavingTake: false, currentTime: 0 });
      throw e;
    }
  },
});
