import { useRecordButton } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function RecordButton() {
  const rec = useRecordButton(usePlayerStore);

  return (
    <div className="record-btn-wrapper">
      <button
        className={`count-in-btn ${rec.countInBars > 0 ? "count-in-btn--active" : ""}`}
        onClick={rec.onCountInClick}
        disabled={rec.countInDisabled}
        title={rec.countInTitle}
      >
        {rec.countInText}
      </button>
      <button
        className={`record-btn ${rec.isRecording ? "record-btn--active" : ""} ${rec.isCountingIn ? "record-btn--counting-in" : ""} ${rec.isSavingTake ? "record-btn--saving" : ""}`}
        onClick={rec.onRecordClick}
        disabled={rec.isSavingTake}
        title={rec.recordLabel}
        aria-label={rec.recordLabel}
      >
        {rec.isCountingIn ? (
          <span className="record-btn__countdown">{rec.countInBeatsRemaining}</span>
        ) : (
          <span className="record-btn__dot" />
        )}
      </button>
      {rec.isSavingTake && <span className="record-btn__saving-label" role="status">Saving…</span>}
      {rec.error && <span className="record-btn__error" role="alert">{rec.error}</span>}
    </div>
  );
}

export default RecordButton;
