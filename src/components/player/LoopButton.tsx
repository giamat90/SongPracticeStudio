import { usePlayerStore } from "../../stores/player";

function LoopButton() {
  const punchIn      = usePlayerStore((s) => s.punchIn);
  const punchOut     = usePlayerStore((s) => s.punchOut);
  const punchLoop    = usePlayerStore((s) => s.punchLoop);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const setPunchLoop = usePlayerStore((s) => s.setPunchLoop);

  const hasRegion = punchIn !== null && punchOut !== null;
  const disabled = !hasRegion || isRecording;

  return (
    <button
      className={`loop-btn${punchLoop ? " loop-btn--active" : ""}`}
      title={!hasRegion ? "Set a punch region first" : punchLoop ? "Disable loop" : "Loop region"}
      aria-label={!hasRegion ? "Set a punch region first" : punchLoop ? "Disable loop" : "Loop region"}
      disabled={disabled}
      aria-pressed={punchLoop}
      onClick={() => setPunchLoop(!punchLoop)}
    >
      ⟳
    </button>
  );
}

export default LoopButton;
