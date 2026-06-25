import { usePlayerStore } from "../../stores/player";

const PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5];

function TempoControl() {
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);

  return (
    <div className="tempo-control">
      <span className="tempo-control__label">Speed</span>
      <input
        type="range"
        min={0.5}
        max={2.0}
        step={0.05}
        value={playbackRate}
        onChange={(e) => setPlaybackRate(Number(e.target.value))}
        className="tempo-control__slider"
      />
      <span className="tempo-control__value">{playbackRate.toFixed(2)}x</span>
      <div className="tempo-control__presets">
        {PRESETS.map((p) => (
          <button
            key={p}
            className={`tempo-control__preset ${playbackRate === p ? "tempo-control__preset--active" : ""}`}
            onClick={() => setPlaybackRate(p)}
          >
            {p}x
          </button>
        ))}
      </div>
    </div>
  );
}

export default TempoControl;
