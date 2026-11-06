import { useTransportControls } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";
import RecordButton from "../recording/RecordButton";
import CountInButton from "./CountInButton";

function TransportControls() {
  const transport = useTransportControls(usePlayerStore, { stopEndsRecording: false });

  return (
    <div className="transport">
      <div className="transport__playback">
        <button
          className="transport__btn"
          onClick={transport.skipToStart}
          disabled={transport.isRecording || transport.lockReason !== null}
          title={transport.lockReason ?? "Skip to start"}
          aria-label="Skip to start"
        >
          &#9198;
        </button>
        <button
          className="transport__btn"
          onClick={transport.onStop}
          disabled={transport.lockReason !== null}
          title={transport.lockReason ?? "Stop"}
          aria-label="Stop"
        >
          &#9632;
        </button>
        <button
          className={`transport__btn transport__btn--play ${transport.isCountingIn ? "transport__btn--counting-in" : ""}`}
          onClick={transport.togglePlay}
          disabled={transport.lockReason !== null}
          title={transport.lockReason ?? transport.playLabel}
          aria-label={transport.playLabel}
        >
          {transport.isCountingIn ? transport.countInBeatsRemaining : transport.isPlaying ? "❚❚" : "▶"}
        </button>
        <RecordButton />
        <button
          className="transport__btn"
          onClick={transport.skipToEnd}
          disabled={transport.isRecording || transport.lockReason !== null}
          title={transport.lockReason ?? "Skip to end"}
          aria-label="Skip to end"
        >
          &#9197;
        </button>
        <CountInButton />
        <span className="transport__time" role="timer" aria-label="Playback position">
          {transport.currentText} / {transport.durationText}
        </span>
      </div>
    </div>
  );
}

export default TransportControls;
