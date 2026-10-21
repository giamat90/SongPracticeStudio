import { useEffect, type ReactNode } from "react";
import StemView from "../components/player/StemView";
import DownloadAllButton from "../components/player/DownloadAllButton";
import ExportMixButton from "../components/player/ExportMixButton";
import LoopsMenu from "../components/player/LoopsMenu";
import CapoSelect from "../components/player/CapoSelect";
import ChordDetailSelect from "../components/player/ChordDetailSelect";
import ExportChartButton from "../components/player/ExportChartButton";
import BassTabPanel from "../components/player/BassTabPanel";
import ChordRoll from "../components/player/ChordRoll";
import MeterPanel from "../components/player/MeterPanel";
import { MoveGrip } from "../components/panels/SortablePanels";
import TabPanel from "../components/tab/TabPanel";
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
import DetachHandle from "../components/panels/DetachHandle";
import SortablePanels from "../components/panels/SortablePanels";
import { useLibraryStore } from "../stores/library";
import { usePlayerStore } from "../stores/player";
import { useDetachedStore } from "../stores/detached";
import { ANALYZER_PANELS, useAnalyzerPanels, type AnalyzerPanelId } from "../stores/panels";
import { hiddenStemTags, useWaveformPanels, waveformMenuItems } from "../stores/waveforms";
import { canSyncLyrics } from "../lib/lyrics";
import { transposeKey } from "../lib/chords";
import { installPlayerShortcuts } from "@giamat90/mps-core/hooks";
import { isDetachablePanel, type DetachablePanel } from "../windows/protocol";
import { useMainBridge } from "../windows/useMainBridge";

/** A panel with the corner handle that moves it into a window of its own. */
function Detachable({ panel, inline, children }: { panel: DetachablePanel; inline?: boolean; children: ReactNode }) {
  return (
    <div className={`detachable${inline ? " detachable--inline" : ""}`}>
      <DetachHandle panel={panel} />
      {children}
    </div>
  );
}

// The chord carousel lives in the topbar; these are the panels stacked under the tracks.
const BODY_PANELS: readonly AnalyzerPanelId[] = ["roll", "meter", "lyrics", "takes"];

const slotClass = (id: AnalyzerPanelId) =>
  id === "roll" ? "analyzer-page__roll" : id === "meter" ? "analyzer-page__meter" : id === "lyrics" ? "analyzer-page__lyrics" : id === "takes" ? "analyzer-page__takes" : undefined;

interface AnalyzerPageProps {
  songId: string;
  onBack: () => void;
}

function AnalyzerPage({ songId, onBack }: AnalyzerPageProps) {
  const songs   = useLibraryStore((s) => s.songs);
  const cleanup = usePlayerStore((s) => s.cleanup);
  const transpose = usePlayerStore((s) => s.transpose);
  const mutedStems = usePlayerStore((s) => s.mutedStems);
  const soloedStem = usePlayerStore((s) => s.soloedStem);
  const song    = songs.find((s) => s.id === songId);
  const visible = useAnalyzerPanels((s) => s.visible);
  const order = useAnalyzerPanels((s) => s.order);
  const detached = useDetachedStore((s) => s.detached);
  const waveformVisible = useWaveformPanels((s) => s.visible);

  useMainBridge();

  // On screen in this window: wanted, and not living in a window of its own.
  const docked = (id: AnalyzerPanelId) => visible[id] && !(isDetachablePanel(id) && detached[id]);
  const onScreen = order.filter((id) => BODY_PANELS.includes(id) && docked(id));

  // The stem area is collapsed, not removed: it owns what the audio engine draws into.
  const stems = song?.stems ?? [];
  const waveformsShown = waveformVisible.waveforms;

  useEffect(() => {
    return () => { cleanup(); };
  }, [songId]);

  useEffect(() => installPlayerShortcuts(() => usePlayerStore.getState()), []);

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
            {song.detectedKey && <span>{transposeKey(song.detectedKey, transpose)}</span>}
          </div>
        </div>
        <PanelMenu
          store={useAnalyzerPanels}
          panels={ANALYZER_PANELS}
          fixed={{
            store: useWaveformPanels,
            items: waveformMenuItems(stems),
            tags: hiddenStemTags(waveformVisible, { stems, muted: mutedStems, soloed: soloedStem }),
          }}
        />
        <DownloadAllButton song={song} />
        <ExportChartButton song={song} />
        <ExportMixButton />
      </header>

      <div className="analyzer-page__topbar">
        <TransportControls />
        <LoopButton />
        <LoopsMenu />
        <TempoControl detectedBpm={song.detectedBpm} />
        <KeyTranspose />
        <div className="analyzer-page__io-group">
          <MicSelector />
          <OutputSelector />
        </div>
        <RecordButton />
        <CapoSelect song={song} />
        <ChordDetailSelect song={song} />
        {docked("chords") && (
          <Detachable panel="chords" inline>
            <ChordCarousel song={song} />
          </Detachable>
        )}
      </div>

      <div className="analyzer-page__body">
        <div className="analyzer-page__stems">
          <div className={`analyzer-page__waveforms${waveformsShown ? "" : " analyzer-page__waveforms--collapsed"}`}>
            <StemView song={song} />
          </div>
          {waveformVisible.bassTab && <BassTabPanel song={song} />}
          {waveformVisible.songTab && <TabPanel song={song} />}
        </div>

        <SortablePanels store={useAnalyzerPanels} ids={onScreen} className={slotClass}>
          {(id) => id === "roll" ? (
            <div className="detachable">
              <div className="detach-handle"><MoveGrip /></div>
              <ChordRoll song={song} />
            </div>
          ) : id === "meter" ? (
            <div className="detachable">
              <div className="detach-handle"><MoveGrip /></div>
              <MeterPanel song={song} />
            </div>
          ) : (
            <Detachable panel={id}>
              {id === "lyrics" ? <LyricsPanel songId={songId} hasVocals={canSyncLyrics(song.stems)} /> : <TakeList />}
            </Detachable>
          )}
        </SortablePanels>
      </div>
    </div>
  );
}

export default AnalyzerPage;
