import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BassTabData, ProcessingStatus, Song, StemName } from "./types";

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
export async function importYoutube(url: string, stemsToExtract?: StemName[], highQuality?: boolean): Promise<Song> {
  return invoke<Song>("import_youtube", { url, stemsToExtract, highQuality });
}

/** Open a native Save As dialog and copy a stem WAV to user-chosen location */
export async function exportStem(
  stemPath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_stem", { stemPath, suggestedName });
}

/** Read the bass tab JSON for a song (transcribed during processing) */
export async function readBassTab(songId: string): Promise<BassTabData> {
  return invoke<BassTabData>("read_bass_tab", { songId });
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
