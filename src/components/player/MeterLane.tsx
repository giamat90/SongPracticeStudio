import { useEffect, useRef } from "react";
import { barEnd, barIndexAt, formatSignature, pulseLevels, pulseTimes, setBarStart, type BarMap } from "@giamat90/mps-core/meter";
import { classifyMeterPress, STRIP_H, type BarBlock } from "../../lib/meterView";
import { getEngine, usePlayerStore } from "../../stores/player";
import { ENVELOPE_FPS } from "./useHitEnvelope";

/** A press that moves less than this is a click, not a drag. */
const CLICK_PX = 3;

type Drag =
  | { kind: "edge"; index: number; time: number; startX: number; moved: boolean }
  | { kind: "seek"; startX: number; startTime: number; moved: boolean; pick: number | null };

interface Props {
  map: BarMap;
  duration: number;
  windowSeconds: number;
  envelope: Float32Array | null;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onMoveBar: (next: BarMap) => void;
}

/**
 * The bars around the playhead: a button for each at the top, the drums under it, and a line at every pulse.
 * The amber handle at a bar's left edge moves where it starts; the rest of the bars follow their own spacing.
 */
export default function MeterLane({ map, duration, windowSeconds, envelope, selected, onSelect, onMoveBar }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const blocks = useRef<BarBlock[]>([]);
  const hover = useRef<number | null>(null);
  const live = useRef({ map, envelope, selected, windowSeconds });
  live.current = { map, envelope, selected, windowSeconds };

  const timeAt = (el: HTMLCanvasElement, x: number) =>
    getEngine().getCurrentTime() - live.current.windowSeconds / 2 + (x / el.offsetWidth) * live.current.windowSeconds;
  const seekTo = (time: number) => usePlayerStore.getState().seek(Math.min(Math.max(time, 0), duration));

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const x = e.clientX - rect.left;
    const press = classifyMeterPress(blocks.current, x, e.clientY - rect.top);
    if (press.kind === "edge") drag.current = { kind: "edge", index: press.index, time: timeAt(el, x), startX: x, moved: false };
    else drag.current = { kind: "seek", startX: x, startTime: getEngine().getCurrentTime(), moved: false, pick: press.kind === "bar" ? press.index : null };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const held = drag.current;
    if (!held) {
      const press = classifyMeterPress(blocks.current, x, e.clientY - rect.top);
      el.style.cursor = press.kind === "edge" ? "ew-resize" : press.kind === "bar" ? "pointer" : "";
      hover.current = press.kind === "bar" ? press.index : null;
      return;
    }
    if (Math.abs(x - held.startX) > CLICK_PX) held.moved = true;
    if (held.kind === "edge") held.time = timeAt(el, x);
    else if (held.moved) seekTo(held.startTime - ((x - held.startX) / el.offsetWidth) * live.current.windowSeconds);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const held = drag.current;
    drag.current = null;
    if (!held) return;
    if (held.kind === "edge") {
      if (held.moved) onMoveBar(setBarStart(live.current.map, held.index, held.time));
      else onSelect(live.current.selected === held.index ? null : held.index);
    } else if (!held.moved) {
      if (held.pick !== null) onSelect(live.current.selected === held.pick ? null : held.pick);
      else seekTo(timeAt(el, e.clientX - el.getBoundingClientRect().left));
    }
  };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const W = el.offsetWidth || 600;
      const H = el.offsetHeight || 160;
      if (el.width !== W || el.height !== H) {
        el.width = W;
        el.height = H;
      }
      const { map: shown, envelope: env, selected: picked, windowSeconds: win } = live.current;
      const held = drag.current;
      const bars = held?.kind === "edge" && held.moved ? setBarStart(shown, held.index, held.time) : shown;
      const now = getEngine().getCurrentTime();
      const t0 = now - win / 2;
      const xOf = (t: number) => ((t - t0) / win) * W;
      const bodyTop = STRIP_H;
      const bodyH = H - bodyTop;

      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      if (env) {
        ctx.fillStyle = "rgba(180,80,220,0.75)";
        const f0 = Math.max(0, Math.floor(t0 * ENVELOPE_FPS));
        const f1 = Math.min(env.length - 1, Math.ceil((t0 + win) * ENVELOPE_FPS));
        const w = Math.max(1, (W / win) / ENVELOPE_FPS);
        for (let f = f0; f <= f1; f++) {
          const v = env[f];
          if (v < 0.04) continue;
          const h = v * bodyH * 0.92;
          ctx.fillRect(xOf(f / ENVELOPE_FPS), H - h, w, h);
        }
      }

      const nextBlocks: BarBlock[] = [];
      const active = barIndexAt(bars, now);
      ctx.font = "600 12px sans-serif";
      ctx.textBaseline = "middle";
      for (let i = 0; i < bars.bars.length; i++) {
        const bar = bars.bars[i];
        const end = barEnd(bars, i);
        if (end < t0) continue;
        if (bar.start > t0 + win) break;
        const x0 = xOf(bar.start);
        const x1 = xOf(end);
        nextBlocks.push({ index: i, x0, x1 });

        const times = pulseTimes(bars, i);
        const levels = pulseLevels(bar);
        for (let k = 1; k < times.length; k++) {
          const x = Math.round(xOf(times[k])) + 0.5;
          ctx.strokeStyle = levels[k] === 1 ? "rgba(251,191,36,0.6)" : "rgba(255,255,255,0.16)";
          ctx.lineWidth = levels[k] === 1 ? 1.5 : 1;
          ctx.beginPath();
          ctx.moveTo(x, bodyTop);
          ctx.lineTo(x, H);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(245,158,11,0.95)";
        ctx.fillRect(Math.round(x0) - 1, bodyTop, 2, bodyH);

        if (i === picked) {
          ctx.fillStyle = "rgba(245,158,11,0.1)";
          ctx.fillRect(x0, bodyTop, x1 - x0, bodyH);
        }
        const width = x1 - x0 - 4;
        if (width >= 6) {
          ctx.beginPath();
          ctx.roundRect(x0 + 2, 3, width, STRIP_H - 6, 4);
          ctx.fillStyle = i === picked ? "rgba(245,158,11,0.7)" : i === active ? "rgba(245,158,11,0.45)" : i === hover.current ? "rgba(245,158,11,0.32)" : "rgba(245,158,11,0.18)";
          ctx.fill();
          ctx.strokeStyle = i === picked ? "#ffffff" : "rgba(245,158,11,0.55)";
          ctx.lineWidth = i === picked ? 1.5 : 1;
          ctx.stroke();
          const changed = i === 0 || formatSignature(bars.bars[i - 1]) !== formatSignature(bar);
          const text = changed || width > 70 ? `${i + 1}  ${formatSignature(bar)}` : String(i + 1);
          let label = text;
          while (label.length > 1 && ctx.measureText(label).width > width - 8) label = label.slice(0, -1);
          if (width >= 22) {
            ctx.fillStyle = "#fff7e6";
            ctx.textAlign = "center";
            ctx.fillText(label, x0 + 2 + width / 2, STRIP_H / 2 + 0.5);
          }
        }
        ctx.fillStyle = "rgba(251,191,36,0.95)";
        ctx.fillRect(x0 - 1.5, 7, 3, STRIP_H - 14);
      }
      blocks.current = nextBlocks;
      ctx.textAlign = "left";

      if (held?.kind === "edge" && held.moved) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xOf(held.time), 0);
        ctx.lineTo(xOf(held.time), H);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(xOf(now), 0, 1.5, H);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvas}
      className="meter-lane"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; }}
      onPointerLeave={() => { hover.current = null; }}
      title="Click to go there, drag to scrub. Click a bar to edit it; drag the amber handle at its left to move where it starts"
    />
  );
}
