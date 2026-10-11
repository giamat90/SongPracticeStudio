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
      <label className="takes-bar__option" title="When on, only the selected take plays and clicking another take switches to it. When off, every shown take plays together; use M on a lane to silence one.">
        <input
          type="checkbox"
          checked={takePlayback === "selected"}
          onChange={(e) => setTakePlayback(e.target.checked ? "selected" : "all")}
        />
        Selected take only
      </label>
      <label className="takes-bar__option" title="When on, the takes are silent while you record a new one. When off, they keep playing.">
        <input
          type="checkbox"
          checked={muteWhileRecording}
          onChange={(e) => setMuteWhileRecording(e.target.checked)}
        />
        Mute takes while recording
      </label>
      <div className="stem-track__controls">
        <button
          className={`stem-track__mute${isMuted ? " stem-track__mute--on" : ""}`}
          onClick={() => toggleMute(TAKE_TRACK_KEY)}
          title={
            isMuted
              ? "Unmute the takes"
              : "Mute all the takes. This main mute wins over the mute and solo on each take."
          }
          aria-label={isMuted ? "Unmute all takes" : "Mute all takes"}
        >
          M
        </button>
        <button
          className={`stem-track__solo${isSoloed ? " stem-track__solo--on" : ""}`}
          onClick={() => toggleSolo(TAKE_TRACK_KEY)}
          title={
            isSoloed
              ? "Stop soloing the takes"
              : "Solo the takes: only the takes are heard and the stems go quiet. Solo on a take then picks one take among them."
          }
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
        {/* Same width as a lane's download button, so the sliders line up with the other tracks' */}
        <span className="stem-track__download takes-bar__spacer" aria-hidden="true">
          &darr;
        </span>
      </div>
    </div>
  );
}

export default TakesBar;
