import { useEffect } from "react";
import { describeInput, levelFraction } from "../../lib/liveInput";
import { useLiveInput } from "../../stores/liveInput";

/**
 * The switch that puts what the player plays on the chord roll's notes and spectrum next to the song, with the
 * level of the input and what is wrong with it. It sits in the input strip of the top bar, next to the mic menu
 * that chooses the input it listens to.
 */
export default function MonitorControl({ songId }: { songId: string }) {
  const status = useLiveInput((s) => s.status);
  const label = useLiveInput((s) => s.label);
  const error = useLiveInput((s) => s.error);
  const levelDb = useLiveInput((s) => s.reading?.levelDb ?? null);
  const clipped = useLiveInput((s) => s.reading?.clipped ?? false);
  const toggle = useLiveInput((s) => s.toggle);

  // The input is held only while this control is on screen for this song.
  useEffect(() => () => useLiveInput.getState().stop(), [songId]);

  const on = status === "on" || status === "starting";
  const note = describeInput(status, label, error, levelDb === null ? null : { levelDb, clipped });
  const bad = note?.tone === "bad";
  const fraction = levelDb === null ? 0 : levelFraction(levelDb);

  return (
    <div className="input-monitor">
      <button
        type="button"
        className={`input-monitor__button${bad ? " input-monitor__button--bad" : ""}`}
        aria-pressed={on}
        onClick={() => void toggle()}
        title={on
          ? `${note ? `${note.text}. ` : ""}Click to stop listening to the input`
          : "Listen to the input chosen in the mic menu (a guitar, a piano, a voice) and draw it on the roll and the spectrum against the song. Nothing is recorded"}
      >
        <span className="input-monitor__icon" aria-hidden="true">🎧</span>
        Monitor
      </button>
      {status === "on" && (
        <span className="roll-meter" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span
            className={`roll-meter__fill${clipped ? " roll-meter__fill--clip" : ""}`}
            style={{ width: `${fraction * 100}%` }}
          />
        </span>
      )}
      {note && (
        <span className="input-monitor__sr" role={bad ? "alert" : "status"}>
          {note.text}
        </span>
      )}
    </div>
  );
}
