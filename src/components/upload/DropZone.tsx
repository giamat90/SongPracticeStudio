import { useLibraryStore } from "../../stores/library";
import { pickFile } from "../../lib/pickFile";
import { useDropZone } from "@giamat90/mps-core/hooks";
import type { StemName } from "../../lib/types";

interface DropZoneProps {
  stems:       StemName[];
  highQuality: boolean;
}

function DropZone({ stems, highQuality }: DropZoneProps) {
  const uploadSong   = useLibraryStore((s) => s.uploadSong);
  const { pendingFile, fileName, pick, confirm, cancel } = useDropZone({
    isProcessing: false,
    pickFile,
    onUpload: (path) => uploadSong(path, stems, highQuality),
  });

  if (pendingFile) {
    return (
      <div className="dropzone dropzone--pending">
        <div className="dropzone__pending">
          <div className="dropzone__pending-name" title={pendingFile}>{fileName}</div>
          <div className="dropzone__pending-actions">
            <button className="dropzone__btn-cancel" type="button" onClick={cancel}>
              Cancel
            </button>
            <button className="dropzone__btn-process" type="button" onClick={confirm}>
              Analyze
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button className="dropzone" onClick={pick}>
      <div className="dropzone__idle">
        <div className="dropzone__icon">+</div>
        <div className="dropzone__label">Upload a song</div>
        <div className="dropzone__hint">MP3, WAV, FLAC, OGG, M4A</div>
      </div>
    </button>
  );
}

export default DropZone;
