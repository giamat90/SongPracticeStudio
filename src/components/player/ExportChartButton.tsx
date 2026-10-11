import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useLibraryStore } from "../../stores/library";
import { readSongChords, redetectSongChords } from "../../lib/tauri";
import { exportChordChart } from "../../lib/exports";
import type { Song } from "../../lib/types";

interface ExportChartButtonProps {
  song: Song;
}

/** Saves the detected chords as a text chord sheet, and detects them again with the current model. */
export default function ExportChartButton({ song }: ExportChartButtonProps) {
  const [busy, setBusy] = useState<"export" | "detect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    setBusy("detect");
    setMessage(null);
    try {
      await redetectSongChords(song.id);
      await useLibraryStore.getState().fetchSongs();
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
      <button
        className="analyzer-page__export-mix"
        onClick={() => void handleDetect()}
        disabled={busy !== null}
        title="Detect the chords again from the stems: sevenths and slash chords"
        aria-label="Detect the chords again"
      >
        {busy === "detect" ? "Detecting…" : song.hasChords ? "Re-detect chords" : "Detect chords"}
      </button>
      {message && <span className="export-chart__error" role="alert">{message}</span>}
    </span>
  );
}
