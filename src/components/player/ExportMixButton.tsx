import { useState } from "react";
import { usePlayerStore, buildMixSources } from "../../stores/player";
import { exportMix } from "../../lib/tauri";

function ExportMixButton() {
  // Subscribe to every input buildMixSources reads, so the button's
  // disabled state stays in sync with mute/solo/volume/take changes.
  usePlayerStore((s) => s.song);
  usePlayerStore((s) => s.stemVolumes);
  usePlayerStore((s) => s.mutedStems);
  usePlayerStore((s) => s.soloedStem);
  usePlayerStore((s) => s.takeVolume);
  usePlayerStore((s) => s.activeTakeId);
  const [isExporting, setIsExporting] = useState(false);

  const mix = buildMixSources(usePlayerStore.getState());

  const handleExport = async () => {
    const state = usePlayerStore.getState();
    const built = buildMixSources(state);
    if (!built || !state.song) return;
    setIsExporting(true);
    try {
      await exportMix(built.sources, built.startSec, built.endSec, `${state.song.title} - Mixdown.wav`);
    } catch (e) {
      console.error("[ExportMixButton] exportMix failed:", e);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      className="analyzer-page__export-mix"
      onClick={() => void handleExport()}
      disabled={!mix || isExporting}
      title={mix ? "Export the currently audible mix as a WAV file" : "No audible tracks to export"}
      aria-label={mix ? "Export the currently audible mix as a WAV file" : "No audible tracks to export"}
    >
      {isExporting ? "Exporting…" : "Export Mix"}
    </button>
  );
}

export default ExportMixButton;
