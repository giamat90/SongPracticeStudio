import { useEffect, useRef, useState } from "react";
import { CHORD_NOTES, CHORD_QUALITIES, formatChordName } from "../../lib/chordNames";
import { chordSynth } from "../../audio/chordSynth";
import { usePlayerStore } from "../../stores/player";
import type { ChordAlternative, ChordSegment } from "../../lib/types";

interface ChordEditorProps {
  /** The chord as it is shown (transpose and capo applied). */
  segment: ChordSegment;
  /** Semitones from a shown chord to what sounds: the capo, which changes the shapes but not the sound. */
  soundingOffset: number;
  /** How far the recording sits from A440 in cents, so a heard chord is in tune with it. */
  tuningCents: number;
  /** Other chords the detector considered for this stretch, best first, as shown. */
  suggestions: ChordAlternative[];
  /** The chords of the song's key, as shown. */
  keyChordNames: string[];
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

/** Correct one detected chord: hear it, pick another from a list, move its ends, split, join or delete it. */
export default function ChordEditor({
  segment, soundingOffset, tuningCents, suggestions, keyChordNames, canSplit, canJoin, busy, error,
  onChord, onStartHere, onEndHere, onSplit, onJoin, onDelete, onGoTo, onClose,
}: ChordEditorProps) {
  const [root, quality] = segment.chord.split(":");
  const bass = segment.bass ?? "";
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const [preview, setPreview] = useState<string | null>(null);
  const [withSong, setWithSong] = useState(false);
  const withSongRef = useRef(false);
  withSongRef.current = withSong;

  // A different chord selected (or this one corrected) starts from a clean preview.
  useEffect(() => { setPreview(null); }, [segment.start, segment.chord]);

  const heard = preview ?? segment.chord;
  const heardBass = preview ? null : segment.bass ?? null;

  const hear = (chord: string, bassNote: string | null) =>
    chordSynth.play({ chord, bass: bassNote, semitones: soundingOffset, cents: tuningCents });

  // "With the song": the chord is held while the song plays through this chord,
  // so the two can be compared on the same notes; the chord's own stretch loops.
  useEffect(() => {
    if (!withSong) return;
    const inside = isPlaying && currentTime >= segment.start && currentTime < segment.end;
    if (inside) chordSynth.hold({ chord: heard, bass: heardBass, semitones: soundingOffset, cents: tuningCents });
    else chordSynth.stop();
  }, [withSong, isPlaying, currentTime, segment.start, segment.end, heard, heardBass, soundingOffset, tuningCents]);

  useEffect(() => {
    if (!withSong) return;
    const s = usePlayerStore.getState();
    s.setPunchIn(segment.start);
    s.setPunchOut(segment.end);
  }, [withSong, segment.start, segment.end]);

  useEffect(() => () => {
    chordSynth.stop();
    if (withSongRef.current) {
      const s = usePlayerStore.getState();
      s.pause();
      s.clearPunch();
    }
  }, []);

  const toggleWithSong = () => {
    const s = usePlayerStore.getState();
    if (!withSong) {
      s.setPunchIn(segment.start);
      s.setPunchOut(segment.end);
      s.setPunchLoop(true);
      s.seek(segment.start);
      s.play();
      setWithSong(true);
    } else {
      s.pause();
      s.clearPunch();
      chordSynth.stop();
      setWithSong(false);
    }
  };

  const choose = (chord: string, bassNote: string | null) => {
    hear(chord, bassNote);
    onChord(chord, bassNote);
  };

  const audition = (chord: string) => {
    setPreview(chord === segment.chord ? null : chord);
    hear(chord, null);
  };

  const use = (chord: string) => {
    setPreview(null);
    onChord(chord, null);
  };

  const others = suggestions.filter((s) => s.chord !== segment.chord);
  const inKey = keyChordNames.filter((c) => c !== segment.chord);

  const chip = (chord: string, detail?: string) => (
    <button
      key={chord}
      type="button"
      className={`chord-editor__chip${preview === chord ? " chord-editor__chip--previewed" : ""}`}
      disabled={busy}
      onClick={() => audition(chord)}
      onDoubleClick={() => use(chord)}
      title={`Hear ${formatChordName(chord)} (double-click to use it)`}
      aria-label={`Hear ${formatChordName(chord)}${detail ? `, ${detail}` : ""}`}
      aria-pressed={preview === chord}
    >
      {formatChordName(chord)}
      {detail && <span className="chord-editor__fit">{detail}</span>}
    </button>
  );

  return (
    <div className="chord-editor" role="group" aria-label={`Edit chord ${formatChordName(segment.chord, segment.bass)}`}>
      <span className="chord-editor__name">{formatChordName(segment.chord, segment.bass)}</span>
      <select
        className="chord-editor__select"
        value={root}
        disabled={busy}
        onChange={(e) => choose(`${e.target.value}:${quality}`, segment.bass ?? null)}
        aria-label="Chord root"
      >
        {CHORD_NOTES.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select
        className="chord-editor__select"
        value={quality}
        disabled={busy}
        onChange={(e) => choose(`${root}:${e.target.value}`, segment.bass ?? null)}
        aria-label="Chord quality"
      >
        {CHORD_QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
      </select>
      <select
        className="chord-editor__select"
        value={bass}
        disabled={busy}
        onChange={(e) => choose(segment.chord, e.target.value || null)}
        aria-label="Bass note"
        title="The bass note, when it is not the root (a slash chord)"
      >
        <option value="">no slash bass</option>
        {CHORD_NOTES.map((n) => <option key={n} value={n}>/{n}</option>)}
      </select>
      <button
        className="chord-editor__button"
        onClick={() => hear(heard, heardBass)}
        title="Play this chord on a synthesiser, tuned to the recording"
      >
        Hear
      </button>
      <button
        className={`chord-editor__button${withSong ? " chord-editor__button--on" : ""}`}
        onClick={toggleWithSong}
        aria-pressed={withSong}
        title="Loop this part of the song with the chord sounding under it, to compare them"
      >
        With song
      </button>
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

      {others.length > 0 && (
        <div className="chord-editor__list" role="group" aria-label="Other chords the detector considered">
          <span className="chord-editor__list-label">Also heard</span>
          {others.map((s) => chip(s.chord, `${Math.round(s.fit * 100)}%`))}
        </div>
      )}
      {inKey.length > 0 && (
        <div className="chord-editor__list" role="group" aria-label="Chords of the song's key">
          <span className="chord-editor__list-label">In this key</span>
          {inKey.map((c) => chip(c))}
        </div>
      )}
      {preview && (
        <div className="chord-editor__list">
          <button
            className="chord-editor__button chord-editor__button--primary"
            onClick={() => use(preview)}
            disabled={busy}
          >
            Use {formatChordName(preview)}
          </button>
          <button className="chord-editor__button" onClick={() => setPreview(null)}>Keep {formatChordName(segment.chord, segment.bass)}</button>
        </div>
      )}
    </div>
  );
}
