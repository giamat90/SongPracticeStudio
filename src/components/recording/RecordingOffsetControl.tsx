import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";

const N_COUNTIN = 4;
const N_MEASURED = 8;
const INTERVAL_S = 1.0;
const FIRST_CLICK_S = 0.5; // gap before first click once recording starts

// Confidence classification of the clap-spread MAD (median absolute deviation).
const MAD_HIGH_CONFIDENCE_MS = 5;
const MAD_MEDIUM_CONFIDENCE_MS = 15;
// Sanity bounds — a measurement outside these is a detection failure, not a latency.
const MIN_DETECTED_CLAPS = 5;
const MAX_OFFSET_MS = 500; // matches the manual input's range

type CalibPhase = "idle" | "counting" | "measuring" | "analyzing" | "done" | "error";

type Confidence = "high" | "medium" | "low";

function confidenceOf(madMs: number): Confidence {
  if (madMs <= MAD_HIGH_CONFIDENCE_MS) return "high";
  if (madMs <= MAD_MEDIUM_CONFIDENCE_MS) return "medium";
  return "low";
}

interface ClapDetection {
  medianMs: number;
  madMs: number;
  detectedCount: number;
  offsets: number[]; // raw per-clap offsets, kept for rejection diagnostics
}

function scheduleClick(ctx: AudioContext, atTime: number, isCountIn: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = isCountIn ? 880 : 1320;
  gain.gain.setValueAtTime(0, atTime);
  gain.gain.linearRampToValueAtTime(isCountIn ? 0.2 : 0.4, atTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, atTime + 0.08);
  osc.start(atTime);
  osc.stop(atTime + 0.09);
}

// Some interfaces (e.g. 2-in USB devices) only route the input to one physical
// channel — same issue buildChannelFixGraph() works around in recorder.ts, but
// this calibration flow records its own raw stream, so pick the loudest channel
// here instead of assuming channel 0.
function pickLoudestChannel(buffer: AudioBuffer): Float32Array {
  let best = buffer.getChannelData(0);
  let bestPeak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak > bestPeak) {
      bestPeak = peak;
      best = data;
    }
  }
  return best;
}

// Returns the measured round-trip latency plus its spread and detection count,
// or null when the recording contains no usable signal. Range/count validation
// happens at the caller so rejections can surface diagnostics.
function detectLatencyMs(buffer: AudioBuffer): ClapDetection | null {
  const samples = pickLoudestChannel(buffer);
  const sr = buffer.sampleRate;
  // 1 ms hop, 5 ms RMS frame
  const hop = Math.round(sr / 1000);
  const frame = hop * 5;
  const numFrames = Math.ceil(samples.length / hop);

  const env = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const s = i * hop;
    const e = Math.min(s + frame, samples.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += samples[j] * samples[j];
    env[i] = Math.sqrt(sum / (e - s));
  }

  let maxVal = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > maxVal) maxVal = env[i];
  if (maxVal < 0.005) return null;
  const threshold = maxVal * 0.15;

  // Onset (rising-edge) detection — first frame crossing above threshold,
  // minimum 300 ms between onsets (1 frame = 1 ms). A strict local-maximum test
  // misses low-frequency/slow-attack sources (e.g. bass) whose RMS envelope
  // plateaus near its peak instead of spiking like a clap.
  const peaks: number[] = [];
  let above = false;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > threshold) {
      if (!above && (peaks.length === 0 || i - peaks[peaks.length - 1] > 300)) {
        peaks.push(i);
      }
      above = true;
    } else {
      above = false;
    }
  }

  // Expected click positions in the recording (ms): first click at FIRST_CLICK_S,
  // then after N_COUNTIN count-in beats, N_MEASURED beats are the measurement targets.
  const offsets: number[] = [];
  for (let i = 0; i < N_MEASURED; i++) {
    const expectedMs = Math.round((FIRST_CLICK_S + (N_COUNTIN + i) * INTERVAL_S) * 1000);
    // Search window: -100 ms to +500 ms around expected position
    const candidates = peaks.filter(p => p >= expectedMs - 100 && p <= expectedMs + 500);
    if (candidates.length === 0) continue;
    const closest = candidates.reduce((a, b) =>
      Math.abs(a - expectedMs) < Math.abs(b - expectedMs) ? a : b,
    );
    offsets.push(closest - expectedMs);
  }

  if (offsets.length === 0) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((o) => Math.abs(o - medianMs)).sort((a, b) => a - b);
  const madMs = deviations[Math.floor(deviations.length / 2)];
  return { medianMs, madMs, detectedCount: offsets.length, offsets };
}

