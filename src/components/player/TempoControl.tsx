import { useState } from "react";
import { usePlayerStore } from "../../stores/player";

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5];

interface Props {
  detectedBpm?: number;
}

function TempoControl({ detectedBpm }: Props) {
  const playbackRate    = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);

  const [bpmMode, setBpmMode]   = useState(false);
  const [bpmInput, setBpmInput] = useState("");

  const handleModeSwitch = (toBpm: boolean) => {
    if (toBpm && detectedBpm) {
      setBpmInput(String(Math.round(detectedBpm * playbackRate)));
    }
    setBpmMode(toBpm);
  };

  const commitBpm = (raw: string) => {
    if (!detectedBpm) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    const rate = Math.max(0.25, Math.min(2.5, n / detectedBpm));
    setPlaybackRate(parseFloat(rate.toFixed(4)));
  };

  const bpmPresets = detectedBpm
    ? [0.5, 0.6, 0.75, 0.9, 1.0, 1.1, 1.25].map((f) => Math.round(detectedBpm * f))
    : [];

  const currentBpm = detectedBpm ? Math.round(detectedBpm * playbackRate) : null;

  return (
    <div className="tempo-control">
      <div className="tempo-control__header">
        <span className="tempo-control__label">Speed</span>
        {detectedBpm && (
          <div className="tempo-control__tabs">
            <button
              className={`tempo-control__tab${!bpmMode ? " tempo-control__tab--active" : ""}`}
              onClick={() => handleModeSwitch(false)}
            >
              ×
            </button>
            <button
              className={`tempo-control__tab${bpmMode ? " tempo-control__tab--active" : ""}`}
              onClick={() => handleModeSwitch(true)}
            >
              BPM
            </button>
          </div>
        )}
      </div>

      {!bpmMode ? (
        <>
          <div className="tempo-control__row">
            <input
              type="range"
              min={0.25}
              max={2.5}
              step={0.05}
              value={playbackRate}
              onChange={(e) => setPlaybackRate(Number(e.target.value))}
              className="tempo-control__slider"
            />
            <span className="tempo-control__value">{playbackRate.toFixed(2)}×</span>
          </div>
          <div className="tempo-control__presets">
            {SPEED_PRESETS.map((p) => (
              <button
                key={p}
                className={`tempo-control__preset${playbackRate === p ? " tempo-control__preset--active" : ""}`}
                onClick={() => setPlaybackRate(p)}
              >
                {p}×
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="tempo-control__bpm-row">
            <span className="tempo-control__bpm-orig">{Math.round(detectedBpm!)} BPM →</span>
            <input
              type="number"
              min={Math.round(detectedBpm! * 0.25)}
              max={Math.round(detectedBpm! * 2.5)}
              value={bpmInput}
              className="tempo-control__bpm-input"
              onChange={(e) => setBpmInput(e.target.value)}
              onBlur={(e) => commitBpm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBpm(bpmInput);
              }}
            />
            <span className="tempo-control__bpm-unit">BPM</span>
            <span className="tempo-control__value tempo-control__bpm-rate">
              {currentBpm !== null ? `${playbackRate.toFixed(2)}×` : ""}
            </span>
          </div>
          <div className="tempo-control__presets">
            {bpmPresets.map((bpm) => (
              <button
                key={bpm}
                className={`tempo-control__preset${currentBpm === bpm ? " tempo-control__preset--active" : ""}`}
                onClick={() => {
                  setBpmInput(String(bpm));
                  commitBpm(String(bpm));
                }}
              >
                {bpm}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default TempoControl;
