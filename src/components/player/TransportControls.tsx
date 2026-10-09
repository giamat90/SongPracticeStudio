import { usePlayerStore } from "../../stores/player";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TransportControls() {
  const isPlaying   = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration    = usePlayerStore((s) => s.duration);
  const togglePlay  = usePlayerStore((s) => s.togglePlay);
  const stop        = usePlayerStore((s) => s.stop);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const skipToStart = usePlayerStore((s) => s.skipToStart);
  const skipToEnd   = usePlayerStore((s) => s.skipToEnd);

  return (
    <div className="transport">
      <div className="transport__playback">
        <button
          className="transport__btn"
          onClick={skipToStart}
          disabled={isRecording}
          title="Skip to start"
          aria-label="Skip to start"
        >
          &#9198;
        </button>
        <button className="transport__btn" onClick={stop} title="Stop" aria-label="Stop">
          &#9632;
        </button>
        <button
          className="transport__btn transport__btn--play"
          onClick={togglePlay}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <button
          className="transport__btn"
          onClick={skipToEnd}
          disabled={isRecording}
          title="Skip to end"
          aria-label="Skip to end"
        >
          &#9197;
        </button>
        <span className="transport__time" role="timer" aria-label="Playback position">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}

export default TransportControls;
