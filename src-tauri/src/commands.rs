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
) -> Result<Song, String> {
    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);

    // Copy source file into the song directory
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

    // Send process command to sidecar
    let cmd = serde_json::json!({
        "cmd": "process",
        "filePath": dest_str,
        "outputDir": output_dir_str,
    });

    // Hold the lock for the duration of the processing to prevent concurrent jobs
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    // Read messages until we get a result or error
    let timeout = Duration::from_secs(600); // 10 min max for long songs
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

                // Extract metadata from result
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let duration = data
                    .get("pitchData")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|p| p.get("time"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);

                let now = chrono::Utc::now().to_rfc3339();

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: now,
                    directory: output_dir_str,
                };

                // Save analysis data to analysis.json
                let analysis = serde_json::json!({
                    "pitchData": data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":    data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":  data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

                // Persist to library.json
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
pub async fn pitch_shift_song(
    state: State<'_, SidecarState>,
    song_dir: String,
    n_steps: i32,
) -> Result<serde_json::Value, String> {
    let cache_dir = std::path::Path::new(&song_dir)
        .join("pitched")
        .join(n_steps.to_string());
    let vocals_cache = cache_dir.join("vocals.wav");
    let instr_cache = cache_dir.join("instrumental.wav");

    // Return cached result without touching the sidecar
    if vocals_cache.exists() && instr_cache.exists() {
        return Ok(serde_json::json!({
            "vocalsPath": vocals_cache.to_string_lossy(),
            "instrumentalPath": instr_cache.to_string_lossy(),
        }));
    }

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir: {e}"))?;

    let cmd = serde_json::json!({
        "cmd": "pitch_shift",
        "songDir": song_dir,
        "cacheDir": cache_dir.to_string_lossy(),
        "nSteps": n_steps,
    });
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(300);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Result { data, .. } => return Ok(data),
            SidecarMessage::Error { message, .. } => return Err(message),
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

// --- Take commands ---

/// Take metadata for frontend (includes optional analysis data).
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub song_id: String,
    pub recorded_at: String,
    pub filepath: String,
    /// Song position (seconds) where recording started; 0 for full-song takes.
    #[serde(default)]
    pub start_position: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onsets: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<serde_json::Value>,
}

fn takes_json_path(song_id: &str) -> std::path::PathBuf {
    storage::song_dir(song_id).join("takes.json")
}

fn load_takes(song_id: &str) -> Result<Vec<Take>, String> {
    let path = takes_json_path(song_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read takes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse takes: {e}"))
}

fn save_takes(song_id: &str, takes: &[Take]) -> Result<(), String> {
    let path = takes_json_path(song_id);
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write takes: {e}"))
}

#[tauri::command]
pub async fn save_take(
    state: State<'_, SidecarState>,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
) -> Result<Take, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::song_dir(&song_id).join("takes");
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create takes dir: {e}"))?;

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();

    // Analyze the recording via sidecar
    let (pitch_data, onsets, dynamics, vibrato) = {
        let guard = ensure_sidecar(&state);
        if let Ok(guard) = guard {
            if let Some(sidecar) = guard.as_ref() {
                let cmd = serde_json::json!({
                    "cmd": "analyze",
                    "recordingPath": file_path_str,
                    "outputDir": output_dir_str,
                });
                let _ = sidecar.send_command(&cmd);
                let timeout = std::time::Duration::from_secs(300);
                let mut result = (None, None, None, None);
                loop {
                    match sidecar.recv_timeout(timeout) {
                        Ok(SidecarMessage::Result { data, .. }) => {
                            result = (
                                data.get("pitchData").cloned(),
                                data.get("onsets").cloned(),
                                data.get("dynamics").cloned(),
                                data.get("vibrato").cloned(),
                            );
                            break;
                        }
                        Ok(SidecarMessage::Error { message, .. }) => {
                            log::warn!("Take analysis error: {message}");
                            break;
                        }
                        Ok(SidecarMessage::Progress { .. }) => continue,
                        _ => break,
                    }
                }
                result
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        }
    };

    let take = Take {
        id: take_id,
        song_id: song_id.clone(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: file_path_str,
        start_position,
        pitch_data,
        onsets,
        dynamics,
        vibrato,
    };

    let mut takes = load_takes(&song_id)?;
    takes.push(take.clone());
    save_takes(&song_id, &takes)?;

    Ok(take)
}

#[tauri::command]
pub async fn load_analysis(song_id: String) -> Result<serde_json::Value, String> {
    let path = storage::song_dir(&song_id).join("analysis.json");
    if !path.exists() {
        return Ok(serde_json::json!({"pitchData": [], "onsets": [], "dynamics": []}));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read analysis: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse analysis: {e}"))
}

#[tauri::command]
pub async fn list_takes(song_id: String) -> Result<Vec<Take>, String> {
    load_takes(&song_id)
}

#[tauri::command]
pub async fn delete_take(song_id: String, take_id: String) -> Result<(), String> {
    let takes = load_takes(&song_id)?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Delete take file: {e}"))?;
        }
    }
    let filtered: Vec<Take> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save_takes(&song_id, &filtered)
}

#[tauri::command]
pub async fn import_youtube(
    app: AppHandle,
    state: State<'_, SidecarState>,
    url: String,
) -> Result<Song, String> {
    if !url.contains("youtube.com/") && !url.contains("youtu.be/") {
        return Err("Not a valid YouTube URL".to_string());
    }

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);
    let output_dir_str = output_dir.to_string_lossy().to_string();

    let cmd = serde_json::json!({
        "cmd": "import_yt",
        "url": url,
        "outputDir": output_dir_str,
    });

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
                    .get("pitchData")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|p| p.get("time"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: chrono::Utc::now().to_rfc3339(),
                    directory: output_dir_str,
                };

                let analysis = serde_json::json!({
                    "pitchData": data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":    data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":  data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

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
