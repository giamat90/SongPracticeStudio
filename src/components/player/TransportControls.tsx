import { useTransportControls } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function TransportControls() {
  const transport = useTransportControls(usePlayerStore, { stopEndsRecording: false });

  return (
    <div className="transport">
      <div className="transport__playback">
        <button
          className="transport__btn"
          onClick={transport.skipToStart}
          disabled={transport.isRecording}
          title="Skip to start"
          aria-label="Skip to start"
        >
          &#9198;
        </button>
        <button className="transport__btn" onClick={transport.onStop} title="Stop" aria-label="Stop">
          &#9632;
        </button>
        <button
          className="transport__btn transport__btn--play"
          onClick={transport.togglePlay}
          title={transport.playLabel}
          aria-label={transport.playLabel}
        >
          {transport.isPlaying ? "❚❚" : "▶"}
        </button>
        <button
          className="transport__btn"
          onClick={transport.skipToEnd}
          disabled={transport.isRecording}
          title="Skip to end"
          aria-label="Skip to end"
        >
          &#9197;
        </button>
        <span className="transport__time" role="timer" aria-label="Playback position">
          {transport.currentText} / {transport.durationText}
        </span>
      </div>
    </div>
  );
}

export default TransportControls;
