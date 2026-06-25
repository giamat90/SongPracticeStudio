import { useEffect } from "react";
import { usePlayerStore } from "../../stores/player";

function OutputSelector() {
  const outputDevices = usePlayerStore((s) => s.outputDevices);
  const selectedOutputDeviceId = usePlayerStore((s) => s.selectedOutputDeviceId);
  const fetchOutputDevices = usePlayerStore((s) => s.fetchOutputDevices);
  const setOutputDevice = usePlayerStore((s) => s.setOutputDevice);
  const song = usePlayerStore((s) => s.song);

  useEffect(() => {
    fetchOutputDevices();
  }, []);

  return (
    <div className="output-selector">
      <label className="output-selector__label" htmlFor="output-select">Output</label>
      <select
        id="output-select"
        className="output-selector__select"
        value={selectedOutputDeviceId ?? ""}
        onChange={(e) =>
          setOutputDevice(e.target.value || null).catch((err: unknown) =>
            console.error("[OutputSelector] setSinkId failed:", err)
          )
        }
        disabled={!song}
      >
        <option value="">Default</option>
        {outputDevices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Speaker ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </div>
  );
}

export default OutputSelector;
