import { useCountInButton } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function CountInButton() {
  const countIn = useCountInButton(usePlayerStore);

  return (
    <button
      className={`count-in-btn ${countIn.countInBars > 0 ? "count-in-btn--active" : ""}`}
      onClick={countIn.onClick}
      disabled={countIn.disabled}
      aria-label={countIn.label}
      title={countIn.title}
    >
      {countIn.text}
    </button>
  );
}

export default CountInButton;
