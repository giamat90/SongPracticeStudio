import { useEffect } from "react";
import DropZone from "../components/upload/DropZone";
import YouTubeImport from "../components/upload/YouTubeImport";
import type { Song } from "../lib/types";
import { useLibraryStore } from "../stores/library";

interface LibraryPageProps {
  onSelectSong: (songId: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SongCardProps {
  song: Song;
  onSelect: () => void;
  onDelete: () => void;
}

function SongCard({ song, onSelect, onDelete }: SongCardProps) {
  return (
    <div className="song-card" onClick={onSelect}>
      <div className="song-card__info">
        <div className="song-card__title">{song.title}</div>
        <div className="song-card__meta">
          {song.detectedBpm && <span>{Math.round(song.detectedBpm)} BPM</span>}
          {song.detectedKey && <span>{song.detectedKey}</span>}
          <span>{formatDuration(song.duration)}</span>
          {song.stems.length > 0 && (
            <span>{song.stems.length} stems</span>
          )}
        </div>
      </div>
      <div
        className="song-card__actions"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="song-card__delete"
          onClick={onDelete}
          title="Delete song"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

function LibraryPage({ onSelectSong }: LibraryPageProps) {
  const songs               = useLibraryStore((s) => s.songs);
  const isLoading           = useLibraryStore((s) => s.isLoading);
  const error               = useLibraryStore((s) => s.error);
  const fetchSongs          = useLibraryStore((s) => s.fetchSongs);
  const deleteSong          = useLibraryStore((s) => s.deleteSong);
  const clearError          = useLibraryStore((s) => s.clearError);
  const initProgressListener = useLibraryStore((s) => s.initProgressListener);

  useEffect(() => {
    fetchSongs();
    const cleanupPromise = initProgressListener();
    return () => {
      cleanupPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1>Song Analyzer</h1>
      </header>

      <div className="library-page__import">
        <DropZone />
        <YouTubeImport />
      </div>

      {error && (
        <div className="library-page__error" role="alert">
          <span className="library-page__error-msg">{error}</span>
          <button
            className="library-page__error-close"
            onClick={clearError}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      <section className="library-page__list">
        {isLoading && <p className="library-page__loading">Loading...</p>}

        {!isLoading && songs.length === 0 && (
          <p className="library-page__empty">
            No songs yet. Drop an audio file or paste a YouTube URL to get started.
          </p>
        )}

        {songs.map((song) => (
          <SongCard
            key={song.id}
            song={song}
            onSelect={() => onSelectSong(song.id)}
            onDelete={() => deleteSong(song.id)}
          />
        ))}
      </section>
    </div>
  );
}

export default LibraryPage;
