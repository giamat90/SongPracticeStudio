import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useChordSegments } from "../../lib/chords";
import { transposeChord, transposeNote } from "../../lib/chordNames";
import { saveChordEdits } from "../../lib/tauri";
import { useChordSelection } from "../../stores/chordSelection";
import type { ChordSegment, Song } from "../../lib/types";

/**
 * Saving a correction of a song's chords: the stored list, the conversions between the chords as shown (transpose
 * and capo applied) and as stored, and a `commit` that writes a new list, refreshes everything that reads the
 * chords and picks (or, with null, puts away) the chord the user is on.
 */
export function useChordCommit(song: Song) {
  const { stored, shift } = useChordSegments(song);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      else useChordSelection.getState().select(nextSelected);
    } catch (e) {
      console.error("[useChordCommit] saving the chord edit failed:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return { stored, shift, busy, error, setError, toStored, bassToStored, commit };
}
