import { useRef, useEffect, useState } from "react";
import { PitchDetector } from "../../audio/pitchDetector";
import { useAnalysisStore } from "../../stores/analysis";
import { usePlayerStore } from "../../stores/player";
import { pitchAtTime, centsDeviation } from "../../audio/analysisUtils";
import { frequencyToNoteName } from "../../audio/analysisUtils";

// SVG gauge dimensions
const CX = 70;
const CY = 70;
const R = 55;
const MIN_ANGLE = -90; // degrees (-50 cents)
const MAX_ANGLE = 90;  // degrees (+50 cents)

function centsToAngle(cents: number): number {
  const clamped = Math.max(-50, Math.min(50, cents));
  return (clamped / 50) * 90;
}

function polarToXY(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function describeArc(startDeg: number, endDeg: number, r: number): string {
  const s = polarToXY(startDeg, r);
  const e = polarToXY(endDeg, r);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

export default function DualTuner() {
  const isRecording = usePlayerStore((s) => s.isRecording);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const songPitch = useAnalysisStore((s) => s.songPitch);
  const takePitch = useAnalysisStore((s) => s.takePitch);
  const appendLivePitch = useAnalysisStore((s) => s.appendLivePitch);
  const clearLivePitch  = useAnalysisStore((s) => s.clearLivePitch);

  const [liveCents, setLiveCents] = useState<number | null>(null);
  const [liveNote, setLiveNote] = useState<string>("");
  const detectorRef = useRef<PitchDetector | null>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  // Refs to always have latest values inside the animation frame loop
  const currentTimeRef   = useRef(currentTime);
  const songPitchRef     = useRef(songPitch);
  const appendLiveRef    = useRef(appendLivePitch);
  const clearLiveRef     = useRef(clearLivePitch);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { songPitchRef.current = songPitch; }, [songPitch]);
  useEffect(() => { appendLiveRef.current = appendLivePitch; }, [appendLivePitch]);
  useEffect(() => { clearLiveRef.current = clearLivePitch; }, [clearLivePitch]);

  // Start/stop live pitch detection during recording
  useEffect(() => {
    if (!isRecording) {
      if (detectorRef.current) {
        detectorRef.current.stop();
        detectorRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      cancelAnimationFrame(rafRef.current);
      clearLiveRef.current();
      setLiveCents(null);
      setLiveNote("");
      return;
    }

    clearLiveRef.current();

    let active = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const det = new PitchDetector();
      det.start(stream);
      detectorRef.current = det;

      const tick = () => {
        const reading = det.getCurrentPitch();
        if (reading) {
          setLiveNote(reading.name);
          const t = currentTimeRef.current;
          // Use refs to get the current time and pitch data without stale closure
          const ref = pitchAtTime(songPitchRef.current, t);
          if (ref && ref.frequency > 0) {
            setLiveCents(centsDeviation(reading.frequency, ref.frequency));
          } else {
            setLiveCents(reading.cents);
          }
          if (reading.frequency > 0) {
            appendLiveRef.current({ time: t, frequency: reading.frequency, confidence: 1.0 });
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }).catch(() => {});

    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [isRecording]);

  // Derive needle value
  let cents: number | null = null;
  let noteName = "—";
  let refName = "—";

  if (isRecording) {
    cents = liveCents;
    noteName = liveNote || "—";
    const ref = pitchAtTime(songPitch, currentTime);
    if (ref && ref.frequency > 0) refName = frequencyToNoteName(ref.frequency).name;
  } else if (takePitch.length > 0) {
    const tp = pitchAtTime(takePitch, currentTime);
    const sp = pitchAtTime(songPitch, currentTime);
    if (tp && sp && tp.confidence > 0.4 && sp.confidence > 0.4) {
      cents = centsDeviation(tp.frequency, sp.frequency);
      noteName = frequencyToNoteName(tp.frequency).name;
      refName = frequencyToNoteName(sp.frequency).name;
    }
  }

  const needleAngle = cents !== null ? centsToAngle(cents) : 0;
  const active = cents !== null;

  // Needle color
  const abs = Math.abs(cents ?? 0);
  const needleColor = !active ? "#404060" : abs < 15 ? "#4ade80" : abs < 30 ? "#fbbf24" : "#e94560";

  const needleEnd = polarToXY(needleAngle, R - 8);

  return (
    <div className="dual-tuner">
      <svg width={140} height={90} viewBox="0 0 140 90" className="dual-tuner__gauge">
        {/* Background arc */}
        <path
          d={describeArc(MIN_ANGLE, MAX_ANGLE, R)}
          fill="none"
          stroke="#1a1a2e"
          strokeWidth={10}
          strokeLinecap="round"
        />
        {/* Colored zones */}
        <path d={describeArc(-90, -45, R)} fill="none" stroke="#e9456040" strokeWidth={8} />
        <path d={describeArc(-45, -15, R)} fill="none" stroke="#fbbf2440" strokeWidth={8} />
        <path d={describeArc(-15, 15, R)} fill="none" stroke="#4ade8060" strokeWidth={8} />
        <path d={describeArc(15, 45, R)} fill="none" stroke="#fbbf2440" strokeWidth={8} />
        <path d={describeArc(45, 90, R)} fill="none" stroke="#e9456040" strokeWidth={8} />
        {/* Center tick */}
        <line
          x1={CX}
          y1={CY - R + 2}
          x2={CX}
          y2={CY - R + 10}
          stroke="#ffffff30"
          strokeWidth={1.5}
        />
        {/* Needle */}
        <line
          x1={CX}
          y1={CY}
          x2={needleEnd.x}
          y2={needleEnd.y}
          stroke={needleColor}
          strokeWidth={2}
          strokeLinecap="round"
          style={{ transition: active ? "none" : "stroke 0.3s" }}
        />
        <circle cx={CX} cy={CY} r={4} fill={needleColor} />
        {/* Labels */}
        <text x={14} y={82} fill="#a0a0b0" fontSize={8} textAnchor="middle">−50</text>
        <text x={126} y={82} fill="#a0a0b0" fontSize={8} textAnchor="middle">+50</text>
      </svg>

      <div className="dual-tuner__info">
        <span className="dual-tuner__ref">{refName}</span>
        <span className="dual-tuner__note" style={{ color: needleColor }}>{noteName}</span>
        {cents !== null && (
          <span className="dual-tuner__cents" style={{ color: needleColor }}>
            {cents > 0 ? "+" : ""}{Math.round(cents)}ct
          </span>
        )}
      </div>
    </div>
  );
}
