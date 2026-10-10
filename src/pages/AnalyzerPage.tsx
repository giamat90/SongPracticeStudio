import { useEffect } from "react";
import StemView from "../components/player/StemView";
import DownloadAllButton from "../components/player/DownloadAllButton";
import ExportMixButton from "../components/player/ExportMixButton";
import TransportControls from "../components/player/TransportControls";
import LoopButton from "../components/player/LoopButton";
import TempoControl from "../components/player/TempoControl";
import KeyTranspose from "../components/player/KeyTranspose";
import ChordCarousel from "../components/player/ChordCarousel";
import MicSelector from "../components/recording/MicSelector";
import OutputSelector from "../components/player/OutputSelector";
import RecordButton from "../components/recording/RecordButton";
import TakeList from "../components/recording/TakeList";
import LyricsPanel from "../components/lyrics/LyricsPanel";
import PanelMenu from "../components/panels/PanelMenu";
import { useLibraryStore } from "../stores/library";
import { usePlayerStore } from "../stores/player";
import { ANALYZER_PANELS, useAnalyzerPanels } from "../stores/panels";
import { canSyncLyrics } from "../lib/lyrics";

interface AnalyzerPageProps {
  songId: string;
  onBack: () => void;
}

function AnalyzerPage({ songId, onBack }: AnalyzerPageProps) {
  const songs   = useLibraryStore((s) => s.songs);
  const cleanup = usePlayerStore((s) => s.cleanup);
  const song    = songs.find((s) => s.id === songId);
  const visible = useAnalyzerPanels((s) => s.visible);

  useEffect(() => {
    return () => { cleanup(); };
  }, [songId]);

  if (!song) {
    return (
      <div className="analyzer-page">
        <button className="analyzer-page__back" onClick={onBack} aria-label="Back to library">
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
        <PanelMenu store={useAnalyzerPanels} panels={ANALYZER_PANELS} />
        <DownloadAllButton song={song} />
        <ExportMixButton />
      </header>

      <div className="analyzer-page__topbar">
        <TransportControls />
        <LoopButton />
        <TempoControl detectedBpm={song.detectedBpm} />
        <KeyTranspose />
        <div className="analyzer-page__io-group">
          <MicSelector />
          <OutputSelector />
        </div>
        <RecordButton />
        {visible.chords && <ChordCarousel song={song} />}
      </div>

      <div className="analyzer-page__body">
        {visible.lyrics && <LyricsPanel songId={songId} hasVocals={canSyncLyrics(song.stems)} />}

        <div className="analyzer-page__stems">
          <StemView song={song} />
        </div>

        {visible.takes && (
          <div className="analyzer-page__takes">
            <TakeList />
          </div>
        )}
      </div>
    </div>
  );
}

export default AnalyzerPage;
