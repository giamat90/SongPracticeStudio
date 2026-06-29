import { useCallback, useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/player";
import type { BassTabData } from "../../lib/types";

const STRING_LABELS = ["G", "D", "A", "E"] as const;

// 5-second sliding window; playhead sits 25% from the left
const WINDOW_SECS  = 5;
const PLAYHEAD_PCT = 0.25;

const NOTE_FILL  = "rgba(60,200,100,0.85)";
const NOTE_TEXT  = "#fff";
const BG_COLOR   = "#16213e";
const LINE_COLOR = "rgba(255,255,255,0.08)";

// Manual rounded-rect fill: ctx.roundRect() is absent on some WebView2 versions
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
  ctx.fill();
}

function drawTabWindow(
  canvas: HTMLCanvasElement,
  notes: BassTabData["notes"],
  currentTime: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W      = canvas.width;
  const H      = canvas.height;
  const LANE_H = H / 4;
  const NOTE_H = Math.max(4, LANE_H * 0.58);
  const MIN_W  = 8;           // minimum visible width in pixels
  const TEXT_THRESHOLD = 20;  // min clipped width to show fret number

  const winStart = currentTime - WINDOW_SECS * PLAYHEAD_PCT;
  const winEnd   = winStart + WINDOW_SECS;

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  // String center lines
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth   = 1;
  for (let lane = 0; lane < 4; lane++) {
    const y = Math.round(lane * LANE_H + LANE_H / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const fontSize = Math.max(9, Math.min(13, Math.floor(NOTE_H * 0.62)));
  ctx.font         = `bold ${fontSize}px monospace`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";

  for (const note of notes) {
    const noteEnd = note.time + note.duration;
    // Skip notes completely outside the current window
    if (noteEnd < winStart || note.time > winEnd) continue;

    const lane = 3 - note.string; // string 3 (G) → lane 0, string 0 (E) → lane 3

    // Raw pixel position of the note (may be negative or beyond W — canvas clips naturally)
    const x     = ((note.time - winStart) / WINDOW_SECS) * W;
    const noteW = Math.max(MIN_W, (note.duration / WINDOW_SECS) * W);
    const noteY = lane * LANE_H + (LANE_H - NOTE_H) / 2;

    ctx.fillStyle = NOTE_FILL;
    fillRoundRect(ctx, x, noteY, noteW, NOTE_H, 3);

    // Show fret number only if enough of the note is visible on canvas
    const clipX  = Math.max(0, x);
    const clipW  = Math.min(x + noteW, W) - clipX;
    if (clipW >= TEXT_THRESHOLD) {
      // Center text within the visible portion
      ctx.fillStyle = NOTE_TEXT;
      ctx.fillText(String(note.fret), clipX + clipW / 2, lane * LANE_H + LANE_H / 2);
    }
  }
}

interface BassTabProps {
  tabData: BassTabData;
}

export default function BassTab({ tabData }: BassTabProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const currentTime   = usePlayerStore((s) => s.currentTime);
  const punchIn       = usePlayerStore((s) => s.punchIn);
  const punchOut      = usePlayerStore((s) => s.punchOut);

  // Refs so the ResizeObserver callback always draws with current values
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const draw = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawTabWindow(canvas, tabData.notes, time);
  }, [tabData]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Sync canvas pixel size to container on resize, then redraw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      drawRef.current(currentTimeRef.current);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    sync();
    return () => ro.disconnect();
  }, []); // stable — reads from refs

  // Redraw every time the playback position or tab data changes
  useEffect(() => {
    draw(currentTime);
  }, [draw, currentTime]);

  // Punch overlay in window-relative coordinates
  const winStart = currentTime - WINDOW_SECS * PLAYHEAD_PCT;
  const showPunch = punchIn !== null && punchOut !== null;
  const punchLeftPct  = showPunch ? ((punchIn!  - winStart) / WINDOW_SECS) * 100 : 0;
  const punchWidthPct = showPunch ? ((punchOut! - punchIn!) / WINDOW_SECS) * 100 : 0;

  return (
    <div className="bass-tab">
      <div className="bass-tab__strings" aria-hidden="true">
        {STRING_LABELS.map((label) => (
          <div key={label} className="bass-tab__string-label">{label}</div>
        ))}
      </div>
      <div className="bass-tab__body">
        <canvas ref={canvasRef} className="bass-tab__canvas" />
        {/* Playhead is fixed at PLAYHEAD_PCT — it never moves, the notes scroll past it */}
        <div
          className="bass-tab__cursor"
          style={{ left: `${PLAYHEAD_PCT * 100}%` }}
          aria-hidden="true"
        />
        {showPunch && (
          <div
            className="waveform__punch-overlay"
            style={{ left: `${punchLeftPct}%`, width: `${punchWidthPct}%` }}
          />
        )}
      </div>
    </div>
  );
}
