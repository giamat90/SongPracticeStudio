import { useDownloadAll } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";
import { exportAll, type ZipExportEntry } from "../../lib/tauri";
import type { Song } from "../../lib/types";

function trackEntries(song: Song, directory: string): ZipExportEntry[] {
  return song.stems.map((name) => ({
    path: `${directory}/${name}.wav`,
    archiveName: `${name.charAt(0).toUpperCase() + name.slice(1)}.wav`,
  }));
}

function DownloadAllButton({ song }: { song: Song }) {
  const download = useDownloadAll({ store: usePlayerStore, song, trackEntries, exportAll });

  return (
    <button
      className="analyzer-page__download-all"
      onClick={() => void download.onDownload()}
      disabled={download.isExporting}
      title="Download all stems and takes as a zip archive"
    >
      {download.isExporting ? "Zipping…" : "Download All"}
    </button>
  );
}

export default DownloadAllButton;
