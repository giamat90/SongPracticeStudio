import { useAnalysisStore } from "../../stores/analysis";

export default function VibratoCard() {
  const vibrato = useAnalysisStore((s) => s.takeVibrato);

  if (!vibrato) return null;

  const rateOk = vibrato.rate >= 4 && vibrato.rate <= 7;
  const depthOk = vibrato.depth >= 20 && vibrato.depth <= 100;
  const regularityOk = vibrato.regularity >= 0.6;

  return (
    <div className="vibrato-card">
      <div className="vibrato-card__title">Vibrato</div>
      <div className="vibrato-card__stats">
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${rateOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {vibrato.rate.toFixed(1)}
          </span>
          <span className="vibrato-card__unit">Hz</span>
          <span className="vibrato-card__label">Rate</span>
        </div>
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${depthOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {Math.round(vibrato.depth)}
          </span>
          <span className="vibrato-card__unit">ct</span>
          <span className="vibrato-card__label">Depth</span>
        </div>
        <div className="vibrato-card__stat">
          <span className={`vibrato-card__val ${regularityOk ? "vibrato-card__val--ok" : "vibrato-card__val--warn"}`}>
            {Math.round(vibrato.regularity * 100)}
          </span>
          <span className="vibrato-card__unit">%</span>
          <span className="vibrato-card__label">Even</span>
        </div>
      </div>
    </div>
  );
}
