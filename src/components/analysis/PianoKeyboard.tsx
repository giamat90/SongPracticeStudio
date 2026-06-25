import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { getEngine, usePlayerStore } from "../../stores/player";
import { frequencyToMidi, NOTE_NAMES } from "../../lib/constants";
import type { PitchPoint } from "../../lib/types";

const MIDI_MIN  = 45;
const MIDI_MAX  = 84;
const CONF_MIN  = 0.3;
const BLACK_PC  = new Set([1, 3, 6, 8, 10]);

export const COLOR_SONG = "rgba(74, 158, 255, 0.88)";
export const COLOR_TAKE = "rgba(233, 69, 96,  0.92)";
export const COLOR_LIVE = "rgba(255, 140, 30,  0.9)";

function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

type KeyEntry = { x: number; w: number; isBlack: boolean };
type KeyLayout = Map<number, KeyEntry>;

function buildLayout(W: number): KeyLayout {
  const layout: KeyLayout = new Map();
  let totalWhite = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (!isBlack(m)) totalWhite++;
  }
  const wkW = W / totalWhite;
  let wi = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (!isBlack(m)) {
      layout.set(m, { x: wi * wkW, w: wkW, isBlack: false });
      wi++;
    }
  }
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isBlack(m)) {
      const below = layout.get(m - 1);
      if (below) {
        const bkW = wkW * 0.58;
        layout.set(m, { x: below.x + below.w - bkW / 2, w: bkW, isBlack: true });
      }
    }
  }
  return layout;
}

export function getCurrentMidi(points: PitchPoint[], currentTime: number): number | null {
  const near = points.filter(
    (p) => Math.abs(p.time - currentTime) < 0.06 && p.confidence >= CONF_MIN && p.frequency > 0,
  );
  if (near.length === 0) return null;
  const avg = near.reduce((s, p) => s + frequencyToMidi(p.frequency), 0) / near.length;
  return Math.round(avg);
}

function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  H: number,
  layout: KeyLayout,
  songMidi: number | null,
  takeMidi: number | null,
  liveMidi: number | null,
): void {
  const blackH = H * 0.62;
  const fontSize = Math.max(8, H * 0.18);

  // White keys
  for (const [midi, key] of layout) {
    if (key.isBlack) continue;
    const isSong = midi === songMidi;
    const isTake = midi === takeMidi;
    const isLive = midi === liveMidi;
    ctx.fillStyle = isLive ? COLOR_LIVE : isTake ? COLOR_TAKE : isSong ? COLOR_SONG : "#c8c8c8";
    ctx.fillRect(key.x + 0.5, 0, key.w - 1, H);
    // Divider
    ctx.fillStyle = "#33334a";
    ctx.fillRect(key.x + key.w - 0.5, 0, 1, H);
    // Note label on every white key: C notes get octave suffix (C3, C4…), others just letter
    const pc = ((midi % 12) + 12) % 12;
    const label = pc === 0 ? `C${Math.floor(midi / 12) - 1}` : NOTE_NAMES[pc];
    ctx.fillStyle = isSong || isTake || isLive ? "#fff" : "#666";
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, key.x + key.w / 2, H - 2);
  }

  // Black keys (drawn on top)
  for (const [midi, key] of layout) {
    if (!key.isBlack) continue;
    const isSong = midi === songMidi;
    const isTake = midi === takeMidi;
    const isLive = midi === liveMidi;
    ctx.fillStyle = isLive ? COLOR_LIVE : isTake ? COLOR_TAKE : isSong ? COLOR_SONG : "#1a1a2e";
    ctx.fillRect(key.x, 0, key.w, blackH);
  }
}

export default function PianoKeyboard() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const songPitch   = useAnalysisStore((s) => s.songPitch);
  const takePitch   = useAnalysisStore((s) => s.takePitch);
  const livePitch   = useAnalysisStore((s) => s.livePitch);
  const isLoaded    = useAnalysisStore((s) => s.isLoaded);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const drawRef     = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const W = canvas.offsetWidth  || 600;
      const H = canvas.offsetHeight || 80;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      const layout   = buildLayout(W);
      const t        = getEngine().getCurrentTime();
      const songMidi = getCurrentMidi(songPitch, t);
      const takeMidi = getCurrentMidi(takePitch, t);
      const liveMidi = getCurrentMidi(livePitch, t);
      drawKeyboard(ctx, H, layout, songMidi, takeMidi, liveMidi);
    };

    drawRef.current();
  }, [songPitch, takePitch, livePitch, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Pitch Monitor</span>
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
      <canvas
        ref={canvasRef}
        className="analysis-panel__canvas analysis-panel__canvas--keyboard"
      />
    </div>
  );
}
