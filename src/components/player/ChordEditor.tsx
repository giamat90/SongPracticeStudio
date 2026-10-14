import { CHORD_NOTES, CHORD_QUALITIES, formatChordName } from "../../lib/chordNames";
import type { ChordSegment } from "../../lib/types";

interface ChordEditorProps {
  /** The chord as it is shown (transpose and capo applied). */
  segment: ChordSegment;
  canSplit: boolean;
  canJoin: boolean;
  busy: boolean;
  error: string | null;
  onChord: (chord: string, bass: string | null) => void;
  onStartHere: () => void;
  onEndHere: () => void;
  onSplit: () => void;
  onJoin: () => void;
  onDelete: () => void;
  onGoTo: () => void;
  onClose: () => void;
}

const seconds = (t: number) => `${t.toFixed(2)} s`;

/** Correct one detected chord: its name, where it starts and ends, or remove / split / join it. */
export default function ChordEditor({
  segment, canSplit, canJoin, busy, error,
  onChord, onStartHere, onEndHere, onSplit, onJoin, onDelete, onGoTo, onClose,
}: ChordEditorProps) {
  const [root, quality] = segment.chord.split(":");
  const bass = segment.bass ?? "";

  return (
    <div className="chord-editor" role="group" aria-label={`Edit chord ${formatChordName(segment.chord, segment.bass)}`}>
      <span className="chord-editor__name">{formatChordName(segment.chord, segment.bass)}</span>
      <select
        className="chord-editor__select"
        value={root}
        disabled={busy}
        onChange={(e) => onChord(`${e.target.value}:${quality}`, segment.bass ?? null)}
        aria-label="Chord root"
      >
        {CHORD_NOTES.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select
        className="chord-editor__select"
        value={quality}
        disabled={busy}
        onChange={(e) => onChord(`${root}:${e.target.value}`, segment.bass ?? null)}
        aria-label="Chord quality"
      >
        {CHORD_QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
      </select>
      <select
        className="chord-editor__select"
        value={bass}
        disabled={busy}
        onChange={(e) => onChord(segment.chord, e.target.value || null)}
        aria-label="Bass note"
        title="The bass note, when it is not the root (a slash chord)"
      >
        <option value="">no slash bass</option>
        {CHORD_NOTES.map((n) => <option key={n} value={n}>/{n}</option>)}
      </select>
      <span className="chord-editor__time">{seconds(segment.start)} – {seconds(segment.end)}</span>
      <button className="chord-editor__button" onClick={onGoTo} disabled={busy} title="Move the playhead to the start of this chord">
        Go to
      </button>
      <button className="chord-editor__button" onClick={onStartHere} disabled={busy} title="Make this chord start at the playhead">
        Start here
      </button>
      <button className="chord-editor__button" onClick={onEndHere} disabled={busy} title="Make this chord end at the playhead">
        End here
      </button>
      <button className="chord-editor__button" onClick={onSplit} disabled={busy || !canSplit} title="Cut this chord in two at the playhead">
        Split here
      </button>
      <button className="chord-editor__button" onClick={onJoin} disabled={busy || !canJoin} title="Merge the next chord into this one">
        Join next
      </button>
      <button className="chord-editor__button chord-editor__button--danger" onClick={onDelete} disabled={busy} title="Remove this chord">
        Delete
      </button>
      <button className="chord-editor__button" onClick={onClose} aria-label="Close the chord editor">
        Done
      </button>
      {error && <span className="chord-editor__error" role="alert">{error}</span>}
    </div>
  );
}
