import { useEffect, useState } from "react";
import { loadAlphaTab, type TabTrackInfo } from "../../lib/tabScore";
import { previewTransposition, type TabTransposition, type TransposeResult } from "../../lib/tabTranspose";
import type { TabViewHandle } from "./TabScoreView";

interface TabTransposeDialogProps {
  tracks: TabTrackInfo[];
  track: number | null;
  getScore: TabViewHandle["getScore"];
  onApply: (transposition: TabTransposition) => void;
  onCancel: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the preview says about a transposition, in a sentence. */
function summary(r: TransposeResult): string {
  const retuned = Object.values(r.retuned).map((t) => `${t.label.toLowerCase()} (${t.from} to ${t.to})`);
  return [
    `${plural(r.sameString, "note")} on new frets`,
    `${r.newString} on another string`,
    r.unplayable > 0 ? `${r.unplayable} that no string can play (left as written)` : null,
    ...retuned,
  ].filter(Boolean).join(", ") + ".";
}

/** The Transposition command: rewrite the stored tab by some semitones, with a preview of what it does. */
export default function TabTransposeDialog({ tracks, track, getScore, onApply, onCancel }: TabTransposeDialogProps) {
  const [semitones, setSemitones] = useState(-2);
  const [scope, setScope] = useState<"all" | number>("all");
  const [keepStrings, setKeepStrings] = useState(true);
  const [tuning, setTuning] = useState<TabTransposition["tuning"]>("auto");
  const [preview, setPreview] = useState<TransposeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const score = getScore();
    if (!score || semitones === 0) {
      setPreview(null);
      return;
    }
    loadAlphaTab()
      .then((at) => {
        if (cancelled) return;
        setPreview(previewTransposition(at, score, { semitones, tracks: scope, keepStrings, tuning }));
        setError(null);
      })
      .catch((e: unknown) => {
        console.error("[TabTransposeDialog] could not preview the transposition:", e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [getScore, semitones, scope, keepStrings, tuning]);

  const choosable = tracks.length > 1;

  return (
    <form
      className="tab-transpose"
      aria-label="Transpose the tab"
      onSubmit={(e) => {
        e.preventDefault();
        if (semitones !== 0) onApply({ semitones, tracks: scope, keepStrings, tuning });
      }}
    >
      <label className="tab-transpose__field">
        Semitones
        <input
          className="tab-transpose__number"
          type="number"
          min={-12}
          max={12}
          value={semitones}
          onChange={(e) => setSemitones(Math.max(-12, Math.min(12, Math.round(Number(e.target.value)) || 0)))}
        />
      </label>
      {choosable && (
        <label className="tab-transpose__field">
          Apply to
          <select
            className="tab-panel__select"
            value={scope === "all" ? "all" : String(scope)}
            onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}
          >
            <option value="all">All tracks</option>
            {tracks.map((t) => (
              <option key={t.index} value={t.index}>
                {t.name || `Track ${t.index + 1}`}{t.index === track ? " (shown)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="tab-panel__check">
        <input type="checkbox" checked={keepStrings} onChange={(e) => setKeepStrings(e.target.checked)} />
        keep notes on their strings
      </label>
      <label className="tab-transpose__field">
        Tuning
        <select
          className="tab-panel__select"
          value={String(tuning)}
          onChange={(e) => {
            const v = e.target.value;
            setTuning(v === "keep" || v === "auto" ? v : Number(v));
          }}
        >
          <option value="keep">Keep the tab's tuning</option>
          <option value="auto">Retune only if notes do not fit</option>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>All strings down {n}</option>)}
          {[1, 2].map((n) => <option key={-n} value={-n}>All strings up {n}</option>)}
        </select>
      </label>
      <p className="tab-transpose__preview">
        {error ?? (preview ? summary(preview) : "Choose a number of semitones.")}
      </p>
      <div className="tab-transpose__buttons">
        <button className="tab-panel__btn" type="submit" disabled={semitones === 0 || error !== null}>Transpose the tab</button>
        <button className="tab-panel__btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
