import { useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useChordSegments, findActiveChordIndex, formatChordName, isUnsure } from "../../lib/chords";
import { addChordAt } from "../../lib/chordEdit";
import { saveChordEdits } from "../../lib/tauri";
import { useChordSelection } from "../../stores/chordSelection";
import type { Song } from "../../lib/types";
import ChordEditorHost from "./ChordEditorHost";

interface ChordRowProps {
  song: Song;
}

// Below this width a label can't render without clipping into an
// unreadable smear against its neighbors, so narrow, non-active segments
// fall back to an unlabeled tick mark at their boundary.
const MIN_LABEL_PX = 28;

export default function ChordRow({ song }: ChordRowProps) {
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const scrollTime  = usePlayerStore((s) => s.scrollTime);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const isPlaying   = usePlayerStore((s) => s.isPlaying);
  const { segments, display, stored, activeIndex } = useChordSegments(song);
  const selected = useChordSelection((s) => s.index);
  const pickedHere = useChordSelection((s) => s.surface === "row");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    useChordSelection.getState().clear();
    setError(null);
  }, [song.id]);

  if (!song.hasChords || minPxPerSec <= 0) return null;

  const picked = selected !== null && selected < segments.length ? selected : null;

  const inGap = !isPlaying && currentTime >= 0 && currentTime < song.duration
    && findActiveChordIndex(segments, currentTime) < 0;
  const addX = (currentTime - scrollTime) * minPxPerSec;

  const handleAdd = async () => {
    const previous = [...stored].reverse().find((s) => s.end <= currentTime);
    const added = addChordAt(stored, currentTime, previous?.chord ?? "C:maj", song.duration);
    if (!added) {
      setError("There is no room for a chord here.");
      return;
    }
    setError(null);
    try {
      await saveChordEdits(song.id, added.segments);
      usePlayerStore.getState().bumpChordsRevision();
      useChordSelection.getState().select(added.index, "row");
    } catch (e) {
      console.error("[ChordRow] saving the chord edit failed:", e);
      setError(String(e));
    }
  };

  return (
    <>
      <div className="chord-row">
        {segments.map((seg, i) => {
          const isActive = i === activeIndex;
          const name = formatChordName(display[i].chord, display[i].bass);
          const width = (seg.end - seg.start) * minPxPerSec;
          const showLabel = isActive || width >= MIN_LABEL_PX || i === picked;
          const classes = [
            "chord-row__chip",
            isActive ? "chord-row__chip--active" : "",
            i === picked ? "chord-row__chip--selected" : "",
            isUnsure(seg) ? "chord-row__chip--unsure" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={`${seg.start}-${seg.chord}`}
              type="button"
              className={classes}
              style={{
                left: `${(seg.start - scrollTime) * minPxPerSec}px`,
                width: `${width}px`,
              }}
              onClick={() => { useChordSelection.getState().toggle(i, "row"); setError(null); }}
              title={isUnsure(seg) ? `${name}: not sure about this one, click to correct` : `${name}: click to correct`}
              aria-label={`Chord ${name} at ${seg.start.toFixed(1)} seconds`}
              aria-pressed={i === picked && pickedHere}
            >
              {showLabel ? name : null}
            </button>
          );
        })}
        {inGap && addX >= 0 && (
          <button
            type="button"
            className="chord-row__add"
            style={{ left: `${addX}px` }}
            onClick={() => void handleAdd()}
            title="Add a chord at the playhead"
            aria-label="Add a chord at the playhead"
          >
            +
          </button>
        )}
      </div>
      <ChordEditorHost song={song} surface="row" />
      {error && <div className="chord-editor__error" role="alert">{error}</div>}
    </>
  );
}
