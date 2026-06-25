import { usePlayerStore } from "../../stores/player";

function KeyTranspose() {
  const transpose = usePlayerStore((s) => s.transpose);
  const isTransposing = usePlayerStore((s) => s.isTransposing);
  const song = usePlayerStore((s) => s.song);
  const setTranspose = usePlayerStore((s) => s.setTranspose);

  const disabled = isTransposing || !song;

  const shift = (delta: number) => {
    const next = Math.max(-6, Math.min(6, transpose + delta));
    if (next !== transpose) {
      setTranspose(next).catch((e: unknown) =>
        console.error("[KeyTranspose] setTranspose failed:", e)
      );
    }
  };

  return (
    <div className="key-transpose">
      <span className="key-transpose__label">Transpose</span>
      <div className="key-transpose__controls">
        <button
          className="key-transpose__btn"
          onClick={() => shift(-1)}
          disabled={disabled}
        >
          -
        </button>
        <span className="key-transpose__value">
          {isTransposing ? "…" : transpose > 0 ? `+${transpose}` : transpose} st
        </span>
        <button
          className="key-transpose__btn"
          onClick={() => shift(1)}
          disabled={disabled}
        >
          +
        </button>
        {transpose !== 0 && !isTransposing && (
          <button
            className="key-transpose__btn key-transpose__reset"
            onClick={() =>
              setTranspose(0).catch((e: unknown) =>
                console.error("[KeyTranspose] reset failed:", e)
              )
            }
            disabled={disabled}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export default KeyTranspose;
