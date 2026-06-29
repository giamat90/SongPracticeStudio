import { useState } from "react";
import { useLibraryStore } from "../../stores/library";
import StemPicker, { DEFAULT_STEMS } from "./StemPicker";
import type { StemName } from "../../lib/types";

const YT_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//;

function YouTubeImport() {
  const [url,         setUrl]         = useState("");
  const [stems,       setStems]       = useState<StemName[]>(DEFAULT_STEMS);
  const [highQuality, setHighQuality] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const importYoutube = useLibraryStore((s) => s.importYoutube);
  const isProcessing  = useLibraryStore((s) => s.processing !== null);

  const handleImport = async () => {
    if (!YT_PATTERN.test(url)) {
      setError("Please enter a valid YouTube URL.");
      return;
    }
    setError(null);
    await importYoutube(url, stems, highQuality);
    setUrl("");
    setStems(DEFAULT_STEMS);
    setHighQuality(false);
  };

  return (
    <div className="yt-import">
      <div className="yt-import__row">
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
      </div>
      <StemPicker
        value={stems}
        onChange={setStems}
        highQuality={highQuality}
        onHighQualityChange={setHighQuality}
        disabled={isProcessing}
      />
      {error && <p className="yt-import__error">{error}</p>}
    </div>
  );
}

export default YouTubeImport;
