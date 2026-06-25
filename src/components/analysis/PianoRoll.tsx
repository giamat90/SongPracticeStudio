import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { getEngine, usePlayerStore } from "../../stores/player";
import { frequencyToMidi, NOTE_NAMES } from "../../lib/constants";
import type { PitchPoint } from "../../lib/types";
import { getCurrentMidi, COLOR_SONG, COLOR_TAKE, COLOR_LIVE } from "./PianoKeyboard";

// ─── constants ───────────────────────────────────────────────────────────────

const PIANO_W   = 36;       // px width of the piano key strip
const WINDOW_S  = 8;        // seconds visible at once
const MIDI_MIN  = 45;       // A2  — bottom of visible range
const MIDI_MAX  = 84;       // C6  — top of visible range
const N_NOTES   = MIDI_MAX - MIDI_MIN + 1;
const CONF_MIN  = 0.3;
const GAP_S     = 0.08;     // gap threshold: breaks the ribbon
const HANDLE_HIT = 8;       // px around a handle that counts as a hit

const BLACK_PC  = new Set([1, 3, 6, 8, 10]);   // pitch classes that are black keys

// ─── geometry helpers ────────────────────────────────────────────────────────

function noteH(H: number): number {
  return H / N_NOTES;
}

function midiToY(midi: number, H: number): number {
  return ((MIDI_MAX - midi) / N_NOTES) * H + noteH(H) / 2;
}

function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

// ─── draw passes ─────────────────────────────────────────────────────────────

