import { useEffect, useState } from "react";
import { loadAlphaTab } from "../../lib/tabScore";
import { allStrings, describeOffsets, lowestString, pitchName } from "../../lib/tabTranspose";

interface TabTuningEditorProps {
  /** The open strings of the tab as stored, lowest first. */
  base: number[];
  /** Offsets to start from (the tuning already chosen), lowest string first. */
  initial: number[];
  /** Shown for the song's transposition: the choice is kept per transposition and the frets are always recomputed. */
  forTransposition: boolean;
  onApply: (offsets: number[], keepPitch: boolean) => void;
  onCancel: () => void;
}

const MAX_SHIFT = 12;

/** Pick the open strings of a track: a preset, or each string up or down in semitones. */
export default function TabTuningEditor({ base, initial, forTransposition, onApply, onCancel }: TabTuningEditorProps) {
  const [offsets, setOffsets] = useState<number[]>(() => base.map((_, i) => initial[i] ?? 0));
  const [keepPitch, setKeepPitch] = useState(true);
  const [names, setNames] = useState<((pitch: number) => string) | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAlphaTab()
      .then((at) => { if (!cancelled) setNames(() => (pitch: number) => pitchName(at, pitch)); })
      .catch((e: unknown) => console.error("[TabTuningEditor] could not load the notation library:", e));
    return () => { cancelled = true; };
  }, []);

  const preset = (values: number[]) => setOffsets(base.map((_, i) => values[i] ?? 0));
  const nudge = (index: number, by: number) =>
    setOffsets((current) => current.map((v, i) => (i === index ? Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, v + by)) : v)));
  const presets = [
    { label: "Tab's tuning", values: [] as number[] },
    { label: "Drop (lowest down 2)", values: lowestString(2) },
    ...[1, 2, 3].map((n) => ({ label: `All down ${n}`, values: allStrings(n) })),
  ];
  const isPreset = (values: number[]) => offsets.every((v, i) => v === (values[i] ?? 0));
  const changed = offsets.some((v) => v !== 0);

  return (
    <form
      className="tab-tuning"
      aria-label="Tune the instrument"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(offsets, keepPitch);
      }}
    >
      <div className="tab-tuning__presets">
        {presets.map(({ label, values }) => (
          <button
            key={label}
            className={`tab-panel__btn${isPreset(values) ? " tab-panel__btn--on" : ""}`}
            type="button"
            aria-pressed={isPreset(values)}
            onClick={() => preset(values)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tab-tuning__strings">
        {/* Highest string first, as a tab is read. */}
        {base.map((_, i) => i).reverse().map((i) => (
          <div key={i} className="tab-tuning__string">
            <button className="tab-panel__btn" type="button" aria-label={`String ${base.length - i} down`} onClick={() => nudge(i, 1)}>−</button>
            <span className="tab-tuning__note" title={`was ${names ? names(base[i]) : base[i]}`}>
              {names ? names(base[i] - offsets[i]) : base[i] - offsets[i]}
            </span>
            <button className="tab-panel__btn" type="button" aria-label={`String ${base.length - i} up`} onClick={() => nudge(i, -1)}>+</button>
          </div>
        ))}
      </div>
      <p className="tab-transpose__preview">
        {describeOffsets(offsets, base.length)}
        {forTransposition
          ? ". Saved for this transposition only; the frets are worked out again for these strings."
          : ". Changes the tab itself."}
      </p>
      {!forTransposition && (
        <label className="tab-panel__check">
          <input type="checkbox" checked={keepPitch} onChange={(e) => setKeepPitch(e.target.checked)} />
          keep the notes' pitch (re-fret them); off keeps the frets, so the pitch moves
        </label>
      )}
      <div className="tab-transpose__buttons">
        <button className="tab-panel__btn" type="submit" disabled={!changed && !forTransposition}>
          {forTransposition ? "Use this tuning" : "Change the tuning"}
        </button>
        <button className="tab-panel__btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
