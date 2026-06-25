import { useAnalysisStore } from "../../stores/analysis";

const MAX_MS = 300;

function dotColor(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 50) return "#4ade80";
  if (abs < 150) return "#fbbf24";
  return "#e94560";
}

export default function TimingChart() {
  const deviations = useAnalysisStore((s) => s.timingDeviations);

  if (deviations.length === 0) return null;

  const H = 80;
  const W = 200;
  const PAD = { top: 8, bottom: 8, left: 8, right: 8 };
  const innerH = H - PAD.top - PAD.bottom;
  const innerW = W - PAD.left - PAD.right;

  const n = deviations.length;
  const xStep = n > 1 ? innerW / (n - 1) : 0;

  const yCenter = PAD.top + innerH / 2;
  const msToPx = (ms: number) => (ms / MAX_MS) * (innerH / 2);

  return (
    <div className="timing-chart">
      <div className="timing-chart__title">Timing</div>
      <svg width={W} height={H} className="timing-chart__svg">
        {/* Zero line */}
        <line
          x1={PAD.left}
          y1={yCenter}
          x2={W - PAD.right}
          y2={yCenter}
          stroke="#ffffff20"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* +100ms / -100ms guides */}
        {[100, -100].map((ms) => (
          <line
            key={ms}
            x1={PAD.left}
            y1={yCenter - msToPx(ms)}
            x2={W - PAD.right}
            y2={yCenter - msToPx(ms)}
            stroke="#ffffff10"
            strokeWidth={0.5}
          />
        ))}
        {/* Dots */}
        {deviations.map((d, i) => {
          const cx = PAD.left + i * xStep;
          const cy = yCenter - Math.max(-innerH / 2, Math.min(innerH / 2, msToPx(d.deltaMs)));
          return (
            <circle
              key={d.noteIndex}
              cx={cx}
              cy={cy}
              r={3}
              fill={dotColor(d.deltaMs)}
              opacity={0.85}
            />
          );
        })}
      </svg>
      <div className="timing-chart__labels">
        <span>Early</span>
        <span>Late</span>
      </div>
    </div>
  );
}
