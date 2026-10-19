import { useEffect, useMemo, useState } from "react";
import { getEngine, usePlayerStore } from "../../stores/player";
import { useChordSegments } from "../../lib/chords";
import { transposeChord, transposeNote } from "../../lib/chordNames";
import {
  MIN_CHORD_SECONDS, deleteChordAt, joinWithNext, setChordAt, setChordEnd, setChordStart, splitChordAt,
} from "../../lib/chordEdit";
import { keyChords } from "../../lib/keyChords";
import { readChordTuning, saveChordEdits } from "../../lib/tauri";
import { useChordSelection, type ChordSurface } from "../../stores/chordSelection";
import type { ChordSegment, Song } from "../../lib/types";
import ChordEditor from "./ChordEditor";

interface ChordEditorHostProps {
  song: Song;
  /** The editor shows here only when the chord was picked here. */
  surface: ChordSurface;
}

/** The editor for the chord picked on `surface`, with the saving that goes with it. Shows nothing when no chord is picked there. */
export default function ChordEditorHost({ song, surface }: ChordEditorHostProps) {
  const { segments, stored, shift } = useChordSegments(song);
  const capo = usePlayerStore((s) => s.capo);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const index = useChordSelection((s) => (s.surface === surface ? s.index : null));
  const [tuningCents, setTuningCents] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = index !== null && index < segments.length ? index : null;
  const editing = picked !== null;

  useEffect(() => { setError(null); }, [index, song.id]);

  // Read when a chord is opened for correcting: it is only used to tune what is heard.
  useEffect(() => {
    if (!editing || !song.hasChords) return;
    let cancelled = false;
    readChordTuning(song.id)
      .then((cents) => { if (!cancelled) setTuningCents(cents); })
      .catch((e: unknown) => console.error("[ChordEditorHost] readChordTuning failed:", e));
    return () => { cancelled = true; };
  }, [editing, song.id, song.hasChords, revision]);

  const spectrumSource = useMemo(() => ({
    stems: song.stems,
    samples: (names: readonly string[], from: number, to: number) => getEngine().getStemSamples(names, from, to),
  }), [song.stems]);

  if (picked === null) return null;
  const shown = segments[picked];

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
      if (nextSelected === null) useChordSelection.getState().clear();
      else useChordSelection.getState().select(nextSelected, surface);
    } catch (e) {
      console.error("[ChordEditorHost] saving the chord edit failed:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const playhead = () => usePlayerStore.getState().currentTime;

  return (
    <ChordEditor
      segment={shown}
      soundingOffset={capo}
      tuningCents={tuningCents}
      suggestions={shown.alternatives ?? []}
      keyChordNames={keyChords(song.detectedKey, shift)}
      spectrumSource={spectrumSource}
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
      onClose={() => useChordSelection.getState().clear()}
    />
  );
}
