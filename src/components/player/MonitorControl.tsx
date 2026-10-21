import { describeInput, levelFraction } from "../../lib/liveInput";
import { useLiveInput } from "../../stores/liveInput";

/**
 * The switch that puts what the player plays on the chord roll's notes and spectrum next to the song, with the
 * level of the input and what is wrong with it. The input is the one chosen in the mic menu of the top bar.
 */
export default function MonitorControl() {
  const status = useLiveInput((s) => s.status);
  const label = useLiveInput((s) => s.label);
  const error = useLiveInput((s) => s.error);
  const levelDb = useLiveInput((s) => s.reading?.levelDb ?? null);
  const clipped = useLiveInput((s) => s.reading?.clipped ?? false);
  const toggle = useLiveInput((s) => s.toggle);

  const on = status === "on" || status === "starting";
  const note = describeInput(status, label, error, levelDb === null ? null : { levelDb, clipped });

  return (
    <div className="roll-monitor">
      <button
        type="button"
        className="roll-monitor__button"
        aria-pressed={on}
        onClick={() => void toggle()}
        title={on
          ? "Stop listening to the input"
          : "Listen to the input chosen in the mic menu (a guitar, a piano, a voice) and draw it on the roll and the spectrum against the song. Nothing is recorded"}
      >
        <span className="roll-monitor__dot" aria-hidden="true" />
        Monitor
      </button>
      {status === "on" && levelDb !== null && (
        <span className="roll-meter" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(levelFraction(levelDb) * 100)}>
          <span
            className={`roll-meter__fill${clipped ? " roll-meter__fill--clip" : ""}`}
            style={{ width: `${levelFraction(levelDb) * 100}%` }}
          />
        </span>
      )}
      {note && (
        <span className={`roll-monitor__note${note.tone === "bad" ? " roll-monitor__note--bad" : ""}`} role={note.tone === "bad" ? "alert" : "status"}>
          {note.text}
        </span>
      )}
    </div>
  );
}
