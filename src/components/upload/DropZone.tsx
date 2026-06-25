import { open } from "@tauri-apps/plugin-dialog";
import { useLibraryStore } from "../../stores/library";

const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"];

function DropZone() {
  const uploadSong = useLibraryStore((s) => s.uploadSong);
  const processing = useLibraryStore((s) => s.processing);
  const isProcessing = processing !== null;

  const handleClick = async () => {
    if (isProcessing) return;

    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Audio",
          extensions: AUDIO_EXTENSIONS,
        },
      ],
    });

    if (selected) {
      uploadSong(selected);
    }
  };

  return (
    <button
      className={`dropzone ${isProcessing ? "dropzone--busy" : ""}`}
      onClick={handleClick}
      disabled={isProcessing}
    >
      {isProcessing ? (
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
      ) : (
        <div className="dropzone__idle">
          <div className="dropzone__icon">+</div>
          <div className="dropzone__label">Upload a song</div>
          <div className="dropzone__hint">
            MP3, WAV, FLAC, OGG, M4A
          </div>
        </div>
      )}
    </button>
  );
}

export default DropZone;
