import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../../stores/player";
import { fetchTabBytes, useTabStore } from "../../stores/tab";
import { onTabProgress } from "../../lib/tauri";
import { defaultTrack, loadAlphaTab, type TabTrackInfo } from "../../lib/tabScore";
import { exportTab, moveToString, neighbourNote, restore, stepString, type Placement, type TabNoteModel } from "../../lib/tabEdit";
import { alignmentNotes, moveBar, qualityText } from "../../lib/tabSync";
import type { Song } from "../../lib/types";
import TabNoteEditor from "./TabNoteEditor";
import TabScoreView, { type TabViewHandle } from "./TabScoreView";
import PanelTitle from "../panels/PanelTitle";
import { usePanelCollapse } from "../../stores/collapsed";

const TAB_EXTENSIONS = ["gp", "gp3", "gp4", "gp5", "gpx", "musicxml", "xml"];

/** How long after the last edit the file is written: exporting a long tab takes a moment. */
const SAVE_DELAY_MS = 600;

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
  const saveEdited = useTabStore((s) => s.saveEdited);
  const revertEdits = useTabStore((s) => s.revertEdits);
  const reloadKey = useTabStore((s) => s.reloadKey);
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
  const [source, setSource] = useState(0);
  const [pickedNote, setPickedNote] = useState<TabNoteModel | null>(null);
  const [undoStack, setUndoStack] = useState<Placement[][]>([]);
  const [redoStack, setRedoStack] = useState<Placement[][]>([]);
  const viewRef = useRef<TabViewHandle>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The score being edited, kept so a pending save can still be written after the view is gone. */
  const dirtyScore = useRef<ReturnType<TabViewHandle["getScore"]>>(null);
  const songId = song.id;
  const songIdRef = useRef(songId);
  songIdRef.current = songId;

  /** Write the edits now, if there are any waiting. */
  const flushEdits = useCallback(async () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const score = dirtyScore.current;
    dirtyScore.current = null;
    if (!score) return;
    try {
      const exported = exportTab(await loadAlphaTab(), score);
      await saveEdited(songId, exported);
      // Kept current so the view reads the edited tab when the panel is folded and opened again.
      if (songIdRef.current === songId) setBytes(exported);
    } catch (e) {
      console.error("[TabPanel] could not save the edited tab:", e);
      setViewError(e instanceof Error ? e.message : String(e));
    }
  }, [saveEdited, songId]);

  const dropPendingEdits = () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    dirtyScore.current = null;
  };

  const resetEditing = () => {
    setPickedNote(null);
    setUndoStack([]);
    setRedoStack([]);
  };

  useEffect(() => {
    setBytes(null);
    setTracks([]);
    setTrack(null);
    setSelectedOrder(null);
    setViewError(null);
    resetEditing();
    load(songId);
    return () => { void flushEdits(); };
  }, [songId, load, flushEdits]);

  // Folding the panel drops the score, and with it the notes the undo steps point at.
  useEffect(() => {
    if (bodyOpen) return;
    resetEditing();
    void flushEdits();
  }, [bodyOpen, flushEdits]);

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
  const hasTab = path !== null;
  const aligned = record?.sync ?? null;
  const alignedAt = aligned?.alignedAt ?? null;
  // The stored path changes when a first edit turns a .gp5 into a .gp; the view already holds that score,
  // so only a new alignment or a revert reads the file again.
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    setBytes(null);
    resetEditing();
    const stored = pathRef.current;
    if (!stored || !alignedAt) return;
    let cancelled = false;
    fetchTabBytes(stored)
      .then((data) => {
        if (cancelled) return;
        setBytes(data);
        setSource((n) => n + 1);
      })
      .catch((e: unknown) => {
        console.error("[TabPanel] could not read the tab:", e);
        if (!cancelled) setViewError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [hasTab, alignedAt, reloadKey]);

  const bars = aligned?.bars ?? [];
  const notes = useMemo(() => (aligned ? alignmentNotes(aligned) : []), [aligned]);
  const busy = status === "importing" || status === "aligning";

  const chooseFile = async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Guitar Pro tab", extensions: TAB_EXTENSIONS }] });
    if (typeof picked === "string") {
      dropPendingEdits();
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

  const scheduleSave = () => {
    dirtyScore.current = viewRef.current?.getScore() ?? dirtyScore.current;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushEdits(); }, SAVE_DELAY_MS);
  };

  const stepNote = (direction: "up" | "down") => {
    if (!pickedNote) return;
    const to = stepString(pickedNote, direction);
    if (!to) return;
    try {
      const undoStep = moveToString(pickedNote, to.string);
      setUndoStack((stack) => [...stack, undoStep]);
      setRedoStack([]);
      viewRef.current?.rerender();
      scheduleSave();
    } catch (e) {
      setViewError(e instanceof Error ? e.message : String(e));
    }
  };

  const goToNeighbour = (direction: "previous" | "next") => {
    if (!pickedNote) return;
    setPickedNote(neighbourNote(pickedNote, direction) ?? pickedNote);
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, restore(last)]);
    viewRef.current?.rerender();
    scheduleSave();
  };

  const redo = () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, restore(last)]);
    viewRef.current?.rerender();
    scheduleSave();
  };

  const revert = async () => {
    dropPendingEdits();
    await revertEdits(song.id);
  };

  const realign = async () => {
    await flushEdits();
    await align(song.id);
  };

  // Guitar Pro's keys: Alt+Up / Alt+Down move the picked note to the string above / below, Alt+Left / Alt+Right
  // pick the previous / next note. Alt combinations are left alone by the app's own shortcuts.
  const keyActions = useRef({ stepNote, goToNeighbour });
  keyActions.current = { stepNote, goToNeighbour };
  useEffect(() => {
    if (!pickedNote) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const { stepNote: step, goToNeighbour: go } = keyActions.current;
      if (e.key === "ArrowUp") step("up");
      else if (e.key === "ArrowDown") step("down");
      else if (e.key === "ArrowLeft") go("previous");
      else if (e.key === "ArrowRight") go("next");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickedNote]);

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
                  onClick={realign}
                  disabled={busy}
                  title="Fit the bar lines again, dropping hand corrections"
                >
                  Re-align
                </button>
                <button
                  className="tab-panel__btn"
                  onClick={() => { dropPendingEdits(); void remove(song.id); }}
                  disabled={busy}
                >
                  Remove
                </button>
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
                source={source}
                bars={bars}
                duration={song.duration}
                track={track}
                selectedOrder={selectedOrder}
                selectedNote={pickedNote}
                handleRef={viewRef}
                onPickNote={setPickedNote}
                onTracks={handleTracks}
                onSeek={seek}
                onSelectBar={setSelectedOrder}
                onError={setViewError}
              />
              <TabNoteEditor
                note={pickedNote}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                hasOriginal={record?.hasOriginal ?? false}
                disabled={busy}
                onStep={stepNote}
                onNeighbour={goToNeighbour}
                onUndo={undo}
                onRedo={redo}
                onRevert={revert}
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
