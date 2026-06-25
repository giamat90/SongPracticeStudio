import { usePlayerStore } from "../../stores/player";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TransportControls() {
  const isPlaying            = usePlayerStore((s) => s.isPlaying);
  const currentTime          = usePlayerStore((s) => s.currentTime);
  const duration             = usePlayerStore((s) => s.duration);
  const togglePlay           = usePlayerStore((s) => s.togglePlay);
  const stop                 = usePlayerStore((s) => s.stop);
  const stopRecording        = usePlayerStore((s) => s.stopRecording);
  const isRecording          = usePlayerStore((s) => s.isRecording);
  const vocalsVolume         = usePlayerStore((s) => s.vocalsVolume);
  const instrumentalVolume   = usePlayerStore((s) => s.instrumentalVolume);
  const takeVolume            = usePlayerStore((s) => s.takeVolume);
  const activeTakeId          = usePlayerStore((s) => s.activeTakeId);
  const setVocalsVolume       = usePlayerStore((s) => s.setVocalsVolume);
  const setInstrumentalVolume = usePlayerStore((s) => s.setInstrumentalVolume);
  const setTakeVolume         = usePlayerStore((s) => s.setTakeVolume);

  return (
    <div className="transport">
      <div className="transport__playback">
        <button className="transport__btn" onClick={isRecording ? () => void stopRecording() : stop} title="Stop">
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

      <div className="transport__volumes">
        <label className="transport__vol">
          <span>Vocals</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={vocalsVolume}
            onChange={(e) => setVocalsVolume(Number(e.target.value))}
          />
        </label>
        <label className="transport__vol">
          <span>Instrumental</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={instrumentalVolume}
            onChange={(e) => setInstrumentalVolume(Number(e.target.value))}
          />
        </label>
        {activeTakeId && (
          <label className="transport__vol">
            <span style={{ color: "#ff8c1e" }}>Take</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={takeVolume}
              onChange={(e) => setTakeVolume(Number(e.target.value))}
            />
          </label>
        )}
      </div>
    </div>
  );
}

export default TransportControls;
