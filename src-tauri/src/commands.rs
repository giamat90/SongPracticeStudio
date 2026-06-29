use crate::library::{self, Song};
use crate::sidecar::{SidecarManager, SidecarMessage};
use crate::storage;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Shared sidecar state — lazy-initialized on first use.
pub struct SidecarState(pub std::sync::Mutex<Option<SidecarManager>>);

/// Processing progress event payload (emitted to frontend).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub song_id: String,
    pub progress: f32,
    pub stage: String,
    pub is_complete: bool,
    pub error: Option<String>,
}

/// Ensure sidecar is running, spawning if needed. Returns a lock guard.
fn ensure_sidecar(
    state: &SidecarState,
) -> Result<std::sync::MutexGuard<'_, Option<SidecarManager>>, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        log::info!("Spawning sidecar for first use");
        *guard = Some(SidecarManager::spawn()?);
    }
    Ok(guard)
}

#[tauri::command]
pub async fn process_song(
    app: AppHandle,
    state: State<'_, SidecarState>,
    file_path: String,
    stems_to_extract: Option<Vec<String>>,
) -> Result<Song, String> {
    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);

    let src = std::path::Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let file_name = src
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();
    let title = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());
    let dest = output_dir.join(file_name.as_ref());
    std::fs::copy(src, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    let output_dir_str = output_dir.to_string_lossy().to_string();
    let dest_str = dest.to_string_lossy().to_string();

    let mut cmd = serde_json::json!({
        "cmd": "process",
        "filePath": dest_str,
        "outputDir": output_dir_str,
    });
    if let Some(ref stems) = stems_to_extract {
        cmd["stemsToExtract"] = serde_json::json!(stems);
    }

    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(600);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let duration = data
                    .get("duration")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let stems: Vec<String> = data
                    .get("stems")
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();

                let now = chrono::Utc::now().to_rfc3339();
                let song = Song {
                    id: song_id,
                    title,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: now,
                    directory: output_dir_str,
                    stems,
                };

                library::add(song.clone())?;
                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("Sidecar error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn list_songs() -> Result<Vec<Song>, String> {
    library::load()
}

#[tauri::command]
pub async fn delete_song(song_id: String) -> Result<(), String> {
    library::remove(&song_id)
}

#[tauri::command]
pub async fn import_youtube(
    app: AppHandle,
    state: State<'_, SidecarState>,
    url: String,
    stems_to_extract: Option<Vec<String>>,
) -> Result<Song, String> {
    if !url.contains("youtube.com/") && !url.contains("youtu.be/") {
        return Err("Not a valid YouTube URL".to_string());
    }

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);
    let output_dir_str = output_dir.to_string_lossy().to_string();

    let mut cmd = serde_json::json!({
        "cmd": "import_yt",
        "url": url,
        "outputDir": output_dir_str,
    });
    if let Some(ref stems) = stems_to_extract {
        cmd["stemsToExtract"] = serde_json::json!(stems);
    }

    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(900);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                let title = data
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let duration = data
                    .get("duration")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let stems: Vec<String> = data
                    .get("stems")
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();

                let song = Song {
                    id: song_id,
                    title,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: chrono::Utc::now().to_rfc3339(),
                    directory: output_dir_str,
                    stems,
                };

                library::add(song.clone())?;
                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("YT import error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn export_stem(
    app: AppHandle,
    stem_path: String,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let src = std::path::Path::new(&stem_path);
    if !src.exists() {
        return Err(format!("Stem not found: {stem_path}"));
    }

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(src, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}
