import { useState } from "react";
import { usePlayerStore } from "../../stores/player";

function RecordButton() {
  const isRecording = usePlayerStore((s) => s.isRecording);
  const startRecording = usePlayerStore((s) => s.startRecording);
  const stopRecording = usePlayerStore((s) => s.stopRecording);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    try {
      if (isRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recording failed");
    }
  };

  return (
    <div className="record-btn-wrapper">
      <button
        className={`record-btn ${isRecording ? "record-btn--active" : ""}`}
        onClick={handleClick}
        title={isRecording ? "Stop recording" : "Record"}
      >
        <span className="record-btn__dot" />
      </button>
      {error && <span className="record-btn__error">{error}</span>}
    </div>
  );
}

export default RecordButton;
