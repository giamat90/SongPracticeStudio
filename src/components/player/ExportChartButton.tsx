import { useEffect, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useLibraryStore } from "../../stores/library";
import { clearChordEdits, hasChordEdits, readSongChords, redetectSongChords } from "../../lib/tauri";
import { exportChordChart } from "../../lib/exports";
import type { Song } from "../../lib/types";

interface ExportChartButtonProps {
  song: Song;
}

/**
 * Saves the chords as a text chord sheet, detects them again with the current
 * model, and drops the user's corrections (re-detecting replaces them too, so
 * it asks first when there are any).
 */
export default function ExportChartButton({ song }: ExportChartButtonProps) {
  const [busy, setBusy] = useState<"export" | "detect" | "reset" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const revision = usePlayerStore((s) => s.chordsRevision);

  useEffect(() => {
    setConfirming(false);
    if (!song.hasChords) {
      setEdited(false);
      return;
    }
    let cancelled = false;
    hasChordEdits(song.id)
      .then((result) => { if (!cancelled) setEdited(result); })
      .catch((e: unknown) => console.error("[ExportChartButton] hasChordEdits failed:", e));
    return () => { cancelled = true; };
  }, [song.id, song.hasChords, revision]);

  const handleReset = async () => {
    setBusy("reset");
    setMessage(null);
    try {
      await clearChordEdits(song.id);
      usePlayerStore.getState().bumpChordsRevision();
    } catch (e) {
      console.error("[ExportChartButton] clearing the chord edits failed:", e);
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy("export");
    setMessage(null);
    try {
      const segments = await readSongChords(song.id);
      const { transpose, capo } = usePlayerStore.getState();
      await exportChordChart({
        title: song.title,
        key: song.detectedKey,
        bpm: song.detectedBpm,
        segments,
        transpose,
        capo,
      });
    } catch (e) {
      console.error("[ExportChartButton] chord chart export failed:", e);
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDetect = async () => {
    setConfirming(false);
    setBusy("detect");
    setMessage(null);
    try {
      await redetectSongChords(song.id);
      await useLibraryStore.getState().fetchSongs();
      usePlayerStore.setState((s) => (s.song ? { song: { ...s.song, hasChords: true } } : {}));
      usePlayerStore.getState().bumpChordsRevision();
    } catch (e) {
      console.error("[ExportChartButton] chord re-detection failed:", e);
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="export-chart">
      {song.hasChords && (
        <button
          className="analyzer-page__export-mix"
          onClick={() => void handleExport()}
          disabled={busy !== null}
          title="Save the chords as a text chord sheet"
          aria-label="Export the chords as a text chord sheet"
        >
          {busy === "export" ? "Exporting…" : "Export Chords"}
        </button>
      )}
      {edited && (
        <button
          className="analyzer-page__export-mix"
          onClick={() => void handleReset()}
          disabled={busy !== null}
          title="Throw away your corrections and show the detected chords again"
          aria-label="Reset the chord corrections"
        >
          {busy === "reset" ? "Resetting…" : "Reset edits"}
        </button>
      )}
      {confirming ? (
        <span className="takes-bar__confirm" role="alertdialog" aria-label="Detect the chords again">
          Your corrections are replaced.
          <button className="takes-bar__confirm-yes" onClick={() => void handleDetect()}>Re-detect</button>
          <button className="takes-bar__confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <button
          className="analyzer-page__export-mix"
          onClick={() => (edited ? setConfirming(true) : void handleDetect())}
          disabled={busy !== null}
          title="Detect the chords again from the stems, following the beats"
          aria-label="Detect the chords again"
        >
          {busy === "detect" ? "Detecting…" : song.hasChords ? "Re-detect chords" : "Detect chords"}
        </button>
      )}
      {message && <span className="export-chart__error" role="alert">{message}</span>}
    </span>
  );
}
