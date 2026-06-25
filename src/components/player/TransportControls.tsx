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

  return (
    <div className="transport">
      <div className="transport__playback">
        <button className="transport__btn" onClick={stop} title="Stop">
          &#9632;
        </button>
        <button
          className="transport__btn transport__btn--play"
          onClick={togglePlay}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <span className="transport__time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}

export default TransportControls;
