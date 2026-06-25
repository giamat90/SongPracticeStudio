import { useState } from "react";
import { useLibraryStore } from "../../stores/library";

const YT_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//;

function YouTubeImport() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const importYoutube = useLibraryStore((s) => s.importYoutube);
  const isProcessing = useLibraryStore((s) => s.processing !== null);

  const handleImport = async () => {
    if (!YT_PATTERN.test(url)) {
      setError("Please enter a valid YouTube URL.");
      return;
    }
    setError(null);
    await importYoutube(url);
    setUrl("");
  };

  return (
    <div className="yt-import">
      <input
        className="yt-import__input"
        type="url"
        placeholder="Paste YouTube URL…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={isProcessing}
        onKeyDown={(e) => e.key === "Enter" && !isProcessing && handleImport()}
      />
      <button
        className="yt-import__btn"
        onClick={handleImport}
        disabled={isProcessing || !url.trim()}
      >
        Import
      </button>
      {error && <p className="yt-import__error">{error}</p>}
    </div>
  );
}

export default YouTubeImport;
