import { RATE_MAX, RATE_MIN, RATE_STEP, useTempoControl } from "@giamat90/mps-core/hooks";
import { usePlayerStore, getEngine } from "../../stores/player";

interface Props {
  detectedBpm?: number;
}

function TempoControl({ detectedBpm }: Props) {
  const meterMap = usePlayerStore((s) => s.meterMap);
  const clickDensity = usePlayerStore((s) => s.clickDensity);
  const tempo = useTempoControl(usePlayerStore, {
    detectedBpm,
    getCurrentTime: () => getEngine().getCurrentTime(),
    meterMap,
    clickDensity,
  });

  return (
    <div className="tempo-control">
      <div className="tempo-control__header">
        <div className="tempo-control__header-left">
          <span className="tempo-control__label">Speed</span>
          {detectedBpm && (
            <span className="tempo-control__row-prefix">{Math.round(detectedBpm)} BPM</span>
          )}
        </div>
        <button
          className={`metronome-btn${tempo.metronomeEnabled ? " metronome-btn--active" : ""}`}
          onClick={tempo.toggleMetronome}
          title={tempo.metronomeEnabled ? "Disable metronome" : "Enable metronome (clicks while playing)"}
          aria-label={tempo.metronomeEnabled ? "Disable metronome" : "Enable metronome (clicks while playing)"}
        >
          🥁
        </button>
      </div>

      <div className="tempo-control__bpm-group">
        <div className="tempo-control__bpm-row">
          {detectedBpm && (
            <>
              <input
                type="number"
                min={tempo.bpmMin}
                max={tempo.bpmMax}
                value={tempo.bpmInput}
                className="tempo-control__bpm-input"
                onChange={(e) => tempo.setBpmInput(e.target.value)}
                onBlur={(e) => tempo.commitBpm(e.target.value)}
                onKeyDown={(e) => tempo.onBpmKey(e.key)}
              />
              <span className="tempo-control__bpm-unit">BPM</span>
            </>
          )}
        </div>
        <div className="tempo-control__bpm-row">
          <input
            type="number"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={tempo.rateInput}
            className="tempo-control__bpm-input"
            onChange={(e) => tempo.setRateInput(e.target.value)}
            onBlur={(e) => tempo.commitRate(e.target.value)}
            onKeyDown={(e) => tempo.onRateKey(e.key)}
          />
          <span className="tempo-control__bpm-unit">×</span>
        </div>
        {tempo.metronomeEnabled && !meterMap && (
          <div className="tempo-control__bpm-row">
            <span
              className="tempo-control__bpm-unit"
              title="Where the metronome's accented beat 1 lands — drag the blue marker on the time ruler, or use Set below"
            >
              Downbeat
            </span>
            <span className="tempo-control__downbeat-value">{tempo.downbeatText}</span>
            <button
              className="tempo-control__downbeat-btn"
              onClick={tempo.setDownbeatToPlayhead}
              title="Set the metronome's downbeat to the current playhead position"
            >
              ⚑ Set
            </button>
            {tempo.metronomeOffset > 0 && (
              <button
                className="tempo-control__downbeat-btn"
                onClick={tempo.resetDownbeat}
                title="Reset downbeat to song start"
                aria-label="Reset downbeat to song start"
              >
                ↺
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default TempoControl;