function drawLanes(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const nh = noteH(H);
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    const y  = midiToY(m, H);
    const top = y - nh / 2;
    ctx.fillStyle = isBlack(m) ? "#0c0c1e" : "#141428";
    ctx.fillRect(PIANO_W, top, W - PIANO_W, nh);

    // Subtle horizontal rule on every white-key boundary
    if (!isBlack(m)) {
      ctx.fillStyle = "#ffffff09";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 0.5);
    }

    // Stronger line at every C (octave boundary)
    if ((m % 12) === 0) {
      ctx.fillStyle = "#ffffff1a";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 1);
    }
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = PIANO_W + (W - PIANO_W) / 2;
  ctx.save();
  ctx.strokeStyle = "#ffffff30";
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.restore();
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  points: PitchPoint[],
  color: string,
  t0: number,
  t1: number,
  H: number,
  timeToX: (t: number) => number,
): void {
  const nh = noteH(H);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(2.5, nh * 0.72);
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";

  let penDown = false;
  ctx.beginPath();

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    const outOfConf  = p.confidence < CONF_MIN || p.frequency <= 0;
    const outOfTime  = p.time < t0 - 0.1 || p.time > t1 + 0.1;
    const midi       = frequencyToMidi(p.frequency);
    const outOfRange = midi < MIDI_MIN || midi > MIDI_MAX;

    if (outOfConf || outOfTime || outOfRange) {
      penDown = false;
      continue;
    }

    // Gap detection: break line on silence/unvoiced sections
    const prev = points[i - 1];
    if (prev && p.time - prev.time > GAP_S) {
      penDown = false;
    }

    const x = timeToX(p.time);
    const y = midiToY(midi, H);

    if (!penDown) {
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawPianoStrip(
  ctx: CanvasRenderingContext2D,
  H: number,
  songMidi: number | null,
  takeMidi: number | null,
  liveMidi: number | null,
): void {
  const nh = noteH(H);

  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    const y      = midiToY(m, H);
    const top    = y - nh / 2;
    const blk    = isBlack(m);
    const isSong = m === songMidi;
    const isTake = m === takeMidi;
    const isLive = m === liveMidi;

    if (blk) {
      ctx.fillStyle = isLive ? COLOR_LIVE : isTake ? COLOR_TAKE : isSong ? COLOR_SONG : "#1c1c1c";
      ctx.fillRect(1, top + 0.5, PIANO_W * 0.60, nh - 1);
    } else {
      ctx.fillStyle = isLive ? COLOR_LIVE : isTake ? COLOR_TAKE : isSong ? COLOR_SONG : "#c8c8c8";
      ctx.fillRect(1, top + 0.5, PIANO_W - 3, nh - 1);

      if ((m % 12) === 0) {
        const octave = Math.floor(m / 12) - 1;
        const fs = Math.max(7, Math.min(10, nh * 0.78));
        ctx.fillStyle    = isSong || isTake || isLive ? "#fff" : "#444";
        ctx.font         = `${fs}px sans-serif`;
        ctx.textAlign    = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${octave}`, PIANO_W - 4, y);
      }
    }
  }

  ctx.fillStyle = "#333";
  ctx.fillRect(PIANO_W - 1, 0, 1, H);
}

// Note label drawn at top-right of the roll area (feature 2)
function drawNoteLabel(
  ctx: CanvasRenderingContext2D,
  W: number,
  songPitch: PitchPoint[],
  takePitch: PitchPoint[],
  livePitch: PitchPoint[],
  currentTime: number,
): void {
  const getNote = (pts: PitchPoint[]): string | null => {
    const near = pts.filter(
      (p) =>
        Math.abs(p.time - currentTime) < 0.06 &&
        p.confidence >= CONF_MIN &&
        p.frequency > 0,
    );
    if (near.length === 0) return null;
    const avgMidi = near.reduce((s, p) => s + frequencyToMidi(p.frequency), 0) / near.length;
    const m = Math.round(avgMidi);
    return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  };

  const songNote = getNote(songPitch);
  const takeNote = getNote(takePitch);
  const liveNote = getNote(livePitch);
  if (!songNote && !takeNote && !liveNote) return;

  ctx.save();
  ctx.font         = "bold 11px monospace";
  ctx.textBaseline = "top";
  ctx.textAlign    = "right";

  const y = 5;
  let x = W - 6;

  // Draw right-to-left so reading order is Song → Take → Live
  if (liveNote) {
    ctx.fillStyle = COLOR_LIVE;
    ctx.fillText(liveNote, x, y);
    x -= ctx.measureText(liveNote).width + 10;
  }
  if (takeNote) {
    ctx.fillStyle = COLOR_TAKE;
    ctx.fillText(takeNote, x, y);
    x -= ctx.measureText(takeNote).width + 10;
  }
  if (songNote) {
    ctx.fillStyle = COLOR_SONG;
    ctx.fillText(songNote, x, y);
  }
  ctx.restore();
}

// Piano roll time ruler (feature 3)
function drawRuler(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  currentTime: number,
  punchInT: number | null,
  punchOutT: number | null,
): void {
  const rollW = W - PIANO_W;
  const t0 = currentTime - WINDOW_S / 2;
  const tX = (t: number) => PIANO_W + ((t - t0) / WINDOW_S) * rollW;

  ctx.fillStyle = "#0d1b2e";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  // Punch region overlay
  if (punchInT !== null && punchOutT !== null && punchOutT > punchInT) {
    const xL = tX(punchInT);
    const xR = tX(punchOutT);
    const visL = Math.max(PIANO_W, xL);
    const visR = Math.min(W, xR);
    if (visR > visL) {
      ctx.fillStyle = "rgba(233,69,96,0.22)";
      ctx.fillRect(visL, 0, visR - visL, H);
    }
    if (xL >= PIANO_W && xL <= W) {
      ctx.strokeStyle = "rgba(233,69,96,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xL, 0); ctx.lineTo(xL, H); ctx.stroke();
      ctx.fillStyle = "rgba(233,69,96,0.9)";
      ctx.fillRect(xL - 3, 0, 6, 4);
    }
    if (xR >= PIANO_W && xR <= W) {
      ctx.strokeStyle = "rgba(233,69,96,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xR, 0); ctx.lineTo(xR, H); ctx.stroke();
      ctx.fillStyle = "rgba(233,69,96,0.9)";
      ctx.fillRect(xR - 3, 0, 6, 4);
    }
  }

  // Time tick marks — adaptive interval targeting ~60 px spacing
  const raw = (WINDOW_S / Math.max(1, rollW)) * 60;
  let interval = 5;
  for (const n of [0.25, 0.5, 1, 2, 5]) {
    if (n >= raw) { interval = n; break; }
  }
  const firstTick = Math.ceil(t0 / interval) * interval;
  ctx.font = "9px monospace";
  for (let t = firstTick; t <= t0 + WINDOW_S + 0.001; t += interval) {
    const x = Math.round(tX(t));
    if (x < PIANO_W || x > W) continue;
    ctx.strokeStyle = "#3a4a5e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, H * 0.4);
    ctx.stroke();
    const secs = Math.max(0, t);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    ctx.fillStyle = "#7a8a9e";
    ctx.textAlign = "left";
    ctx.fillText(`${m}:${s.toString().padStart(2, "0")}`, x + 2, H * 0.6);
  }

  // Center playhead tick
  const cx = PIANO_W + rollW / 2;
  ctx.save();
  ctx.strokeStyle = "#ffffff40";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "#2a3a4e";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
}

// ─── component ───────────────────────────────────────────────────────────────

export default function PianoRoll() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const rulerRef    = useRef<HTMLCanvasElement>(null);
  const songPitch   = useAnalysisStore((s) => s.songPitch);
  const takePitch   = useAnalysisStore((s) => s.takePitch);
  const livePitch   = useAnalysisStore((s) => s.livePitch);
  const isLoaded    = useAnalysisStore((s) => s.isLoaded);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const punchIn     = usePlayerStore((s) => s.punchIn);
  const punchOut    = usePlayerStore((s) => s.punchOut);
  const punchLoop   = usePlayerStore((s) => s.punchLoop);
  const duration    = usePlayerStore((s) => s.duration);
  const setPunchIn  = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut = usePlayerStore((s) => s.setPunchOut);
  const clearPunch  = usePlayerStore((s) => s.clearPunch);
  const setPunchLoop = usePlayerStore((s) => s.setPunchLoop);
  const seek        = usePlayerStore((s) => s.seek);

  const drawRef = useRef<() => void>(() => {});

  // Ruler drag state (punch region creation/editing)
  const rulerDrag = useRef<{
    mode: "create" | "drag-in" | "drag-out" | null;
    anchorT: number;
    capturedT0: number;
  }>({ mode: null, anchorT: 0, capturedT0: 0 });

  // Live override for in-progress ruler drag (so rAF shows preview before store commit)
  const rulerOverride = useRef<{ inT: number | null; outT: number | null } | null>(null);

  // Main canvas drag-to-seek state (feature 4)
  const rollDrag = useRef<{ active: boolean; startX: number; startTime: number }>({
    active: false,
    startX: 0,
    startTime: 0,
  });

  // Rebuild draw function whenever pitch data or punch state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      // ── ruler ──────────────────────────────────────────────────────────────
      const ruler = rulerRef.current;
      if (ruler) {
        const rW = ruler.offsetWidth || 600;
        const rH = ruler.offsetHeight || 20;
        if (ruler.width !== rW || ruler.height !== rH) {
          ruler.width  = rW;
          ruler.height = rH;
        }
        const rCtx = ruler.getContext("2d");
        if (rCtx) {
          const ct = getEngine().getCurrentTime();
          const ov = rulerOverride.current;
          drawRuler(
            rCtx, rW, rH, ct,
            ov ? ov.inT : punchIn,
            ov ? ov.outT : punchOut,
          );
        }
      }

      // ── main piano roll ────────────────────────────────────────────────────
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const W = canvas.offsetWidth  || 600;
      const H = canvas.offsetHeight || 240;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      if (!isLoaded || songPitch.length === 0) {
        ctx.fillStyle    = "#a0a0b060";
        ctx.font         = "11px sans-serif";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No pitch data", (PIANO_W + W) / 2, H / 2);
        drawPianoStrip(ctx, H, null, null, null);
        return;
      }

      const currentTime = getEngine().getCurrentTime();
      const t0 = currentTime - WINDOW_S / 2;
      const t1 = currentTime + WINDOW_S / 2;
      const rollW = W - PIANO_W;
      const timeToX = (t: number) =>
        PIANO_W + ((t - currentTime + WINDOW_S / 2) / WINDOW_S) * rollW;

      const songMidi = getCurrentMidi(songPitch, currentTime);
      const takeMidi = getCurrentMidi(takePitch, currentTime);
      const liveMidi = getCurrentMidi(livePitch, currentTime);

      drawLanes(ctx, W, H);
      drawRibbon(ctx, songPitch, COLOR_SONG, t0, t1, H, timeToX);
      if (takePitch.length > 0) {
        drawRibbon(ctx, takePitch, COLOR_TAKE, t0, t1, H, timeToX);
      }
      if (livePitch.length > 0) {
        drawRibbon(ctx, livePitch, COLOR_LIVE, t0, t1, H, timeToX);
      }
      drawPlayhead(ctx, W, H);
      drawNoteLabel(ctx, W, songPitch, takePitch, livePitch, currentTime);
      drawPianoStrip(ctx, H, songMidi, takeMidi, liveMidi);
    };

    drawRef.current();
  }, [songPitch, takePitch, livePitch, isLoaded, punchIn, punchOut]);

  // rAF loop — no React re-renders during playback
  useEffect(() => {
    if (!isLoaded) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded]);

  // ResizeObserver — single mount; watches both canvases
  useEffect(() => {
    const canvas = canvasRef.current;
    const ruler  = rulerRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    if (ruler) ro.observe(ruler);
    return () => ro.disconnect();
  }, []);

  // ── ruler mouse handlers (punch region) ─────────────────────────────────────

  const onRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording) return;
    const canvas = rulerRef.current;
    if (!canvas) return;
    e.preventDefault();

    const rollW = canvas.offsetWidth - PIANO_W;
    const capturedT0 = getEngine().getCurrentTime() - WINDOW_S / 2;
    const x = e.nativeEvent.offsetX;
    const xToT = (px: number) => capturedT0 + ((px - PIANO_W) / rollW) * WINDOW_S;
    const tX   = (t: number)  => PIANO_W + ((t - capturedT0) / WINDOW_S) * rollW;

    let mode: "create" | "drag-in" | "drag-out" = "create";
    let anchorT = xToT(x);

    if (punchIn !== null && punchOut !== null) {
      const xi = tX(punchIn);
      const xo = tX(punchOut);
      if (Math.abs(x - xi) <= HANDLE_HIT)      { mode = "drag-in";  anchorT = punchOut; }
      else if (Math.abs(x - xo) <= HANDLE_HIT) { mode = "drag-out"; anchorT = punchIn;  }
    }

    rulerDrag.current = { mode, anchorT, capturedT0 };
    const t = xToT(x);
    if (mode === "create")   rulerOverride.current = { inT: t,       outT: t       };
    else if (mode === "drag-in")  rulerOverride.current = { inT: t,  outT: punchOut };
    else                     rulerOverride.current = { inT: punchIn, outT: t        };
  };

  const onRulerMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = rulerRef.current;
    if (!canvas) return;
    const { mode, anchorT, capturedT0 } = rulerDrag.current;
    const rollW = canvas.offsetWidth - PIANO_W;
    const xToT  = (px: number) => capturedT0 + ((px - PIANO_W) / rollW) * WINDOW_S;
    const t = xToT(e.nativeEvent.offsetX);

    if (!mode) {
      // Hover: update cursor near handles
      if (!isRecording && punchIn !== null && punchOut !== null) {
        const ct = getEngine().getCurrentTime();
        const t0live = ct - WINDOW_S / 2;
        const tXlive = (time: number) => PIANO_W + ((time - t0live) / WINDOW_S) * rollW;
        const xi = tXlive(punchIn);
        const xo = tXlive(punchOut);
        const x = e.nativeEvent.offsetX;
        canvas.style.cursor =
          Math.abs(x - xi) <= HANDLE_HIT || Math.abs(x - xo) <= HANDLE_HIT
            ? "ew-resize"
            : "crosshair";
      }
      return;
    }

    if (mode === "create") {
      rulerOverride.current = { inT: Math.min(anchorT, t), outT: Math.max(anchorT, t) };
    } else if (mode === "drag-in") {
      rulerOverride.current = { inT: Math.min(t, anchorT - 0.1), outT: anchorT };
    } else {
      rulerOverride.current = { inT: anchorT, outT: Math.max(t, anchorT + 0.1) };
    }
  };

  const onRulerMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = rulerRef.current;
    if (!canvas) return;
    const { mode, anchorT, capturedT0 } = rulerDrag.current;
    if (!mode) return;
    rulerDrag.current.mode = null;

    const rollW = canvas.offsetWidth - PIANO_W;
    const t = capturedT0 + ((e.nativeEvent.offsetX - PIANO_W) / rollW) * WINDOW_S;

    if (mode === "drag-in") {
      setPunchIn(Math.round(Math.min(t, anchorT - 0.1) * 10) / 10);
    } else if (mode === "drag-out") {
      setPunchOut(Math.round(Math.max(t, anchorT + 0.1) * 10) / 10);
    } else {
      const inT  = Math.min(anchorT, t);
      const outT = Math.max(anchorT, t);
      if (outT - inT < 0.5) {
        clearPunch();
      } else {
        setPunchIn(Math.round(inT * 10) / 10);
        setPunchOut(Math.round(outT * 10) / 10);
      }
    }

    rulerOverride.current = null;
    canvas.style.cursor = isRecording ? "default" : "crosshair";
  };

  const onRulerMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (rulerDrag.current.mode) onRulerMouseUp(e);
    else if (rulerRef.current) rulerRef.current.style.cursor = "default";
  };

  // ── main canvas drag-to-seek (feature 4) ────────────────────────────────────

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording) return;
    rollDrag.current = {
      active: true,
      startX: e.nativeEvent.offsetX,
      startTime: getEngine().getCurrentTime(),
    };
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!rollDrag.current.active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rollW = canvas.offsetWidth - PIANO_W;
    if (rollW <= 0) return;
    const { startX, startTime } = rollDrag.current;
    // Drag right → earlier time; drag left → later time (pan-content gesture)
    const deltaT = -((e.nativeEvent.offsetX - startX) / rollW) * WINDOW_S;
    seek(Math.max(0, Math.min(duration, startTime + deltaT)));
  };

  const onCanvasMouseUp = () => { rollDrag.current.active = false; };

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Piano Roll</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {takePitch.length > 0 && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Your voice</span>
            </>
          )}
          {isRecording && (
            <>
              <span className="legend-dot legend-dot--live" />
              <span>Live</span>
            </>
          )}
        </div>
      </div>
      <div className="piano-roll__ruler-wrap">
        <canvas
          ref={rulerRef}
          className="piano-roll__ruler"
          onMouseDown={onRulerMouseDown}
          onMouseMove={onRulerMouseMove}
          onMouseUp={onRulerMouseUp}
          onMouseLeave={onRulerMouseLeave}
          style={{ cursor: isRecording ? "default" : "crosshair" }}
        />
        {punchIn !== null && punchOut !== null && !isRecording && (
          <button
            className={`time-ruler__loop-btn${punchLoop ? " time-ruler__loop-btn--active" : ""}`}
            title={punchLoop ? "Disable loop" : "Loop region"}
            onClick={() => setPunchLoop(!punchLoop)}
          >
            ⟳
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        className="analysis-panel__canvas analysis-panel__canvas--piano-roll"
        style={{ cursor: isRecording ? "default" : "grab" }}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
      />
    </div>
  );
}
