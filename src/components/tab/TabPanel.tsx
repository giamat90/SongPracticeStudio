import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../../stores/player";
import { fetchTabBytes, useTabStore } from "../../stores/tab";
import { onTabProgress } from "../../lib/tauri";
import { defaultTrack, type TabTrackInfo } from "../../lib/tabScore";
import { alignmentNotes, moveBar, qualityText } from "../../lib/tabSync";
import type { Song } from "../../lib/types";
import TabScoreView from "./TabScoreView";
import PanelTitle from "../panels/PanelTitle";
import { usePanelCollapse } from "../../stores/collapsed";

const TAB_EXTENSIONS = ["gp", "gp3", "gp4", "gp5", "gpx", "musicxml", "xml"];

const STAGE_TEXT: Record<string, string> = {
  "tab-features": "Reading the tab",
  "audio-features": "Listening to the stems",
  offset: "Finding where the tab starts",
  alignment: "Fitting the bar lines",
  done: "Done",
};

interface TabPanelProps {
  song: Song;
}

/** A Guitar Pro tab that follows the recording: import a file and it is placed on the song's timeline. */
export default function TabPanel({ song }: TabPanelProps) {
  const record = useTabStore((s) => s.record);
  const status = useTabStore((s) => s.status);
  const progress = useTabStore((s) => s.progress);
  const stage = useTabStore((s) => s.stage);
  const error = useTabStore((s) => s.error);
  const load = useTabStore((s) => s.load);
  const importTab = useTabStore((s) => s.importTab);
  const align = useTabStore((s) => s.align);
  const saveBars = useTabStore((s) => s.saveBars);
  const remove = useTabStore((s) => s.remove);
  const setProgress = useTabStore((s) => s.setProgress);
  const clearError = useTabStore((s) => s.clearError);
  const seek = usePlayerStore((s) => s.seek);
  const collapse = usePanelCollapse("tab");
  const { open: bodyOpen } = collapse;

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [tracks, setTracks] = useState<TabTrackInfo[]>([]);
  const [track, setTrack] = useState<number | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  const [following, setFollowing] = useState(true);
  const [viewError, setViewError] = useState<string | null>(null);

  useEffect(() => {
    setBytes(null);
    setTracks([]);
    setTrack(null);
    setSelectedOrder(null);
    setViewError(null);
    load(song.id);
  }, [song.id, load]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    onTabProgress((p) => setProgress(p.songId, p.progress, p.stage))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      })
      .catch((e: unknown) => console.error("[TabPanel] could not listen for progress:", e));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [setProgress]);

  const path = record?.path ?? null;
  const aligned = record?.sync ?? null;
  const alignedAt = aligned?.alignedAt ?? null;
  useEffect(() => {
    setBytes(null);
    if (!path || !alignedAt) return;
    let cancelled = false;
    fetchTabBytes(path)
      .then((data) => { if (!cancelled) setBytes(data); })
      .catch((e: unknown) => {
        console.error("[TabPanel] could not read the tab:", e);
        if (!cancelled) setViewError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [path, alignedAt]);

  const bars = aligned?.bars ?? [];
  const notes = useMemo(() => (aligned ? alignmentNotes(aligned) : []), [aligned]);
  const busy = status === "importing" || status === "aligning";

  const chooseFile = async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Guitar Pro tab", extensions: TAB_EXTENSIONS }] });
    if (typeof picked === "string") {
      setSelectedOrder(null);
      setViewError(null);
      await importTab(song.id, picked);
    }
  };

  const setBarHere = () => {
    if (selectedOrder === null) return;
    const time = usePlayerStore.getState().currentTime;
    void saveBars(song.id, moveBar(bars, selectedOrder, time, following));
  };

  const handleTracks = (found: TabTrackInfo[]) => {
    setTracks(found);
    setTrack((current) => (current !== null && found.some((t) => t.index === current) ? current : defaultTrack(found)));
  };

  const shownError = error ?? viewError;
  const selectedBar = selectedOrder === null ? null : bars[selectedOrder];

  return (
    <section className="tab-panel" aria-label="Tab">
      <h2 className="tab-panel__title">
        <PanelTitle collapse={collapse}>Tab</PanelTitle>
      </h2>

      {bodyOpen && (
        <div className="tab-panel__body">
          <header className="tab-panel__bar">
            {aligned && (
              <span className={`tab-panel__quality tab-panel__quality--${aligned.quality}`}>
                {qualityText(aligned.quality)}
                {aligned.edited ? " (edited)" : ""}
              </span>
            )}
            {record && <span className="tab-panel__file" title={record.originalName}>{record.originalName}</span>}
            <span className="tab-panel__spacer" />
            {tracks.length > 1 && (
              <select
                className="tab-panel__select"
                aria-label="Track"
                value={track ?? ""}
                onChange={(e) => setTrack(Number(e.target.value))}
              >
                {tracks.map((t) => (
                  <option key={t.index} value={t.index}>{t.name || `Track ${t.index + 1}`}</option>
                ))}
              </select>
            )}
            <button className="tab-panel__btn" onClick={chooseFile} disabled={busy}>
              {record ? "Replace tab…" : "Import tab…"}
            </button>
            {record && (
              <>
                <button
                  className="tab-panel__btn"
                  onClick={() => align(song.id)}
                  disabled={busy}
                  title="Fit the bar lines again, dropping hand corrections"
                >
                  Re-align
                </button>
                <button className="tab-panel__btn" onClick={() => remove(song.id)} disabled={busy}>Remove</button>
              </>
            )}
          </header>

          {shownError && (
            <div className="tab-panel__error" role="alert">
              <span>{shownError}</span>
              <button className="tab-panel__btn" onClick={() => { clearError(); setViewError(null); }}>Dismiss</button>
            </div>
          )}

          {busy && (
            <div className="tab-panel__progress">
              <div className="tab-panel__stage">
                {status === "importing" ? "Copying the tab" : STAGE_TEXT[stage] ?? "Aligning the tab to the recording"}
              </div>
              <div className="progress-bar">
                <div className="progress-bar__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </div>
          )}

          {!record && !busy && status !== "loading" && (
            <p className="tab-panel__hint">
              Import a Guitar Pro tab ({TAB_EXTENSIONS.map((e) => `.${e}`).join(", ")}) of this song. SPS places its bars on
              the recording so the tab follows the music, using the separated stems. Nothing is uploaded.
            </p>
          )}

          {record && !aligned && !busy && !shownError && (
            <p className="tab-panel__hint">This tab has not been aligned to the recording yet.</p>
          )}

          {notes.length > 0 && (
            <ul className="tab-panel__notes">
              {notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}

          {aligned && bytes && (
            <>
              <TabScoreView
                bytes={bytes}
                bars={bars}
                duration={song.duration}
                track={track}
                selectedOrder={selectedOrder}
                onTracks={handleTracks}
                onSeek={seek}
                onSelectBar={setSelectedOrder}
                onError={setViewError}
              />
              <div className="tab-panel__fix">
                <span className="tab-panel__fixhint">
                  {selectedBar ? `Bar ${selectedBar.index + 1} selected.` : "Click a bar to correct its position."}
                </span>
                <button className="tab-panel__btn" onClick={setBarHere} disabled={selectedOrder === null}>
                  Set bar to playhead
                </button>
                <label className="tab-panel__check">
                  <input type="checkbox" checked={following} onChange={(e) => setFollowing(e.target.checked)} />
                  move the following bars too
                </label>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
