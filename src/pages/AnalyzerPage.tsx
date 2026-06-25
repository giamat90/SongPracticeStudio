import { useEffect } from "react";
import StemView from "../components/player/StemView";
import TransportControls from "../components/player/TransportControls";
import TempoControl from "../components/player/TempoControl";
import { useLibraryStore } from "../stores/library";
import { usePlayerStore } from "../stores/player";

interface AnalyzerPageProps {
  songId: string;
  onBack: () => void;
}

function AnalyzerPage({ songId, onBack }: AnalyzerPageProps) {
  const songs   = useLibraryStore((s) => s.songs);
  const cleanup = usePlayerStore((s) => s.cleanup);
  const song    = songs.find((s) => s.id === songId);

  useEffect(() => {
    return () => { cleanup(); };
  }, [songId]);

  if (!song) {
    return (
      <div className="analyzer-page">
        <button className="analyzer-page__back" onClick={onBack}>
          &larr; Back to Library
        </button>
        <p>Song not found.</p>
      </div>
    );
  }

  return (
    <div className="analyzer-page">
      <header className="analyzer-page__header">
        <button className="analyzer-page__back" onClick={onBack}>
          &larr; Back
        </button>
        <div className="analyzer-page__song-info">
          <h1 className="analyzer-page__title">{song.title}</h1>
          <div className="analyzer-page__meta">
            {song.detectedBpm && <span>{Math.round(song.detectedBpm)} BPM</span>}
            {song.detectedKey && <span>{song.detectedKey}</span>}
          </div>
        </div>
      </header>

      <div className="analyzer-page__body">
        <div className="analyzer-page__stems">
          <StemView song={song} />
        </div>

        <div className="analyzer-page__footer">
          <TransportControls />
          <TempoControl detectedBpm={song.detectedBpm} />
        </div>
      </div>
    </div>
  );
}

export default AnalyzerPage;
