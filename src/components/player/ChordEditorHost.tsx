import { useEffect, useState, type ReactNode } from "react";
import { usePlayerStore } from "../../stores/player";
import { useChordSegments } from "../../lib/chords";
import {
  MIN_CHORD_SECONDS, deleteChordAt, joinWithNext, setChordEnd, setChordStart, splitChordAt,
} from "../../lib/chordEdit";
import { keyChords } from "../../lib/keyChords";
import { readChordTuning } from "../../lib/tauri";
import { useChordSelection } from "../../stores/chordSelection";
import type { Song } from "../../lib/types";
import ChordEditor, { type EditorParts } from "./ChordEditor";
import { useChordCommit } from "./useChordCommit";

interface ChordEditorHostProps {
  song: Song;
  /** Draws what the roll shows around the editor; `parts` is null while no chord is picked. */
  children: (parts: EditorParts | null) => ReactNode;
}

/** The editor for the chord picked on the chord roll, with the saving that goes with it; hands its parts to `children`, or null when no chord is picked. */
export default function ChordEditorHost({ song, children }: ChordEditorHostProps) {
  const { segments, shift } = useChordSegments(song);
  const { stored, busy, error, setError, commit } = useChordCommit(song);
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

  if (picked === null) return <>{children(null)}</>;
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
      onStartHere={() => void commit(setChordStart(stored, picked, playhead()), picked)}
      onEndHere={() => void commit(setChordEnd(stored, picked, playhead(), song.duration), picked)}
      onSplit={() => void commit(splitChordAt(stored, picked, playhead()), picked)}
      onJoin={() => void commit(joinWithNext(stored, picked), picked)}
      onDelete={() => void commit(deleteChordAt(stored, picked), null)}
      onGoTo={() => usePlayerStore.getState().seek(shown.start)}
      onClose={() => useChordSelection.getState().clear()}
    >
      {children}
    </ChordEditor>
  );
}
