import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProcessingStatus, Song, Take } from "./types";

/** Process a song file through the Python sidecar */
export async function processSong(filePath: string): Promise<Song> {
  return invoke<Song>("process_song", { filePath });
}

/** List all songs in the library */
export async function listSongs(): Promise<Song[]> {
  return invoke<Song[]>("list_songs");
}

/** Delete a song from the library */
export async function deleteSong(songId: string): Promise<void> {
  return invoke("delete_song", { songId });
}

/** Save a recorded take */
export async function saveTake(songId: string, audioData: number[], startPosition: number): Promise<Take> {
  return invoke<Take>("save_take", { songId, audioData, startPosition });
}

/** List takes for a song */
export async function listTakes(songId: string): Promise<Take[]> {
  return invoke<Take[]>("list_takes", { songId });
}

/** Delete a take */
export async function deleteTakeApi(songId: string, takeId: string): Promise<void> {
  return invoke("delete_take", { songId, takeId });
}

/** Load song analysis data (pitchData, onsets, dynamics) */
export async function loadAnalysis(songId: string): Promise<{
  pitchData: import("./types").PitchData;
  onsets: number[];
  dynamics: import("./types").DynamicsPoint[];
}> {
  return invoke("load_analysis", { songId });
}

/** Pitch-shift both tracks for a song; returns paths to the shifted WAV files */
export async function pitchShiftSong(
  songDir: string,
  nSteps: number,
): Promise<{ vocalsPath: string; instrumentalPath: string }> {
  return invoke("pitch_shift_song", { songDir, nSteps });
}

/** Import a YouTube URL through yt-dlp + Demucs pipeline */
export async function importYoutube(url: string): Promise<Song> {
  return invoke<Song>("import_youtube", { url });
}

/** Open a native Save As dialog and copy a stem WAV to user-chosen location */
export async function exportStem(
  stemPath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_stem", { stemPath, suggestedName });
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
