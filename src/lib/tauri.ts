import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChordSegment, Folder, NamedLoop, ProcessingStatus, Song, StemName, TabBar, TabRecord, TabSync, Take,
} from "./types";
import type { BassTabData } from "./bassTab";

/** Process a song file through the Python sidecar */
export async function processSong(filePath: string, stemsToExtract?: StemName[], highQuality?: boolean): Promise<Song> {
  return invoke<Song>("process_song", { filePath, stemsToExtract, highQuality });
}

/** List all songs in the library */
export async function listSongs(): Promise<Song[]> {
  return invoke<Song[]>("list_songs");
}

/** Delete a song from the library */
export async function deleteSong(songId: string): Promise<void> {
  return invoke("delete_song", { songId });
}

/** Import a YouTube URL through yt-dlp + Demucs pipeline */
export async function importYoutube(
  url: string,
  stemsToExtract?: StemName[],
  highQuality?: boolean,
  cookiesPath?: string | null,
): Promise<Song> {
  return invoke<Song>("import_youtube", { url, stemsToExtract, highQuality, cookiesPath });
}

/** Read detected chord segments for a processed song */
export async function readSongChords(songId: string): Promise<ChordSegment[]> {
  return invoke<ChordSegment[]>("read_song_chords", { songId });
}

/** How far the recording sits from A440 in cents (positive = sharp); 0 when it was not measured. */
export async function readChordTuning(songId: string): Promise<number> {
  return invoke<number>("read_chord_tuning", { songId });
}

/** Store the user's corrected chord list for a song; resolves to what was stored (rounded, sorted) */
export async function saveChordEdits(songId: string, segments: ChordSegment[]): Promise<ChordSegment[]> {
  return invoke<ChordSegment[]>("save_chord_edits", { songId, segments });
}

/** Drop the user's chord corrections so the detected chords show again */
export async function clearChordEdits(songId: string): Promise<void> {
  return invoke("clear_chord_edits", { songId });
}

/** Whether a song's chords carry the user's corrections */
export async function hasChordEdits(songId: string): Promise<boolean> {
  return invoke<boolean>("has_chord_edits", { songId });
}

/** List all folders in the library */
export async function listFolders(): Promise<Folder[]> {
  return invoke<Folder[]>("list_folders");
}

/** Create a new (flat) folder. Empty/whitespace name is rejected. */
export async function createFolder(name: string): Promise<Folder> {
  return invoke<Folder>("create_folder", { name });
}

/** Rename a folder. Empty/whitespace name is rejected. */
export async function renameFolder(folderId: string, name: string): Promise<Folder> {
  return invoke<Folder>("rename_folder", { folderId, name });
}

/** Delete a folder; its songs move back to the root list, they are not deleted. */
export async function deleteFolder(folderId: string): Promise<void> {
  return invoke("delete_folder", { folderId });
}

/** Reorder folders (drag-to-reorder the folder sections themselves) */
export async function reorderFolders(orderedIds: string[]): Promise<Folder[]> {
  return invoke<Folder[]>("reorder_folders", { orderedIds });
}

/** Move/reorder songs into `folderId` (null = root) in the given order. Covers both a same-folder reorder and a cross-folder drag-drop-at-position. */
export async function moveSongs(folderId: string | null, orderedSongIds: string[]): Promise<Song[]> {
  return invoke<Song[]>("move_songs", { folderId, orderedSongIds });
}

/** Open a native Save As dialog and copy a stem WAV to user-chosen location */
export async function exportStem(
  stemPath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_stem", { stemPath, suggestedName });
}

export interface ZipExportEntry {
  path: string;
  archiveName: string;
}

/** Open a native Save As dialog and bundle stems + takes into a zip archive */
export async function exportAll(entries: ZipExportEntry[], suggestedName: string): Promise<void> {
  return invoke("export_all", { entries, suggestedName });
}

/** Save a recorded take */
export async function saveTake(
  songId: string,
  audioData: number[],
  startPosition: number,
  audioOffset = 0,
): Promise<Take> {
  return invoke<Take>("save_take", { songId, audioData, startPosition, audioOffset });
}

/** List takes recorded for a song */
export async function listTakes(songId: string): Promise<Take[]> {
  return invoke<Take[]>("list_takes", { songId });
}

/** Delete a take */
export async function deleteTakeApi(songId: string, takeId: string): Promise<void> {
  return invoke("delete_take", { songId, takeId });
}

/** Rename a take (empty/whitespace name clears it back to the default "Take N" label) */
export async function renameTakeApi(songId: string, takeId: string, name: string): Promise<Take> {
  return invoke<Take>("rename_take", { songId, takeId, name });
}

/** Abandon the lyrics sync that is running; its sync call then fails with "Cancelled." */
export async function cancelLyricsSync(): Promise<void> {
  return invoke("cancel_lyrics_sync");
}

/** Detect the song's chords again from its stems (sevenths, slash chords); resolves to the updated song */
export async function redetectSongChords(songId: string): Promise<Song> {
  return invoke<Song>("redetect_song_chords", { songId });
}

