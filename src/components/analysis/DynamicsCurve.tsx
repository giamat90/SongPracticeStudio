import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { getEngine } from "../../stores/player";

const WINDOW_S = 10;

export default function DynamicsCurve() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const songDynamics = useAnalysisStore((s) => s.songDynamics);
  const takeDynamics = useAnalysisStore((s) => s.takeDynamics);
  const isLoaded = useAnalysisStore((s) => s.isLoaded);

  // Stable ref to the latest draw function — updated when data changes,
  // called every rAF tick without React re-renders.
  const drawRef = useRef<() => void>(() => {});

  // Effect 1: rebuild draw fn when analysis data changes (NOT on currentTime).
  // currentTime is read directly from the engine inside the draw fn.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const W = canvas.offsetWidth || 600;
      const H = canvas.offsetHeight || 80;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }

      ctx.clearRect(0, 0, W, H);

      if (!isLoaded || songDynamics.length === 0) {
        ctx.fillStyle = "#a0a0b060";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No dynamics data", W / 2, H / 2);
        return;
      }

      const currentTime = getEngine().getCurrentTime();
      const t0 = currentTime - WINDOW_S / 2;
      const t1 = currentTime + WINDOW_S / 2;

      const timeToX = (t: number) => ((t - t0) / WINDOW_S) * W;
      const rmsToY = (rms: number) => H - Math.min(rms / 0.4, 1) * (H - 4) - 2;

      const drawCurve = (data: typeof songDynamics, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.beginPath();
        let started = false;
        for (const p of data) {
          if (p.time < t0 || p.time > t1) continue;
          const x = timeToX(p.time);
          const y = rmsToY(p.rms);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        if (started) ctx.stroke();
      };

      // Baseline
      ctx.strokeStyle = "#ffffff10";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, H - 2);
      ctx.lineTo(W, H - 2);
      ctx.stroke();

      drawCurve(songDynamics, "#7a7a90");
      if (takeDynamics.length > 0) drawCurve(takeDynamics, "#4ade80");

      // Playhead cursor
      const cx = W / 2;
      ctx.strokeStyle = "#ffffff20";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, H);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawRef.current();
  }, [songDynamics, takeDynamics, isLoaded]);

  // Effect 2: drive canvas at native frame rate via rAF — bypasses React entirely
  // during playback so no re-renders, no closure allocation, no GC pressure.
  useEffect(() => {
    if (!isLoaded) return;
    let rafId: number;
    const tick = () => {
      drawRef.current();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded]);

  // Effect 3: wire ResizeObserver once per canvas lifetime — no deps.
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
        <span className="analysis-panel__label">Dynamics (RMS)</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {takeDynamics.length > 0 && (
            <>
              <span className="legend-dot legend-dot--dynamics" />
              <span>Take</span>
            </>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas analysis-panel__canvas--sm" />
    </div>
  );
}
