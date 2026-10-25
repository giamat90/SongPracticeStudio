import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../../stores/player";
import { fetchTabBytes, useTabStore } from "../../stores/tab";
import { onTabProgress, readTabTransposed, saveTabTransposed } from "../../lib/tauri";
import { defaultTrack, loadAlphaTab, type TabTrackInfo } from "../../lib/tabScore";
import { moveToString, restoreStep, stepString, type EditStep, type TabNoteModel } from "../../lib/tabEdit";
import { canEditTransposed, exportUntransposed, hasOffsets, retuneTab, storedTuning, transposeEdits, transposeTab } from "../../lib/tabTranspose";
import type { TabTransposition, TransposeEdit, TransposeOptions, TransposeResult } from "../../lib/tabTranspose";
import { alignmentNotes, moveBar, qualityText } from "../../lib/tabSync";
import type { Song } from "../../lib/types";
import TabNoteEditor from "./TabNoteEditor";
import TabScoreView, { type TabViewHandle } from "./TabScoreView";
import TabTransposeDialog from "./TabTransposeDialog";
import TabTuningEditor from "./TabTuningEditor";
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

/** What is saved for one transposition: the string choices and the lowest strings tuned down (by track index). */
interface SavedTransposition {
  edits: TransposeEdit[];
  /** By track index: semitones each string is tuned down from the tab, lowest string first. */
  retune: Record<string, number[]>;
}

/** What is saved for each transposition, by semitones. */
type SavedEdits = Record<string, SavedTransposition>;

