import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import ChordCarousel from "../components/player/ChordCarousel";
import DockHandle from "../components/panels/DockHandle";
import LyricsPanel from "../components/lyrics/LyricsPanel";
import TakeList from "../components/recording/TakeList";
import { canSyncLyrics } from "../lib/lyrics";
import { dockPanel } from "../lib/tauri";
import type { Song } from "../lib/types";
import { usePlayerStore } from "../stores/player";
import { startDetachedBridge } from "./detachedBridge";
import type { DetachablePanel } from "./protocol";

const TITLES: Record<DetachablePanel, string> = {
  chords: "Chords",
  lyrics: "Lyrics",
  takes: "Takes",
};

interface DetachedHostProps {
  panel: DetachablePanel;
}

function PanelBody({ panel, song }: { panel: DetachablePanel; song: Song }) {
  switch (panel) {
    case "chords":
      return song.hasChords ? (
        <ChordCarousel song={song} />
      ) : (
        <p className="detached-host__waiting">No chords were detected for this song.</p>
      );
    case "lyrics":
      return <LyricsPanel songId={song.id} hasVocals={canSyncLyrics(song.stems)} />;
    case "takes":
      return <TakeList />;
  }
}

/**
 * What a detached window shows: one panel, driven by the main window. There is
 * no audio engine here and no microphone; everything arrives from the bridge.
 */
function DetachedHost({ panel }: DetachedHostProps) {
  const song = usePlayerStore((s) => s.song);

  useEffect(() => {
    let cancelled = false;
    let bridge: { dispose(): void } | null = null;

    startDetachedBridge({
      panelId: panel,
      player: usePlayerStore,
      emit: (event, payload) => emit(event, payload),
      listen: (event, cb) => listen(event, (e) => cb(e.payload)),
      now: () => Date.now(),
    })
      .then((b) => {
        if (cancelled) b.dispose();
        else bridge = b;
      })
      .catch((e: unknown) => console.error("[detached] could not connect to the main window:", e));

    return () => {
      cancelled = true;
      bridge?.dispose();
    };
  }, [panel]);

  return (
    <div className="detached-host">
      <header className="detached-host__bar">
        <span className="detached-host__title">
          {TITLES[panel]}
          {song ? ` — ${song.title}` : ""}
        </span>
        <DockHandle />
        <button
          type="button"
          className="detached-host__dock"
          onClick={() => dockPanel().catch((e: unknown) => console.error("[detached] could not dock:", e))}
        >
          Dock
        </button>
      </header>

      <div className="detached-host__body">
        {song ? <PanelBody panel={panel} song={song} /> : <p className="detached-host__waiting">Waiting for the main window…</p>}
      </div>
    </div>
  );
}

export default DetachedHost;
