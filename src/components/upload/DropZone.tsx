import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLibraryStore } from "../../stores/library";
import StemPicker, { DEFAULT_STEMS } from "./StemPicker";
import type { StemName } from "../../lib/types";

const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"];

function DropZone() {
  const uploadSong   = useLibraryStore((s) => s.uploadSong);
  const processing   = useLibraryStore((s) => s.processing);
  const isProcessing = processing !== null;

  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [stems, setStems]             = useState<StemName[]>(DEFAULT_STEMS);

  const handleClick = async () => {
    if (isProcessing || pendingFile) return;

    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });

    if (selected) setPendingFile(selected);
  };

  const handleProcess = () => {
    if (!pendingFile) return;
    uploadSong(pendingFile, stems);
    setPendingFile(null);
    setStems(DEFAULT_STEMS);
  };

  const handleCancel = () => {
    setPendingFile(null);
    setStems(DEFAULT_STEMS);
  };

  if (isProcessing) {
    return (
      <div className="dropzone dropzone--busy">
        <div className="dropzone__progress">
          <div className="dropzone__stage">{processing.stage}</div>
          <div className="progress-bar">
            <div
              className="progress-bar__fill"
              style={{ width: `${Math.round(processing.progress * 100)}%` }}
            />
          </div>
          <div className="dropzone__percent">
            {Math.round(processing.progress * 100)}%
          </div>
        </div>
      </div>
    );
  }

  if (pendingFile) {
    const fileName = pendingFile.split(/[\\/]/).pop() ?? pendingFile;
    return (
      <div className="dropzone dropzone--pending">
        <div className="dropzone__pending">
          <div className="dropzone__pending-name" title={pendingFile}>{fileName}</div>
          <StemPicker value={stems} onChange={setStems} />
          <div className="dropzone__pending-actions">
            <button className="dropzone__btn-cancel" type="button" onClick={handleCancel}>
              Cancel
            </button>
            <button className="dropzone__btn-process" type="button" onClick={handleProcess}>
              Analyze
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      className="dropzone"
      onClick={handleClick}
      disabled={isProcessing}
    >
      <div className="dropzone__idle">
        <div className="dropzone__icon">+</div>
        <div className="dropzone__label">Upload a song</div>
        <div className="dropzone__hint">MP3, WAV, FLAC, OGG, M4A</div>
      </div>
    </button>
  );
}

export default DropZone;