/** Reads the saved file; the first version stored just the list of string choices. */
function parseSaved(raw: string): SavedEdits {
  type Stored = { edits?: TransposeEdit[]; retune?: Record<string, number | number[]> };
  const parsed = JSON.parse(raw) as Record<string, TransposeEdit[] | Stored>;
  const saved: SavedEdits = {};
  for (const [amount, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      saved[amount] = { edits: value, retune: {} };
      continue;
    }
    // The second version stored how far the lowest string went down, as one number.
    const retune = Object.fromEntries(
      Object.entries(value.retune ?? {}).map(([t, v]) => [t, typeof v === "number" ? [v] : v]),
    );
    saved[amount] = { edits: value.edits ?? [], retune };
  }
  return saved;
}

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
  const transpose = usePlayerStore((s) => s.transpose);
  const collapse = usePanelCollapse("tab");
  const { open: bodyOpen } = collapse;

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [tracks, setTracks] = useState<TabTrackInfo[]>([]);
  const [track, setTrack] = useState<number | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  const [following, setFollowing] = useState(true);
  const [viewError, setViewError] = useState<string | null>(null);
  const [source, setSource] = useState(0);
  const [editing, setEditing] = useState(false);
  const [transposed, setTransposed] = useState<TransposeResult | null>(null);
  const [pickedNote, setPickedNote] = useState<TabNoteModel | null>(null);
  const [undoStack, setUndoStack] = useState<EditStep[]>([]);
  const [redoStack, setRedoStack] = useState<EditStep[]>([]);
  const viewRef = useRef<TabViewHandle>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The score being edited, kept so a pending save can still be written after the view is gone. */
  const dirtyScore = useRef<ReturnType<TabViewHandle["getScore"]>>(null);
  /** Choices made on transposed tabs: what the view draws and what is written, kept in step with every edit. */
  const savedEdits = useRef<SavedEdits>({});
  /** Choices waiting to be written. */
  const dirtyEdits = useRef(false);
  const [editsVersion, setEditsVersion] = useState(0);
  const [transposing, setTransposing] = useState(false);
  const [tuningOpen, setTuningOpen] = useState(false);
  const [rewrote, setRewrote] = useState<string | null>(null);
  const songId = song.id;
  const songIdRef = useRef(songId);
  songIdRef.current = songId;

  /** Write the edits now, if there are any waiting. */
  const flushEdits = useCallback(async () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const score = dirtyScore.current;
    dirtyScore.current = null;
    const writeEdits = dirtyEdits.current;
    dirtyEdits.current = false;
    if (writeEdits) {
      try {
        await saveTabTransposed(songId, JSON.stringify(savedEdits.current));
      } catch (e) {
        console.error("[TabPanel] could not save the transposed edits:", e);
        setViewError(e instanceof Error ? e.message : String(e));
      }
    }
    if (!score) return;
    try {
      const exported = exportUntransposed(await loadAlphaTab(), score);
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
    dirtyEdits.current = false;
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
    setEditing(false);
    setTransposing(false);
    setTuningOpen(false);
    setRewrote(null);
    resetEditing();
    savedEdits.current = {};
    let cancelled = false;
    readTabTransposed(songId)
      .then((raw) => {
        if (cancelled) return;
        savedEdits.current = raw ? parseSaved(raw) : {};
        setEditsVersion((n) => n + 1);
      })
      .catch((e: unknown) => {
        console.error("[TabPanel] could not read the transposed edits:", e);
        if (!cancelled) setViewError(`Could not read the saved edits for transposed songs: ${e instanceof Error ? e.message : String(e)}`);
      });
    load(songId);
    return () => {
      cancelled = true;
      void flushEdits();
    };
  }, [songId, load, flushEdits]);

  // The undo steps and the picked note belong to one transposition: another amount draws other frets.
  useEffect(() => {
    resetEditing();
  }, [transpose]);

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

  /** Keep the choices made on the shown transposition, with its tunings, to be written. */
  const snapshotEdits = () => {
    const score = viewRef.current?.getScore() ?? null;
    // Taken now, not when the timer fires: by then the view may already be drawn for another transposition.
    const edits = score ? transposeEdits(score) : [];
    const retune = savedEdits.current[String(transpose)]?.retune ?? {};
    if (edits.length > 0 || Object.keys(retune).length > 0) savedEdits.current[String(transpose)] = { edits, retune };
    else delete savedEdits.current[String(transpose)];
    dirtyEdits.current = true;
  };

  const armSave = () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushEdits(); }, SAVE_DELAY_MS);
  };

  const scheduleSave = () => {
    if (transpose !== 0) {
      snapshotEdits();
    } else {
      dirtyScore.current = viewRef.current?.getScore() ?? dirtyScore.current;
    }
    armSave();
  };

  /** Play the shown track in another tuning (or in the tab's with null) for the shown transposition. */
  const setRetune = (trackIndex: number, offsets: number[] | null) => {
    snapshotEdits();
    const key = String(transpose);
    const saved = savedEdits.current[key] ?? { edits: [], retune: {} };
    const retune = { ...saved.retune };
    if (offsets && hasOffsets(offsets)) retune[String(trackIndex)] = offsets;
    else delete retune[String(trackIndex)];
    if (saved.edits.length > 0 || Object.keys(retune).length > 0) savedEdits.current[key] = { edits: saved.edits, retune };
    else delete savedEdits.current[key];
    resetEditing();
    setEditsVersion((n) => n + 1);
    armSave();
  };

  const transposeOptions = (): TransposeOptions => {
    const saved = savedEdits.current[String(transpose)];
    return {
      edits: saved?.edits ?? [],
      retune: Object.fromEntries(Object.entries(saved?.retune ?? {}).map(([t, offsets]) => [Number(t), offsets])),
    };
  };

  const getScore = useCallback(() => viewRef.current?.getScore() ?? null, []);

  /** Keep a rewrite of the tab as an undo step and save it. */
  const commitStep = (step: EditStep, message: string) => {
    setUndoStack((stack) => [...stack, step]);
    setRedoStack([]);
    setPickedNote(null);
    setEditing(true);
    setRewrote(`${message} Undo is in the editor; Revert goes back to the file as imported.`);
    viewRef.current?.rerender();
    scheduleSave();
  };

  const applyTabTransposition = async (t: TabTransposition) => {
    const score = viewRef.current?.getScore();
    if (!score) return;
    try {
      const { step, result } = transposeTab(await loadAlphaTab(), score, t);
      setTransposing(false);
      commitStep(
        step,
        `Tab transposed ${t.semitones > 0 ? "up" : "down"} ${Math.abs(t.semitones)} semitone${Math.abs(t.semitones) === 1 ? "" : "s"}: `
          + `${result.sameString + result.newString} notes re-fretted`
          + (result.unplayable > 0 ? `, ${result.unplayable} that no string can play left as written` : "")
          + (Object.keys(result.retuned).length > 0 ? `, tuning changed (${Object.values(result.retuned)[0].label.toLowerCase()})` : "")
          + ".",
      );
    } catch (e) {
      console.error("[TabPanel] could not transpose the tab:", e);
      setViewError(e instanceof Error ? e.message : String(e));
    }
  };

  /** The Tuning editor applied: kept for the shown transposition, or written into the tab when the song is not transposed. */
  const applyTuning = async (offsets: number[], keepPitch: boolean) => {
    if (track === null) return;
    setTuningOpen(false);
    if (transpose !== 0) {
      setRetune(track, offsets);
      return;
    }
    const score = viewRef.current?.getScore();
    if (!score) return;
    try {
      const { step, result } = retuneTab(await loadAlphaTab(), score, { track, offsets, keepPitch });
      if (step.tunings.length === 0) return;
      const shown = Object.values(result.retuned)[0];
      commitStep(step, `Tuning changed to ${shown.to} (${shown.label.toLowerCase()}), ${keepPitch ? "notes re-fretted to keep their pitch" : "frets kept, so the pitch moved"}.`);
    } catch (e) {
      console.error("[TabPanel] could not change the tuning:", e);
      setViewError(e instanceof Error ? e.message : String(e));
    }
  };

  const stepNote = (direction: "up" | "down") => {
    if (!pickedNote) return;
    const score = viewRef.current?.getScore();
    if (transpose !== 0 && score && !canEditTransposed(score, pickedNote)) {
      setViewError("This note has no string in this tuning at the transposed pitch, so it stays as written.");
      return;
    }
    const to = stepString(pickedNote, direction);
    if (!to) return;
    try {
      const undoStep = moveToString(pickedNote, to.string);
      setUndoStack((stack) => [...stack, { placements: undoStep, tunings: [] }]);
      setRedoStack([]);
      viewRef.current?.rerender();
      scheduleSave();
    } catch (e) {
      setViewError(e instanceof Error ? e.message : String(e));
    }
  };

  const goToBar = (direction: "previous" | "next") => {
    const first = viewRef.current?.stepBar(direction, pickedNote);
    if (first) setPickedNote(first);
  };

  const goToNote = (direction: "previous" | "next") => {
    const note = viewRef.current?.stepNote(direction, pickedNote);
    if (note) setPickedNote(note);
  };

  const toggleEditing = () => {
    setEditing(!editing);
    setPickedNote(null);
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, restoreStep(last)]);
    viewRef.current?.rerender();
    scheduleSave();
  };

  const redo = () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, restoreStep(last)]);
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

  // TuxGuitar's keys while editing: Shift+Up / Shift+Down move the picked note to the string above / below,
  // Left / Right go to the previous / next note, Alt+Left / Alt+Right to the previous / next bar, Ctrl+Z undoes (Ctrl+Y or Ctrl+Shift+Z redoes). Listened for
  // in the capture phase and stopped, so the app's own shortcuts and the meter's undo never see them.
  const keyActions = useRef({ stepNote, goToNote, goToBar, undo, redo });
  keyActions.current = { stepNote, goToNote, goToBar, undo, redo };
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const a = keyActions.current;
      const key = e.key.toLowerCase();
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        a.stepNote(e.key === "ArrowUp" ? "up" : "down");
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        a.goToNote(e.key === "ArrowLeft" ? "previous" : "next");
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        a.goToBar(e.key === "ArrowLeft" ? "previous" : "next");
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && key === "z") {
        if (e.shiftKey) a.redo();
        else a.undo();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === "y") {
        a.redo();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);

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
                {aligned && (
                  <button
                    className={`tab-panel__btn${editing ? " tab-panel__btn--on" : ""}`}
                    onClick={toggleEditing}
                    aria-pressed={editing}
                    title={transpose !== 0
                      ? "Edit the tab as shown for the transposed song: string choices are saved for this transposition only"
                      : "Edit the tab: move notes between strings (Shift+Up / Shift+Down)"}
                  >
                    Edit
                  </button>
                )}
                {aligned && (
                  <button
                    className={`tab-panel__btn${transposing ? " tab-panel__btn--on" : ""}`}
                    onClick={() => setTransposing(!transposing)}
                    aria-pressed={transposing}
                    disabled={transpose !== 0 || !bytes}
                    title={transpose !== 0
                      ? "Set the song's transpose back to 0 to transpose the tab itself"
                      : "Rewrite the tab by some semitones, as Guitar Pro and TuxGuitar do"}
                  >
                    Transpose…
                  </button>
                )}
                {aligned && (
                  <button
                    className={`tab-panel__btn${tuningOpen ? " tab-panel__btn--on" : ""}`}
                    onClick={() => setTuningOpen(!tuningOpen)}
                    aria-pressed={tuningOpen}
                    disabled={track === null || !bytes}
                    title={transpose !== 0
                      ? "Play the shown track in another tuning for this transposition"
                      : "Change the open strings of the shown track in the tab"}
                  >
                    Tuning…
                  </button>
                )}
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

          {aligned && bytes && transpose !== 0 && transposed && (
            <p className="tab-panel__transposed">
              {`Shown for the song ${transpose > 0 ? "up" : "down"} ${Math.abs(transpose)} semitone${Math.abs(transpose) === 1 ? "" : "s"}: `
                + `${transposed.sameString} notes on new frets, ${transposed.newString} on another string`
                + (transposed.edited > 0 ? `, ${transposed.edited} on a string you chose` : "")
                + (transposed.unplayable > 0
                  ? `, ${transposed.unplayable} that this tuning cannot play (red, left as written)`
                  : "")
                + (transposed.stale > 0 ? `, ${transposed.stale} saved choices that no longer fit the tab` : "")
                + "."}
            </p>
          )}

          {aligned && bytes && transpose !== 0 && transposed && track !== null && (
            <RetuneLine result={transposed} track={track} onRetune={(offsets) => setRetune(track, offsets)} />
          )}

          {rewrote && <p className="tab-panel__transposed">{rewrote}</p>}

          {tuningOpen && aligned && bytes && track !== null && (() => {
            const score = viewRef.current?.getScore();
            const base = score ? storedTuning(score, track) : null;
            if (!base) return <p className="tab-panel__transposed">This track has no strings to tune.</p>;
            const chosen = transpose !== 0 ? savedEdits.current[String(transpose)]?.retune[String(track)] : undefined;
            return (
              <TabTuningEditor
                key={`${track}-${transpose}`}
                base={base}
                initial={chosen ?? []}
                forTransposition={transpose !== 0}
                onApply={(offsets, keepPitch) => { void applyTuning(offsets, keepPitch); }}
                onCancel={() => setTuningOpen(false)}
              />
            );
          })()}

          {transposing && aligned && bytes && (
            <TabTransposeDialog
              tracks={tracks}
              track={track}
              getScore={getScore}
              onApply={(t) => { void applyTabTransposition(t); }}
              onCancel={() => setTransposing(false)}
            />
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
                editing={editing}
                selectedNote={pickedNote}
                handleRef={viewRef}
                onPickNote={setPickedNote}
                onTransposed={setTransposed}
                getTransposeOptions={transposeOptions}
                editsVersion={editsVersion}
                onTracks={handleTracks}
                onSeek={seek}
                onSelectBar={setSelectedOrder}
                onError={setViewError}
              />
              {editing && (
              <TabNoteEditor
                note={pickedNote}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                hasOriginal={record?.hasOriginal ?? false}
                disabled={busy}
                onStep={stepNote}
                onBar={goToBar}
                onNote={goToNote}
                onUndo={undo}
                onRedo={redo}
                onRevert={revert}
              />
              )}
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

/** The tuning the transposition plays the shown track in, or the tunings that would play more of its notes. */
function RetuneLine({ result, track, onRetune }: { result: TransposeResult; track: number; onRetune: (offsets: number[] | null) => void }) {
  const used = result.retuned[track];
  const suggestions = result.suggestions[track] ?? [];
  if (used) {
    return (
      <p className="tab-panel__retune">
        {`${used.label} for this transposition (${used.from} to ${used.to}).`}
        <button className="tab-panel__btn" onClick={() => onRetune(null)}>Tab's tuning</button>
      </p>
    );
  }
  return (
    <>
      {suggestions.map((s) => (
        <p key={s.label} className="tab-panel__retune">
          {`${s.label} (${s.from} to ${s.to}) plays ${s.fixes} more note${s.fixes === 1 ? "" : "s"}.`}
          <button className="tab-panel__btn" onClick={() => onRetune(s.offsets)}>Use this tuning</button>
        </p>
      ))}
    </>
  );
}
