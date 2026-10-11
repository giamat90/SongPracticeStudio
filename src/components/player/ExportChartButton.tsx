import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { readSongChords } from "../../lib/tauri";
import { exportChordChart } from "../../lib/exports";
import type { Song } from "../../lib/types";

const CAPO_FRETS = [0, 1, 2, 3, 4, 5, 6, 7];

interface ExportChartButtonProps {
  song: Song;
}

/** Saves the detected chords as a text chord sheet, in the current key, optionally as capo shapes. */
export default function ExportChartButton({ song }: ExportChartButtonProps) {
  const [capo, setCapo] = useState(0);
  const [exporting, setExporting] = useState(false);
  if (!song.hasChords) return null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const segments = await readSongChords(song.id);
      await exportChordChart({
        title: song.title,
        key: song.detectedKey,
        bpm: song.detectedBpm,
        segments,
        transpose: usePlayerStore.getState().transpose,
        capo,
      });
    } catch (e) {
      console.error("[ExportChartButton] chord chart export failed:", e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <span className="export-chart">
      <button
        className="analyzer-page__export-mix"
        onClick={() => void handleExport()}
        disabled={exporting}
        title="Save the chords as a text chord sheet"
        aria-label="Export the chords as a text chord sheet"
      >
        {exporting ? "Exporting…" : "Export Chords"}
      </button>
      <select
        className="export-chart__capo"
        value={capo}
        onChange={(e) => setCapo(Number(e.target.value))}
        title="Capo: write the chords as the shapes to play with the capo on this fret"
        aria-label="Capo fret"
      >
        {CAPO_FRETS.map((f) => (
          <option key={f} value={f}>{f === 0 ? "No capo" : `Capo ${f}`}</option>
        ))}
      </select>
    </span>
  );
}
