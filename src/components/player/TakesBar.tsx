import { usePlayerStore, TAKE_TRACK_KEY } from "../../stores/player";

/**
 * Above the take lanes: how the shown takes are heard, whether they are silent
 * while a new one is recorded, and the level of all of them (the "take" channel).
 */
function TakesBar() {
  const takePlayback = usePlayerStore((s) => s.takePlayback);
  const setTakePlayback = usePlayerStore((s) => s.setTakePlayback);
  const muteWhileRecording = usePlayerStore((s) => s.muteTakesWhileRecording);
  const setMuteWhileRecording = usePlayerStore((s) => s.setMuteTakesWhileRecording);
  const volume = usePlayerStore((s) => s.takeVolume);
  const setTakeVolume = usePlayerStore((s) => s.setTakeVolume);
  const isMuted = usePlayerStore((s) => !!s.mutedStems[TAKE_TRACK_KEY]);
  const isSoloed = usePlayerStore((s) => s.soloedStem === TAKE_TRACK_KEY);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleSolo = usePlayerStore((s) => s.toggleSolo);

  return (
    <div className="takes-bar">
      <span className="stem-track__label waveform__label--take">🎙 Takes</span>
      <button
        type="button"
        className="takes-bar__toggle"
        aria-pressed={takePlayback === "all"}
        onClick={() => setTakePlayback(takePlayback === "all" ? "selected" : "all")}
        title={
          takePlayback === "all"
            ? "All shown takes play together; use M on a lane to silence one. Click to hear only the selected take."
            : "Only the selected take plays; click another take to switch. Click to play all shown takes together."
        }
      >
        {takePlayback === "all" ? "Hear: all shown" : "Hear: selected only"}
      </button>
      <button
        type="button"
        className="takes-bar__toggle"
        aria-pressed={muteWhileRecording}
        onClick={() => setMuteWhileRecording(!muteWhileRecording)}
        title={
          muteWhileRecording
            ? "Takes are silent while you record. Click to keep hearing them."
            : "Takes keep playing while you record. Click to silence them while recording."
        }
      >
        {muteWhileRecording ? "Silent while recording" : "Playing while recording"}
      </button>
      <div className="stem-track__controls">
        <button
          className={`stem-track__mute${isMuted ? " stem-track__mute--on" : ""}`}
          onClick={() => toggleMute(TAKE_TRACK_KEY)}
          title={isMuted ? "Unmute all takes" : "Mute all takes"}
          aria-label={isMuted ? "Unmute all takes" : "Mute all takes"}
        >
          M
        </button>
        <button
          className={`stem-track__solo${isSoloed ? " stem-track__solo--on" : ""}`}
          onClick={() => toggleSolo(TAKE_TRACK_KEY)}
          title={isSoloed ? "Unsolo takes" : "Solo takes"}
          aria-label={isSoloed ? "Unsolo takes" : "Solo takes"}
        >
          S
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setTakeVolume(Number(e.target.value))}
          className="stem-track__volume"
          title="Volume of the takes"
        />
      </div>
    </div>
  );
}

export default TakesBar;
