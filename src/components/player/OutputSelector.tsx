import { useOutputSelect } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function OutputSelector() {
  const output = useOutputSelect(usePlayerStore);

  return (
    <div className="output-selector">
      <label className="output-selector__label" htmlFor="output-select">Output</label>
      <select
        id="output-select"
        className="output-selector__select"
        value={output.value}
        onChange={(e) => output.onChange(e.target.value)}
        disabled={output.disabled}
      >
        <option value="">Default</option>
        {output.options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default OutputSelector;
