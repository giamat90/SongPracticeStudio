import { useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useChordSegments } from "../../lib/chords";
import {
  MIN_CHORD_SECONDS, deleteChordAt, joinWithNext, setChordAt, setChordEnd, setChordStart, splitChordAt,
} from "../../lib/chordEdit";
import { keyChords } from "../../lib/keyChords";
import { readChordTuning } from "../../lib/tauri";
import { useChordSelection } from "../../stores/chordSelection";
import type { Song } from "../../lib/types";
import ChordEditor from "./ChordEditor";
import { useChordCommit } from "./useChordCommit";

interface ChordEditorHostProps {
  song: Song;
}

/** The editor for the chord picked on the chord roll, with the saving that goes with it. Shows nothing when no chord is picked. */
export default function ChordEditorHost({ song }: ChordEditorHostProps) {
  const { segments, shift } = useChordSegments(song);
  const { stored, busy, error, setError, toStored, bassToStored, commit } = useChordCommit(song);
  const capo = usePlayerStore((s) => s.capo);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const index = useChordSelection((s) => s.index);
  const candidate = useChordSelection((s) => s.candidate);
  const [tuningCents, setTuningCents] = useState(0);

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

  if (picked === null) return null;
  const shown = segments[picked];
  const playhead = () => usePlayerStore.getState().currentTime;

  return (
    <ChordEditor
      segment={shown}
      candidate={candidate && candidate.index === picked ? candidate.chord : null}
      onCandidate={(chord) => useChordSelection.getState().setCandidate(picked, chord)}
      soundingOffset={capo}
      tuningCents={tuningCents}
      suggestions={shown.alternatives ?? []}
      keyChordNames={keyChords(song.detectedKey, shift)}
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
