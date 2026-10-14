import { useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useChordSegments, findActiveChordIndex, formatChordName } from "../../lib/chords";
import { transposeChord, transposeNote } from "../../lib/chordNames";
import {
  MIN_CHORD_SECONDS, addChordAt, deleteChordAt, joinWithNext, setChordAt, setChordEnd, setChordStart, splitChordAt,
} from "../../lib/chordEdit";
import { saveChordEdits } from "../../lib/tauri";
import type { ChordSegment, Song } from "../../lib/types";
import ChordEditor from "./ChordEditor";

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
  const { segments, display, stored, shift, activeIndex } = useChordSegments(song);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(null);
    setError(null);
  }, [song.id]);

  if (!song.hasChords || minPxPerSec <= 0) return null;

  const picked = selected !== null && selected < segments.length ? selected : null;
  const shown = picked !== null ? segments[picked] : null;

  // The editor shows chords as played (transpose and capo applied); the file keeps them as detected.
  const toStored = (chord: string) => (shift === 0 ? chord : transposeChord(chord, -shift));
  const bassToStored = (note: string) => (shift === 0 ? note : transposeNote(note, -shift));

  const commit = async (next: ChordSegment[] | null, nextSelected: number | null) => {
    if (next === null) {
      setError("That does not fit here: a chord needs at least a tenth of a second on each side.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveChordEdits(song.id, next);
      usePlayerStore.getState().bumpChordsRevision();
      setSelected(nextSelected);
    } catch (e) {
      console.error("[ChordRow] saving the chord edit failed:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const playhead = () => usePlayerStore.getState().currentTime;

  const inGap = !isPlaying && currentTime >= 0 && currentTime < song.duration
    && findActiveChordIndex(segments, currentTime) < 0;
  const addX = (currentTime - scrollTime) * minPxPerSec;

  const handleAdd = () => {
    const previous = [...stored].reverse().find((s) => s.end <= currentTime);
    const added = addChordAt(stored, currentTime, previous?.chord ?? "C:maj", song.duration);
    if (!added) {
      setError("There is no room for a chord here.");
      return;
    }
    void commit(added.segments, added.index);
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
              onClick={() => { setSelected(i === picked ? null : i); setError(null); }}
              title={`${name}: click to correct`}
              aria-label={`Chord ${name} at ${seg.start.toFixed(1)} seconds`}
              aria-pressed={i === picked}
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
            onClick={handleAdd}
            title="Add a chord at the playhead"
            aria-label="Add a chord at the playhead"
          >
            +
          </button>
        )}
      </div>
      {shown && picked !== null && (
        <ChordEditor
          segment={shown}
          canSplit={currentTime - shown.start >= MIN_CHORD_SECONDS && shown.end - currentTime >= MIN_CHORD_SECONDS}
          canJoin={picked < stored.length - 1}
          busy={busy}
          error={error}
          onChord={(chord, bass) =>
            void commit(setChordAt(stored, picked, toStored(chord), bass ? bassToStored(bass) : null), picked)}
          onStartHere={() => void commit(setChordStart(stored, picked, playhead()), picked)}
          onEndHere={() => void commit(setChordEnd(stored, picked, playhead(), song.duration), picked)}
          onSplit={() => void commit(splitChordAt(stored, picked, playhead()), picked)}
          onJoin={() => void commit(joinWithNext(stored, picked), picked)}
          onDelete={() => void commit(deleteChordAt(stored, picked), null)}
          onGoTo={() => usePlayerStore.getState().seek(shown.start)}
          onClose={() => { setSelected(null); setError(null); }}
        />
      )}
      {!shown && error && <div className="chord-editor__error" role="alert">{error}</div>}
    </>
  );
}
