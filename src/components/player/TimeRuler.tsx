import { useCallback, useEffect, useRef } from "react";
import {
  finishPunchDrag,
  grabPunchEdge,
  startPunchDrag,
  updatePunchPreview,
  type PunchCommit,
  type PunchDrag,
} from "@giamat90/mps-core/punch";
import { usePlayerStore } from "../../stores/player";

const HANDLE_HIT_PX = 12;

function tickInterval(duration: number, widthPx: number): number {
  const raw = (duration / widthPx) * 80;
  for (const n of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (n >= raw) return n;
  }
  return 600;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type RulerDrag = { kind: "metronome" } | { kind: "punch"; drag: PunchDrag };

export default function TimeRuler() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const duration    = usePlayerStore((s) => s.duration);
  const punchIn     = usePlayerStore((s) => s.punchIn);
  const punchOut    = usePlayerStore((s) => s.punchOut);
  const setPunchIn  = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut = usePlayerStore((s) => s.setPunchOut);
  const clearPunch  = usePlayerStore((s) => s.clearPunch);
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const scrollTime  = usePlayerStore((s) => s.scrollTime);
  const metronomeOffset    = usePlayerStore((s) => s.metronomeOffset);
  const setMetronomeOffset = usePlayerStore((s) => s.setMetronomeOffset);

  const drag = useRef<RulerDrag | null>(null);

  // ── drawing ──────────────────────────────────────────────────────────────

  const draw = useCallback(
    (overrideIn?: number | null, overrideOut?: number | null, overrideMetronome?: number) => {
      const canvas = canvasRef.current;
      if (!canvas || duration <= 0 || minPxPerSec <= 0) return;
      const W = canvas.width;
      const H = canvas.height;
      if (W === 0 || H === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tX = (t: number) => (t - scrollTime) * minPxPerSec;
      const visibleDuration = W / minPxPerSec;

      ctx.fillStyle = "#0d1b2e";
      ctx.fillRect(0, 0, W, H);

      // Punch region band
      const inT  = overrideIn  !== undefined ? overrideIn  : punchIn;
      const outT = overrideOut !== undefined ? overrideOut : punchOut;
      if (inT !== null && outT !== null && outT > inT) {
        const x1 = tX(inT);
        const x2 = tX(outT);
        ctx.fillStyle = "rgba(245,158,11,0.22)";
        ctx.fillRect(x1, 0, x2 - x1, H);
        // Boundary lines
        ctx.strokeStyle = "rgba(245,158,11,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
        // Top "I-beam" caps on the handles
        ctx.fillStyle = "rgba(245,158,11,0.9)";
        ctx.fillRect(x1 - 3, 0, 6, 4);
        ctx.fillRect(x2 - 3, 0, 6, 4);
      }

      // Time ticks — spaced from the visible window, not the whole song, so
      // spacing gets finer as zoom increases, and only the visible range is drawn.
      const interval = tickInterval(visibleDuration, W);
      const fontSize = Math.max(10, Math.round(H * 0.42));
      ctx.font = `${fontSize}px monospace`;
      const visibleStart = Math.max(0, Math.floor(scrollTime / interval) * interval);
      const visibleEnd = Math.min(duration, scrollTime + visibleDuration);
      for (let t = visibleStart; t <= visibleEnd + 0.001; t += interval) {
        const x = Math.round(tX(t));
        ctx.strokeStyle = "#3a4a5e";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(x, H * 0.35);
        ctx.stroke();
        if (x + 3 < W) {
          ctx.fillStyle = "#7a8a9e";
          ctx.textAlign = "left";
          ctx.fillText(fmt(t), x + 3, H * 0.62);
        }
      }

      ctx.strokeStyle = "#2a3a4e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H - 0.5);
      ctx.lineTo(W, H - 0.5);
      ctx.stroke();

      // Metronome downbeat marker — dashed line + flag at the bottom edge,
      // draggable to align the click track with the song's actual downbeat.
      const metroT = overrideMetronome !== undefined ? overrideMetronome : metronomeOffset;
      const mx = tX(metroT);
      ctx.strokeStyle = "rgba(74,158,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(74,158,255,0.95)";
      ctx.beginPath();
      ctx.moveTo(mx, H);
      ctx.lineTo(mx - 5, H - 7);
      ctx.lineTo(mx + 5, H - 7);
      ctx.closePath();
      ctx.fill();
    },
    [duration, punchIn, punchOut, minPxPerSec, scrollTime, metronomeOffset],
  );

  // ── resize observer ───────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    };
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    sync();
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { draw(); }, [draw]);

  // ── helpers ──────────────────────────────────────────────────────────────

  const xToTime = (offsetX: number): number => {
    if (duration <= 0 || minPxPerSec <= 0) return 0;
    return Math.max(0, Math.min(duration, scrollTime + offsetX / minPxPerSec));
  };

  const setCursor = (c: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  const edgeAt = (offsetX: number) =>
    grabPunchEdge(
      offsetX,
      punchIn === null ? null : (punchIn - scrollTime) * minPxPerSec,
      punchOut === null ? null : (punchOut - scrollTime) * minPxPerSec,
      HANDLE_HIT_PX,
    );

  const commitPunch = (commit: PunchCommit) => {
    if (commit.type === "in") setPunchIn(commit.t);
    else if (commit.type === "out") setPunchOut(commit.t);
    else if (commit.type === "clear") clearPunch();
    else {
      setPunchIn(commit.inT);
      setPunchOut(commit.outT);
    }
  };

  // ── mouse handlers ───────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    const { offsetX } = e.nativeEvent;

    const metroX = (metronomeOffset - scrollTime) * minPxPerSec;
    if (Math.abs(offsetX - metroX) <= HANDLE_HIT_PX) {
      drag.current = { kind: "metronome" };
      setCursor("ew-resize");
      return;
    }

    const started = startPunchDrag(edgeAt(offsetX), xToTime(offsetX), punchIn, punchOut);
    drag.current = { kind: "punch", drag: started.drag };
    if (started.drag.mode === "create") draw(started.preview.inT, started.preview.outT);
    else setCursor("ew-resize");
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { offsetX } = e.nativeEvent;
    const active = drag.current;
    const t = xToTime(offsetX);

    if (!active) {
      // Hover: update cursor to signal draggable handles
      const metroX = (metronomeOffset - scrollTime) * minPxPerSec;
      if (Math.abs(offsetX - metroX) <= HANDLE_HIT_PX) {
        setCursor("ew-resize");
        return;
      }
      if (punchIn !== null && punchOut !== null) {
        setCursor(edgeAt(offsetX) !== "create" ? "ew-resize" : "crosshair");
      }
      return;
    }

    if (active.kind === "metronome") {
      draw(undefined, undefined, t);
    } else {
      const preview = updatePunchPreview(active.drag, t);
      draw(preview.inT, preview.outT);
    }
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;

    const t = xToTime(e.nativeEvent.offsetX);
    if (active.kind === "metronome") setMetronomeOffset(Math.round(t * 10) / 10);
    else commitPunch(finishPunchDrag(active.drag, t));

    // Restore hover cursor
    setCursor(duration <= 0 ? "default" : "crosshair");
  };

  const onMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drag.current) onMouseUp(e);
    else setCursor("default");
  };

  return (
    <div className="time-ruler">
      <canvas
        ref={canvasRef}
        className="time-ruler__canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        style={{ cursor: duration <= 0 ? "default" : "crosshair" }}
      />
    </div>
  );
}
