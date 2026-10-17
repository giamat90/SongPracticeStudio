import { useKeyTranspose } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function KeyTranspose() {
  const key = useKeyTranspose(usePlayerStore);

  return (
    <div className="key-transpose">
      <span className="key-transpose__label">Transpose</span>
      <div className="key-transpose__controls">
        <button
          className="key-transpose__btn"
          onClick={() => key.shift(-1)}
          disabled={key.disabled}
        >
          -
        </button>
        <span className={`key-transpose__value${key.isTransposing ? " key-transpose__value--pending" : ""}`}>
          {key.valueText} st
        </span>
        <button
          className="key-transpose__btn"
          onClick={() => key.shift(1)}
          disabled={key.disabled}
        >
          +
        </button>
        {key.showReset && (
          <button
            className="key-transpose__btn key-transpose__reset"
            onClick={key.reset}
            disabled={key.disabled}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export default KeyTranspose;
