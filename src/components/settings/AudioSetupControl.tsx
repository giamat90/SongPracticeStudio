import { useSavedAudioSetup } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";
import { useSettingsStore } from "../../stores/settings";
import OutputSelector from "../player/OutputSelector";
import MicSelector from "../recording/MicSelector";

function AudioSetupControl() {
  const setup = useSavedAudioSetup({ settings: useSettingsStore, player: usePlayerStore });
  const remembered = setup.input !== null || setup.output !== null;

  return (
    <div className="audio-setup">
      <h3 className="audio-setup__title">Default audio setup</h3>
      <p className="audio-setup__hint">
        The input and output you pick, here or in a song, are remembered for every song and every
        start. A device that is not connected is kept and used again when it returns. The recording
        latency below belongs to the input, so it follows it.
      </p>
      <div className="audio-setup__row">
        <MicSelector />
        {setup.inputMissing && (
          <span className="audio-setup__note" role="status">
            {setup.inputMissing.label || "The saved input"} is not connected: the system default is used.
          </span>
        )}
      </div>
      <div className="audio-setup__row">
        <OutputSelector />
        {setup.outputMissing && (
          <span className="audio-setup__note" role="status">
            {setup.outputMissing.label || "The saved output"} is not connected: the system default is used.
          </span>
        )}
      </div>
      <button className="audio-setup__reset" onClick={setup.reset} disabled={!remembered}>
        Use the system defaults
      </button>
    </div>
  );
}

export default AudioSetupControl;
