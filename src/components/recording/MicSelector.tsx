import { useEffect } from "react";
import { usePlayerStore } from "../../stores/player";

function MicSelector() {
  const audioDevices = usePlayerStore((s) => s.audioDevices);
  const selectedDeviceId = usePlayerStore((s) => s.selectedDeviceId);
  const fetchAudioDevices = usePlayerStore((s) => s.fetchAudioDevices);
  const setAudioDevice = usePlayerStore((s) => s.setAudioDevice);
  const isRecording = usePlayerStore((s) => s.isRecording);

  useEffect(() => {
    fetchAudioDevices();
  }, []);

  return (
    <div className="mic-selector">
      <label className="mic-selector__label" htmlFor="mic-select">Mic</label>
      <select
        id="mic-select"
        className="mic-selector__select"
        value={selectedDeviceId ?? ""}
        onChange={(e) => setAudioDevice(e.target.value || null)}
        disabled={isRecording}
      >
        <option value="">Default</option>
        {audioDevices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </div>
  );
}

export default MicSelector;