function RecordingOffsetControl() {
  const audioDevices = usePlayerStore((s) => s.audioDevices);
  const selectedDeviceId = usePlayerStore((s) => s.selectedDeviceId);
  const recordingOffsets = usePlayerStore((s) => s.recordingOffsets);
  const setRecordingOffset = usePlayerStore((s) => s.setRecordingOffset);
  const applyCalibration = usePlayerStore((s) => s.applyCalibration);
  const fetchAudioDevices = usePlayerStore((s) => s.fetchAudioDevices);

  const [phase, setPhase] = useState<CalibPhase>("idle");
  const [calibTargetId, setCalibTargetId] = useState<string>("");
  const [countdown, setCountdown] = useState(0);
  const [measuredCount, setMeasuredCount] = useState(0);
  const [result, setResult] = useState<ClapDetection | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    fetchAudioDevices();
    return () => { cancelledRef.current = true; };
  }, []);

  const micDeviceId = selectedDeviceId ?? "";

  const startCalibration = async (targetDeviceId: string) => {
    cancelledRef.current = false;
    setCalibTargetId(targetDeviceId);
    setPhase("counting");
    setCountdown(N_COUNTIN);
    setMeasuredCount(0);
    setResult(null);
    setErrorMsg("");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(targetDeviceId ? { deviceId: { exact: targetDeviceId } } : {}),
          echoCancellation: { exact: false },
          noiseSuppression: { exact: false },
          autoGainControl: { exact: false },
        },
        video: false,
      });
    } catch (e) {
      console.error("[calibration] getUserMedia failed:", e);
      setErrorMsg("Audio input unavailable: " + (e instanceof Error ? e.message : String(e)));
      setPhase("error");
      return;
    }

    const mimeType =
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      ) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = (e) => console.error("[calibration] MediaRecorder error:", e);

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    recorder.start(100);
    const schedBase = ctx.currentTime;
    const firstClickCtx = schedBase + FIRST_CLICK_S;

    for (let i = 0; i < N_COUNTIN + N_MEASURED; i++) {
      const clickCtx = firstClickCtx + i * INTERVAL_S;
      scheduleClick(ctx, clickCtx, i < N_COUNTIN);
      const uiDelayMs = (clickCtx - schedBase) * 1000;
      const ci = i;
      setTimeout(() => {
        if (cancelledRef.current) return;
        if (ci < N_COUNTIN) {
          setCountdown(N_COUNTIN - ci);
          setPhase("counting");
        } else {
          setMeasuredCount(ci - N_COUNTIN + 1);
          setPhase("measuring");
        }
      }, uiDelayMs);
    }

    // Stop 1.5 s after the last click to capture the last clap
    const totalDurationMs =
      (FIRST_CLICK_S + (N_COUNTIN + N_MEASURED - 1) * INTERVAL_S + 1.5) * 1000;

    setTimeout(async () => {
      if (cancelledRef.current) return;
      setPhase("analyzing");

      const blob = await new Promise<Blob>((resolve) => {
        const mtype = recorder.mimeType;
        recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: mtype }));
        if (recorder.state === "recording") recorder.stop();
        else resolve(new Blob(chunksRef.current, { type: mtype }));
      });

      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch((e: unknown) => console.warn("[calibration] ctx close:", e));
      ctxRef.current = null;

      if (cancelledRef.current) return;

      try {
        const arrayBuf = await blob.arrayBuffer();
        const decCtx = new AudioContext();
        const audioBuf = await decCtx.decodeAudioData(arrayBuf);
        decCtx.close().catch((e: unknown) => console.warn("[calibration] decCtx close:", e));

        if (cancelledRef.current) return;

        const detection = detectLatencyMs(audioBuf);
        if (detection === null) {
          setErrorMsg("Could not detect a clear sound — clap, tap, or pluck sharply on each click and try again.");
          setPhase("error");
        } else if (
          detection.medianMs < 0 ||
          detection.medianMs > MAX_OFFSET_MS ||
          detection.detectedCount < MIN_DETECTED_CLAPS
        ) {
          console.debug("[calibration] rejected:", {
            medianMs: detection.medianMs,
            madMs: detection.madMs,
            detectedCount: detection.detectedCount,
            offsets: detection.offsets,
          });
          setErrorMsg(
            "Calibration failed — measured value out of range / too few sounds detected. Try again in a quieter room.",
          );
          setPhase("error");
        } else {
          setResult(detection);
          setPhase("done");
        }
      } catch (e) {
        console.error("[calibration] analysis error:", e);
        if (!cancelledRef.current) {
          setErrorMsg("Analysis failed: " + (e instanceof Error ? e.message : String(e)));
          setPhase("error");
        }
      }
    }, totalDurationMs);
  };

  const cancel = () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    ctxRef.current?.close().catch((e: unknown) =>
      console.warn("[calibration] ctx close on cancel:", e),
    );
    ctxRef.current = null;
    recorderRef.current = null;
    setPhase("idle");
  };

  const applyResult = () => {
    if (result !== null) {
      applyCalibration(calibTargetId, {
        offset: result.medianMs,
        madMs: result.madMs,
      });
    }
    setPhase("idle");
  };

  const devices = [
    { deviceId: "", label: "Default microphone" },
    ...audioDevices,
  ];

  const isActive = phase !== "idle" && phase !== "done" && phase !== "error";

  return (
    <div className="rec-offset">
      <h3 className="rec-offset__title">Recording Latency Compensation</h3>

      {!isActive && (
        <>
          <p className="rec-offset__hint">
            Compensation applied per device before saving each take (0 = auto-detected ~20 ms).
            Use <strong>Calibrate</strong> to measure automatically — clap, tap the mic, or pluck
            a string on each click; any sharp, loud sound works, so this also suits instrument
            inputs with no mic attached.
          </p>
          <div className="rec-offset__list">
            {devices.map((d) => {
              const entry = recordingOffsets[d.deviceId];
              return (
                <div
                  key={d.deviceId}
                  className={`rec-offset__row${d.deviceId === micDeviceId ? " rec-offset__row--active" : ""}`}
                >
                  <span className="rec-offset__name">
                    {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
                  </span>
                  {entry?.stale ? (
                    <span className="rec-offset__chip rec-offset__chip--stale" title="A device this calibration was measured with is no longer connected">
                      stale
                    </span>
                  ) : entry?.madMs !== undefined ? (
                    <span
                      className={`rec-offset__chip rec-offset__chip--${confidenceOf(entry.madMs)}`}
                      title={`Measurement spread (MAD): ${entry.madMs} ms`}
                    >
                      {confidenceOf(entry.madMs)}
                    </span>
                  ) : null}
                  <input
                    type="number"
                    className="rec-offset__input"
                    value={entry?.offset ?? 0}
                    min={0}
                    max={MAX_OFFSET_MS}
                    step={1}
                    onChange={(e) =>
                      setRecordingOffset(d.deviceId, parseInt(e.target.value) || 0)
                    }
                  />
                  <span className="rec-offset__unit">ms</span>
                  <button
                    className="rec-offset__row-calib-btn"
                    onClick={() => startCalibration(d.deviceId)}
                    title={`Calibrate latency for ${d.label || "this device"}`}
                    aria-label={`Calibrate latency for ${d.label || "this device"}`}
                  >
                    Cal
                  </button>
                </div>
              );
            })}
          </div>

          {phase === "idle" && (recordingOffsets[micDeviceId] === undefined || recordingOffsets[micDeviceId]?.stale) && (
            <div className="rec-offset__banner rec-offset__banner--warn">
              <span>
                {recordingOffsets[micDeviceId]?.stale
                  ? "Your audio setup changed — recalibrate?"
                  : "This input hasn't been calibrated — measure its latency?"}
              </span>
              <div className="rec-offset__banner-actions">
                <button className="rec-offset__banner-btn" onClick={() => startCalibration(micDeviceId)}>
                  Calibrate
                </button>
              </div>
            </div>
          )}

          {phase === "done" && result !== null && (
            <div className="rec-offset__banner rec-offset__banner--ok">
              <span>
                Measured: <strong>{result.medianMs} ms</strong>{" "}
                <span
                  className={`rec-offset__chip rec-offset__chip--${confidenceOf(result.madMs)}`}
                  title={`Measurement spread (MAD): ${result.madMs} ms over ${result.detectedCount}/${N_MEASURED} sounds`}
                >
                  {confidenceOf(result.madMs)} confidence
                </span>
              </span>
              {confidenceOf(result.madMs) === "low" && (
                <span className="rec-offset__banner-hint">
                  Measurements varied a lot — consider re-running in a quieter room with short, sharp sounds.
                </span>
              )}
              <div className="rec-offset__banner-actions">
                <button className="rec-offset__banner-btn" onClick={applyResult}>
                  Apply to {devices.find((d) => d.deviceId === calibTargetId)?.label?.split("(")[0].trim() ?? "device"}
                </button>
                <button
                  className="rec-offset__banner-btn rec-offset__banner-btn--ghost"
                  onClick={() => setPhase("idle")}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
          {phase === "error" && (
            <div className="rec-offset__banner rec-offset__banner--err">
              <span>{errorMsg}</span>
              <button
                className="rec-offset__banner-btn rec-offset__banner-btn--ghost"
                onClick={() => setPhase("idle")}
              >
                Close
              </button>
            </div>
          )}
        </>
      )}

      {isActive && (
        <div className="rec-offset__active">
          <p className="rec-offset__active-device">
            {devices.find((d) => d.deviceId === calibTargetId)?.label?.split("(")[0].trim() ?? "Default microphone"}
          </p>
          {phase === "counting" && (
            <>
              <p className="rec-offset__active-label">Count-in — get ready to make a sharp sound (clap, tap, or pluck)</p>
              <div className="rec-offset__active-count">{countdown}</div>
            </>
          )}
          {phase === "measuring" && (
            <>
              <p className="rec-offset__active-label">Clap, tap, or pluck in time with each click!</p>
              <div className="rec-offset__active-count">
                {measuredCount}
                <span className="rec-offset__active-total"> / {N_MEASURED}</span>
              </div>
            </>
          )}
          {phase === "analyzing" && (
            <p className="rec-offset__active-label">Analyzing…</p>
          )}
          <button className="rec-offset__cancel-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default RecordingOffsetControl;
