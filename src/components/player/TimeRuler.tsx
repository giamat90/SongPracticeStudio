import { useCallback, useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/player";

const HANDLE_HIT_PX = 8; // pixels around a handle boundary that counts as a hit

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

type DragMode = "create" | "drag-in" | "drag-out";

export default function TimeRuler() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const duration    = usePlayerStore((s) => s.duration);
  const punchIn     = usePlayerStore((s) => s.punchIn);
  const punchOut    = usePlayerStore((s) => s.punchOut);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const punchLoop   = usePlayerStore((s) => s.punchLoop);
  const setPunchIn  = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut = usePlayerStore((s) => s.setPunchOut);
  const clearPunch  = usePlayerStore((s) => s.clearPunch);
  const setPunchLoop = usePlayerStore((s) => s.setPunchLoop);

  // anchorT: the fixed end when dragging a single handle
  const drag = useRef<{ mode: DragMode | null; anchorT: number }>({
    mode: null,
    anchorT: 0,
  });

  // ── drawing ──────────────────────────────────────────────────────────────

  const draw = useCallback(
    (overrideIn?: number | null, overrideOut?: number | null) => {
      const canvas = canvasRef.current;
      if (!canvas || duration <= 0) return;
      const W = canvas.width;
      const H = canvas.height;
      if (W === 0 || H === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tX = (t: number) => (t / duration) * W;

      ctx.fillStyle = "#0d1b2e";
      ctx.fillRect(0, 0, W, H);

      // Punch region band
      const inT  = overrideIn  !== undefined ? overrideIn  : punchIn;
      const outT = overrideOut !== undefined ? overrideOut : punchOut;
      if (inT !== null && outT !== null && outT > inT) {
        const x1 = tX(inT);
        const x2 = tX(outT);
        ctx.fillStyle = "rgba(233,69,96,0.22)";
        ctx.fillRect(x1, 0, x2 - x1, H);
        // Boundary lines
        ctx.strokeStyle = "rgba(233,69,96,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
        // Top "I-beam" caps on the handles
        ctx.fillStyle = "rgba(233,69,96,0.9)";
        ctx.fillRect(x1 - 3, 0, 6, 4);
        ctx.fillRect(x2 - 3, 0, 6, 4);
      }

      // Time ticks
      const interval = tickInterval(duration, W);
      ctx.font = "10px monospace";
      for (let t = 0; t <= duration + 0.001; t += interval) {
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
          ctx.fillText(fmt(t), x + 3, H * 0.55);
        }
      }

      ctx.strokeStyle = "#2a3a4e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H - 0.5);
      ctx.lineTo(W, H - 0.5);
      ctx.stroke();
    },
    [duration, punchIn, punchOut],
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
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, (offsetX / canvas.width) * duration));
  };

  const setCursor = (c: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  // Determine which drag mode to start based on mouse position
  const modeForOffset = (offsetX: number): DragMode => {
    const canvas = canvasRef.current;
    if (!canvas || punchIn === null || punchOut === null) return "create";
    const W = canvas.width;
    const x1 = (punchIn  / duration) * W;
    const x2 = (punchOut / duration) * W;
    if (Math.abs(offsetX - x1) <= HANDLE_HIT_PX) return "drag-in";
    if (Math.abs(offsetX - x2) <= HANDLE_HIT_PX) return "drag-out";
    return "create";
  };

  // ── mouse handlers ───────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording || duration <= 0) return;
    e.preventDefault();
    const { offsetX } = e.nativeEvent;
    const mode = modeForOffset(offsetX);
    const t = xToTime(offsetX);

    if (mode === "drag-in") {
      drag.current = { mode, anchorT: punchOut! };
      setCursor("ew-resize");
    } else if (mode === "drag-out") {
      drag.current = { mode, anchorT: punchIn! };
      setCursor("ew-resize");
    } else {
      drag.current = { mode: "create", anchorT: t };
      draw(t, t);
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { offsetX } = e.nativeEvent;
    const { mode, anchorT } = drag.current;
    const t = xToTime(offsetX);

    if (!mode) {
      // Hover: update cursor to signal draggable handles
      if (!isRecording && punchIn !== null && punchOut !== null) {
        const m = modeForOffset(offsetX);
        setCursor(m !== "create" ? "ew-resize" : "crosshair");
      }
      return;
    }

    if (mode === "drag-in") {
      // In handle moves; out handle (anchorT) stays fixed
      const newIn = Math.min(t, anchorT - 0.1);
      draw(newIn, anchorT);
    } else if (mode === "drag-out") {
      const newOut = Math.max(t, anchorT + 0.1);
      draw(anchorT, newOut);
    } else {
      // Creating a new region
      draw(Math.min(anchorT, t), Math.max(anchorT, t));
    }
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mode, anchorT } = drag.current;
    if (!mode) return;
    drag.current.mode = null;

    const t = xToTime(e.nativeEvent.offsetX);

    if (mode === "drag-in") {
      setPunchIn(Math.round(Math.min(t, anchorT - 0.1) * 10) / 10);
    } else if (mode === "drag-out") {
      setPunchOut(Math.round(Math.max(t, anchorT + 0.1) * 10) / 10);
    } else {
      // Create: commit or clear
      const inT  = Math.min(anchorT, t);
      const outT = Math.max(anchorT, t);
      if (outT - inT < 0.5) {
        clearPunch();
      } else {
        setPunchIn(Math.round(inT * 10) / 10);
        setPunchOut(Math.round(outT * 10) / 10);
      }
    }

    // Restore hover cursor
    setCursor(isRecording || duration <= 0 ? "default" : "crosshair");
  };

  const onMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drag.current.mode) onMouseUp(e);
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
        style={{ cursor: isRecording || duration <= 0 ? "default" : "crosshair" }}
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
  );
}
