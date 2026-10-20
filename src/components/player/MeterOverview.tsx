import { useEffect, useRef } from "react";
import { meterRuns, type BarMap } from "@giamat90/mps-core/meter";
import { getEngine, usePlayerStore } from "../../stores/player";

interface Props {
  map: BarMap;
  duration: number;
}

const hueOf = (label: string, order: string[]) => (order.indexOf(label) * 47 + 30) % 360;

/** The whole song as coloured stretches, one colour for each signature, so a change of meter is seen at a glance. */
export default function MeterOverview({ map, duration }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ map, duration });
  live.current = { map, duration };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const W = el.offsetWidth || 600;
      const H = el.offsetHeight || 28;
      if (el.width !== W || el.height !== H) {
        el.width = W;
        el.height = H;
      }
      const { map: shown, duration: total } = live.current;
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);
      if (total <= 0) return;
      const runs = meterRuns(shown);
      const order = [...new Set(runs.map((r) => `${r.num}/${r.den}`))];
      ctx.font = "600 11px sans-serif";
      ctx.textBaseline = "middle";
      for (const run of runs) {
        const label = `${run.num}/${run.den}`;
        const x0 = (run.start / total) * W;
        const x1 = (run.end / total) * W;
        ctx.fillStyle = `hsl(${hueOf(label, order)} 55% 38%)`;
        ctx.fillRect(x0, 3, Math.max(1, x1 - x0 - 1), H - 6);
        if (x1 - x0 > 30) {
          ctx.fillStyle = "#fff7e6";
          ctx.fillText(label, x0 + 4, H / 2 + 0.5);
        }
      }
      const x = (getEngine().getCurrentTime() / total) * W;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, 0, 1.5, H);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    usePlayerStore.getState().seek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return <canvas ref={canvas} className="meter-overview" onClick={seek} title="The whole song, coloured by time signature. Click to go there" />;
}
