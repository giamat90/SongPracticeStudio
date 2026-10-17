import { useMicSelect } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function MicSelector() {
  const mic = useMicSelect(usePlayerStore);

  return (
    <div className="mic-selector">
      <label className="mic-selector__label" htmlFor="mic-select">Input</label>
      <select
        id="mic-select"
        className="mic-selector__select"
        value={mic.value}
        onChange={(e) => mic.onChange(e.target.value)}
        disabled={mic.disabled}
      >
        <option value="">Default</option>
        {mic.options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default MicSelector;
