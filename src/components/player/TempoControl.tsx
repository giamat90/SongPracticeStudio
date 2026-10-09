import { useEffect, useState } from "react";
import { usePlayerStore, getEngine } from "../../stores/player";
import { metronome } from "../../audio/metronome";
import { computeMetronomePhase } from "../../lib/metronomeSync";

interface Props {
  detectedBpm?: number;
}

function fmtOffset(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function TempoControl({ detectedBpm }: Props) {
  const playbackRate      = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate   = usePlayerStore((s) => s.setPlaybackRate);
  const isPlaying         = usePlayerStore((s) => s.isPlaying);
  const metronomeOffset   = usePlayerStore((s) => s.metronomeOffset);
  const setMetronomeOffset = usePlayerStore((s) => s.setMetronomeOffset);

  const [bpmInput, setBpmInput] = useState(() =>
    detectedBpm ? String(Math.round(detectedBpm * playbackRate)) : ""
  );
  const [rateInput, setRateInput] = useState(() => playbackRate.toFixed(2));
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);

  const effectiveBpm = (detectedBpm ?? 120) * playbackRate;

  useEffect(() => {
    if (metronomeEnabled && isPlaying) {
      // Phase-lock to metronomeOffset rather than always starting fresh at
      // beat 0 — otherwise the click drifts out of sync with the song's
      // actual downbeat whenever there's silence (or a pickup) before it.
      const { timeUntilNextBeat, beatIndex } = computeMetronomePhase({
        detectedBpm: detectedBpm ?? 120,
        playbackRate,
        anchorTime: metronomeOffset,
        currentSongTime: getEngine().getCurrentTime(),
      });
      metronome.start(effectiveBpm, timeUntilNextBeat, beatIndex);
    } else {
      metronome.stop();
    }
    // Resyncs (not just retunes) on every bpm/offset change while playing,
    // so a mid-playback speed change or a dragged downbeat marker doesn't
    // leave the click phase-locked to a stale mapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metronomeEnabled, isPlaying, effectiveBpm, metronomeOffset]);

  useEffect(() => () => metronome.stop(), []);

  const commitBpm = (raw: string) => {
    if (!detectedBpm) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setBpmInput(String(Math.round(detectedBpm * playbackRate)));
      return;
    }
    const rate = Math.max(0.25, Math.min(2.5, n / detectedBpm));
    const rounded = parseFloat(rate.toFixed(4));
    setPlaybackRate(rounded);
    setBpmInput(String(Math.round(detectedBpm * rounded)));
    setRateInput(rounded.toFixed(2));
  };

  const commitRate = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setRateInput(playbackRate.toFixed(2));
      return;
    }
    const rate = Math.max(0.25, Math.min(2.5, n));
    const rounded = parseFloat(rate.toFixed(4));
    setPlaybackRate(rounded);
    setRateInput(rounded.toFixed(2));
    if (detectedBpm) setBpmInput(String(Math.round(detectedBpm * rounded)));
  };

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
          className={`metronome-btn${metronomeEnabled ? " metronome-btn--active" : ""}`}
          onClick={() => setMetronomeEnabled((v) => !v)}
          title={metronomeEnabled ? "Disable metronome" : "Enable metronome (clicks while playing)"}
          aria-label={metronomeEnabled ? "Disable metronome" : "Enable metronome (clicks while playing)"}
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
                min={Math.round(detectedBpm * 0.25)}
                max={Math.round(detectedBpm * 2.5)}
                value={bpmInput}
                className="tempo-control__bpm-input"
                onChange={(e) => setBpmInput(e.target.value)}
                onBlur={(e) => commitBpm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitBpm(bpmInput);
                }}
              />
              <span className="tempo-control__bpm-unit">BPM</span>
            </>
          )}
        </div>
        <div className="tempo-control__bpm-row">
          <input
            type="number"
            min={0.25}
            max={2.5}
            step={0.05}
            value={rateInput}
            className="tempo-control__bpm-input"
            onChange={(e) => setRateInput(e.target.value)}
            onBlur={(e) => commitRate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRate(rateInput);
            }}
          />
          <span className="tempo-control__bpm-unit">×</span>
        </div>
        {metronomeEnabled && (
          <div className="tempo-control__bpm-row">
            <span
              className="tempo-control__bpm-unit"
              title="Where the metronome's accented beat 1 lands — drag the blue marker on the time ruler, or use Set below"
            >
              Downbeat
            </span>
            <span className="tempo-control__downbeat-value">{fmtOffset(metronomeOffset)}</span>
            <button
              className="tempo-control__downbeat-btn"
              onClick={() => setMetronomeOffset(getEngine().getCurrentTime())}
              title="Set the metronome's downbeat to the current playhead position"
            >
              ⚑ Set
            </button>
            {metronomeOffset > 0 && (
              <button
                className="tempo-control__downbeat-btn"
                onClick={() => setMetronomeOffset(0)}
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