/** A song's transcribed bass line; null for songs imported before bass transcription or without a bass stem */
export async function readBassTab(songId: string): Promise<BassTabData | null> {
  return invoke<BassTabData | null>("read_bass_tab", { songId });
}

/** A song's stored tab and its alignment; null for a song with no tab */
export async function readSongTab(songId: string): Promise<TabRecord | null> {
  return invoke<TabRecord | null>("read_song_tab", { songId });
}

/** Copy a Guitar Pro file next to the song, replacing any earlier tab and its alignment */
export async function importSongTab(songId: string, sourcePath: string): Promise<TabRecord> {
  return invoke<TabRecord>("import_song_tab", { songId, sourcePath });
}

/** Place the stored tab's bar lines on the recording; `scoreJson` is the TabScore built from the tab */
export async function alignSongTab(songId: string, scoreJson: string): Promise<TabSync> {
  return invoke<TabSync>("align_song_tab", { songId, scoreJson });
}

/** Store bar lines the user moved */
export async function saveTabBars(songId: string, bars: TabBar[]): Promise<TabSync> {
  return invoke<TabSync>("save_tab_bars", { songId, bars });
}

/** Remove the song's tab and its alignment */
export async function deleteSongTab(songId: string): Promise<void> {
  return invoke("delete_song_tab", { songId });
}

export interface TabProgress {
  songId: string;
  progress: number;
  stage: string;
}

export function onTabProgress(callback: (progress: TabProgress) => void): Promise<UnlistenFn> {
  return listen<TabProgress>("tab-progress", (event) => callback(event.payload));
}

/** Offer a file the app built (a .txt or .mid) through a Save As dialog */
export async function exportFile(data: number[], suggestedName: string): Promise<void> {
  return invoke("export_file", { data, suggestedName });
}

/** Replace the song's saved named loops; the backend trims names and keeps them in time order */
export async function setSongLoopsApi(songId: string, loops: NamedLoop[]): Promise<Song> {
  return invoke<Song>("set_song_loops", { songId, loops });
}

/** Rename a song's library title. Empty/whitespace is rejected. */
export async function renameSongApi(songId: string, title: string): Promise<Song> {
  return invoke<Song>("rename_song", { songId, title });
}

/** Persist the metronome's downbeat anchor (song time, seconds) for this song; null clears it back to song start */
export async function setMetronomeOffsetApi(songId: string, offset: number | null): Promise<Song> {
  return invoke<Song>("set_metronome_offset", { songId, offset });
}

/** Persist a manual drag nudge (seconds, signed) on top of a take's auto-detected startPosition; 0 clears it back to that position */
export async function setTakeManualOffsetApi(songId: string, takeId: string, offset: number): Promise<Take> {
  return invoke<Take>("set_take_manual_offset", { songId, takeId, offset });
}

/** Open a native Save As dialog and export a take as WAV */
export async function exportTake(takePath: string, suggestedName: string): Promise<void> {
  return invoke("export_take", { takePath, suggestedName });
}

export interface MixSource {
  path: string;
  gain: number;
  isTake: boolean;
  startPosition?: number;
  audioOffset?: number;
  manualOffset?: number;
}

/**
 * Render a mixdown WAV from `sources` (each already resolved to a final
 * linear gain by the caller) trimmed to [startSec, endSec) of the project
 * timeline, then open a native Save As dialog for the result.
 */
export async function exportMix(
  sources: MixSource[],
  startSec: number,
  endSec: number,
  suggestedName: string,
): Promise<void> {
  return invoke("export_mix", { sources, startSec, endSec, suggestedName });
}

/** Phase-vocoder pitch-shift every stem by nSteps semitones, cached per song/semitone-count */
export async function pitchShiftSong(
  songDir: string,
  stemNames: string[],
  nSteps: number,
): Promise<{ stems: Record<string, string> }> {
  return invoke("pitch_shift_song", { songDir, stemNames, nSteps });
}

/**
 * Open a panel in a window of its own. With a screen position (where the user
 * let go) it opens there; without one it goes where it was last, if that is
 * still on a monitor. Focuses the window when it already exists.
 */
export async function detachPanel(panelId: string, x?: number, y?: number): Promise<void> {
  return invoke("detach_panel", { panelId, x: x ?? null, y: y ?? null });
}

/** Close one panel's window from the main window (the panel was hidden in the Panels menu). */
export async function closeDetachedPanel(panelId: string): Promise<void> {
  return invoke("close_detached_panel", { panelId });
}

/** Called from a detached window: close it, which puts its panel back in the main window. */
export async function dockPanel(): Promise<void> {
  return invoke("dock_panel");
}

/** Is the mouse pointer over the main window? Asked of the OS, in physical pixels. */
export async function cursorOverMain(): Promise<boolean> {
  return invoke("cursor_over_main");
}

/** Close every detached window (leaving the analyzer page ends them). */
export async function closeDetachedWindows(): Promise<void> {
  return invoke("close_detached_windows");
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
