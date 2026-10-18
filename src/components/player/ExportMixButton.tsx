import { useExportMix } from "@giamat90/mps-core/hooks";
import { usePlayerStore, buildMixSources } from "../../stores/player";
import { exportMix } from "../../lib/tauri";

function ExportMixButton() {
  const mix = useExportMix({
    store: usePlayerStore,
    watch: [
      (s) => s.stemVolumes,
      (s) => s.mutedStems,
      (s) => s.soloedStem,
      (s) => s.takeVolume,
      (s) => s.activeTakeId,
    ],
    buildMixSources,
    exportMix,
  });

  return (
    <button
      className="analyzer-page__export-mix"
      onClick={() => void mix.onExport()}
      disabled={!mix.canExport || mix.isExporting}
      title={mix.canExport ? "Export the currently audible mix as a WAV file" : "No audible tracks to export"}
      aria-label={mix.canExport ? "Export the currently audible mix as a WAV file" : "No audible tracks to export"}
    >
      {mix.isExporting ? "Exporting…" : "Export Mix"}
    </button>
  );
}

export default ExportMixButton;
