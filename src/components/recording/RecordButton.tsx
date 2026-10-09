import { useState } from "react";
import { usePlayerStore } from "../../stores/player";

const COUNT_IN_CYCLE: (0 | 1 | 2)[] = [0, 1, 2];

function RecordButton() {
  const isRecording = usePlayerStore((s) => s.isRecording);
  const isSavingTake = usePlayerStore((s) => s.isSavingTake);
  const isCountingIn = usePlayerStore((s) => s.isCountingIn);
  const countInBars = usePlayerStore((s) => s.countInBars);
  const countInBeatsRemaining = usePlayerStore((s) => s.countInBeatsRemaining);
  const startRecording = usePlayerStore((s) => s.startRecording);
  const stopRecording = usePlayerStore((s) => s.stopRecording);
  const cancelCountIn = usePlayerStore((s) => s.cancelCountIn);
  const setCountInBars = usePlayerStore((s) => s.setCountInBars);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    try {
      if (isRecording) {
        await stopRecording();
      } else if (isCountingIn) {
        cancelCountIn();
      } else {
        await startRecording();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recording failed");
    }
  };

  const cycleCountIn = () => {
    const idx = COUNT_IN_CYCLE.indexOf(countInBars);
    setCountInBars(COUNT_IN_CYCLE[(idx + 1) % COUNT_IN_CYCLE.length]);
  };

  return (
    <div className="record-btn-wrapper">
      <button
        className={`count-in-btn ${countInBars > 0 ? "count-in-btn--active" : ""}`}
        onClick={cycleCountIn}
        disabled={isRecording || isCountingIn || isSavingTake}
        title={
          countInBars > 0
            ? `Count-in: ${countInBars} bar${countInBars > 1 ? "s" : ""} of click before recording starts (click to change)`
            : "Count-in: off — click to enable a click count-off before recording"
        }
      >
        {countInBars > 0 ? `⏱${countInBars}` : "⏱"}
      </button>
      <button
        className={`record-btn ${isRecording ? "record-btn--active" : ""} ${isCountingIn ? "record-btn--counting-in" : ""} ${isSavingTake ? "record-btn--saving" : ""}`}
        onClick={handleClick}
        disabled={isSavingTake}
        title={isRecording ? "Stop recording" : isCountingIn ? "Cancel count-in" : "Record"}
        aria-label={isRecording ? "Stop recording" : isCountingIn ? "Cancel count-in" : "Record"}
      >
        {isCountingIn ? (
          <span className="record-btn__countdown">{countInBeatsRemaining}</span>
        ) : (
          <span className="record-btn__dot" />
        )}
      </button>
      {isSavingTake && <span className="record-btn__saving-label" role="status">Saving…</span>}
      {error && <span className="record-btn__error" role="alert">{error}</span>}
    </div>
  );
}

export default RecordButton;
