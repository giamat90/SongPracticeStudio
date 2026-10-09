use crate::library::{self, ChordSegment, Song};
use crate::sidecar::{SidecarManager, SidecarMessage};
use crate::storage;
use crate::takes::{self, Take};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Shared sidecar state — lazy-initialized on first use.
pub struct SidecarState(pub std::sync::Mutex<Option<SidecarManager>>);

/// Processing progress event payload (emitted to frontend).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub song_id: String,
    pub progress: f32,
    pub stage: String,
    pub is_complete: bool,
    pub error: Option<String>,
}

impl ProcessingStatus {
    fn running(song_id: &str, progress: f32, stage: String) -> Self {
        Self { song_id: song_id.to_string(), progress, stage, is_complete: false, error: None }
    }

    fn complete(song_id: &str) -> Self {
        Self {
            song_id: song_id.to_string(),
            progress: 1.0,
            stage: "complete".to_string(),
            is_complete: true,
            error: None,
        }
    }

    fn failed(song_id: &str, message: &str) -> Self {
        Self {
            song_id: song_id.to_string(),
            progress: 0.0,
            stage: "error".to_string(),
            is_complete: true,
            error: Some(message.to_string()),
        }
    }
}

fn emit_status(app: &AppHandle, status: ProcessingStatus) {
    if let Err(e) = app.emit("processing-progress", status) {
        log::warn!("Could not emit processing-progress: {e}");
    }
}

/// CPU-only Demucs (no CUDA) with high_quality + guitar/piano stems runs a
/// 2-pass htdemucs_ft → htdemucs_6s cascade with no progress ticks during
/// the actual model inference, so the gap between messages can legitimately
/// exceed the old 600s on slow/GPU-less hardware — see MPS wiki/known-issues.md.
const JOB_TIMEOUT: Duration = Duration::from_secs(3600);

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

/// Wait for the final result of the command already sent to the sidecar,
/// handing each progress tick to `on_progress`. A sidecar error becomes the
/// `Err` (its traceback is logged); a silent sidecar becomes a timeout error.
fn wait_for_result(
    sidecar: &SidecarManager,
    timeout: Duration,
    mut on_progress: impl FnMut(f32, String),
) -> Result<serde_json::Value, String> {
    loop {
        match sidecar.recv_timeout(timeout)? {
            SidecarMessage::Progress { value, stage, .. } => on_progress(value, stage),
            SidecarMessage::Result { data, .. } => return Ok(data),
            SidecarMessage::Error { message, traceback, cmd } => {
                log::error!(
                    "Sidecar error ({}): {message}\n{}",
                    cmd.as_deref().unwrap_or("?"),
                    traceback.unwrap_or_default()
                );
                return Err(message);
            }
            _ => {}
        }
    }
}

/// Send `cmd` to the (lazily spawned) sidecar and wait for its result. The
/// sidecar lock is held for the whole exchange, so jobs run one at a time.
fn run_sidecar_command(
    state: &SidecarState,
    cmd: &serde_json::Value,
    timeout: Duration,
    on_progress: impl FnMut(f32, String),
) -> Result<serde_json::Value, String> {
    let guard = ensure_sidecar(state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(cmd)?;
    wait_for_result(sidecar, timeout, on_progress)
}

/// Build the library entry for a finished `process` / `import_yt` job from the
/// sidecar's result payload.
pub(crate) fn song_from_result(
    song_id: &str,
    title: String,
    directory: String,
    data: &serde_json::Value,
) -> Song {
    Song {
        id: song_id.to_string(),
        title,
        duration: data.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        detected_key: data.get("detectedKey").and_then(|v| v.as_str()).map(|s| s.to_string()),
        detected_bpm: data.get("detectedBpm").and_then(|v| v.as_f64()),
        processed_at: chrono::Utc::now().to_rfc3339(),
        directory,
        stems: data
            .get("stems")
            .and_then(|v| v.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default(),
        metronome_offset: None,
        has_chords: data.get("chords").and_then(|v| v.as_bool()).unwrap_or(false),
        folder_id: None,
        sort_index: 0,
    }
}

/// Run a song-producing sidecar job, reporting progress through `emit`, and
/// add the resulting song to the library. `title` is used when given,
/// otherwise the sidecar's own `title` (YouTube) is.
fn run_song_job(
    state: &SidecarState,
    cmd: &serde_json::Value,
    song_id: &str,
    directory: String,
    title: Option<String>,
    emit: &impl Fn(ProcessingStatus),
) -> Result<Song, String> {
    let outcome = run_sidecar_command(state, cmd, JOB_TIMEOUT, |value, stage| {
        emit(ProcessingStatus::running(song_id, value, stage));
    });
    match outcome {
        Ok(data) => {
            emit(ProcessingStatus::complete(song_id));
            let title = title.unwrap_or_else(|| {
                data.get("title").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string()
            });
            let song = song_from_result(song_id, title, directory, &data);
            library::add(song.clone())?;
            Ok(song)
        }
        Err(message) => {
            emit(ProcessingStatus::failed(song_id, &message));
            // The song never reached library.json, so nothing else would ever
            // clean up the copied source and any partial stems.
            if let Err(e) = std::fs::remove_dir_all(&directory) {
                log::warn!("Could not remove the directory of the failed job {directory}: {e}");
            }
            Err(message)
        }
    }
}

pub(crate) fn process_song_impl(
    state: &SidecarState,
    file_path: String,
    stems_to_extract: Option<Vec<String>>,
    high_quality: Option<bool>,
    emit: &impl Fn(ProcessingStatus),
) -> Result<Song, String> {
    let src = Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let file_name = src.file_name().ok_or("Invalid file name")?.to_string_lossy();
    let title = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);
    let dest = output_dir.join(file_name.as_ref());
    std::fs::copy(src, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    let output_dir_str = output_dir.to_string_lossy().to_string();
    let mut cmd = serde_json::json!({
        "cmd": "process",
        "filePath": dest.to_string_lossy(),
        "outputDir": output_dir_str,
    });
    if let Some(ref stems) = stems_to_extract {
        cmd["stemsToExtract"] = serde_json::json!(stems);
    }
    if let Some(hq) = high_quality {
        cmd["highQuality"] = serde_json::json!(hq);
    }

    run_song_job(state, &cmd, &song_id, output_dir_str, Some(title), emit)
}

#[tauri::command]
pub async fn process_song(
    app: AppHandle,
    state: State<'_, SidecarState>,
    file_path: String,
    stems_to_extract: Option<Vec<String>>,
    high_quality: Option<bool>,
) -> Result<Song, String> {
    process_song_impl(&state, file_path, stems_to_extract, high_quality, &|s| emit_status(&app, s))
}

#[tauri::command]
pub async fn list_songs() -> Result<Vec<Song>, String> {
    library::load_songs()
}

#[tauri::command]
pub async fn delete_song(song_id: String) -> Result<(), String> {
    library::remove(&song_id)
}

#[tauri::command]
pub async fn set_metronome_offset(song_id: String, offset: Option<f64>) -> Result<Song, String> {
    library::update_metronome_offset(&song_id, offset)
}

// --- Folder commands ---

#[tauri::command]
pub async fn list_folders() -> Result<Vec<library::Folder>, String> {
    library::load_folders()
}

#[tauri::command]
pub async fn create_folder(name: String) -> Result<library::Folder, String> {
    library::create_folder(&name)
}

#[tauri::command]
pub async fn rename_folder(folder_id: String, name: String) -> Result<library::Folder, String> {
    library::rename_folder(&folder_id, &name)
}

#[tauri::command]
pub async fn delete_folder(folder_id: String) -> Result<(), String> {
    library::delete_folder(&folder_id)
}

#[tauri::command]
pub async fn reorder_folders(ordered_ids: Vec<String>) -> Result<Vec<library::Folder>, String> {
    library::reorder_folders(&ordered_ids)
}

#[tauri::command]
pub async fn move_songs(
    folder_id: Option<String>,
    ordered_song_ids: Vec<String>,
) -> Result<Vec<Song>, String> {
    library::move_songs(folder_id, &ordered_song_ids)
}

pub(crate) fn is_youtube_url(url: &str) -> bool {
    url.contains("youtube.com/") || url.contains("youtu.be/")
}

pub(crate) fn import_youtube_impl(
    state: &SidecarState,
    url: String,
    stems_to_extract: Option<Vec<String>>,
    high_quality: Option<bool>,
    cookies_path: Option<String>,
    emit: &impl Fn(ProcessingStatus),
) -> Result<Song, String> {
    if !is_youtube_url(&url) {
        return Err("Not a valid YouTube URL".to_string());
    }

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir_str = storage::song_dir(&song_id).to_string_lossy().to_string();

    let mut cmd = serde_json::json!({
        "cmd": "import_yt",
        "url": url,
        "outputDir": output_dir_str,
    });
    if let Some(ref stems) = stems_to_extract {
        cmd["stemsToExtract"] = serde_json::json!(stems);
    }
    if let Some(hq) = high_quality {
        cmd["highQuality"] = serde_json::json!(hq);
    }
    if let Some(ref cookies) = cookies_path {
        cmd["cookiesPath"] = serde_json::json!(cookies);
    }

    run_song_job(state, &cmd, &song_id, output_dir_str, None, emit)
}

#[tauri::command]
pub async fn import_youtube(
    app: AppHandle,
    state: State<'_, SidecarState>,
    url: String,
    stems_to_extract: Option<Vec<String>>,
    high_quality: Option<bool>,
    cookies_path: Option<String>,
) -> Result<Song, String> {
    import_youtube_impl(&state, url, stems_to_extract, high_quality, cookies_path, &|s| emit_status(&app, s))
}

#[tauri::command]
pub async fn read_song_chords(song_id: String) -> Result<Vec<ChordSegment>, String> {
    library::read_chords(&song_id)
}

/// Ask the user where to save a file. `None` means they cancelled.
async fn choose_save_path(
    app: &AppHandle,
    suggested_name: &str,
    filter_name: &'static str,
    extensions: &'static [&'static str],
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.to_string();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter(filter_name, extensions)
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    match picked {
        Some(path) => Ok(Some(path.as_path().ok_or("Invalid path")?.to_path_buf())),
        None => Ok(None),
    }
}

/// Offer `src` through a Save As dialog and copy it to the chosen location.
async fn save_copy_via_dialog(
    app: &AppHandle,
    src: &Path,
    suggested_name: &str,
    filter_name: &'static str,
    extensions: &'static [&'static str],
) -> Result<(), String> {
    if let Some(dest) = choose_save_path(app, suggested_name, filter_name, extensions).await? {
        std::fs::copy(src, dest).map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_stem(
    app: AppHandle,
    stem_path: String,
    suggested_name: String,
) -> Result<(), String> {
    let src = Path::new(&stem_path);
    if !src.exists() {
        return Err(format!("Stem not found: {stem_path}"));
    }
    save_copy_via_dialog(&app, src, &suggested_name, "Audio", &["wav"]).await
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntry {
    pub path: String,
    pub archive_name: String,
}

pub(crate) fn write_zip_archive(dest: &Path, entries: &[ZipEntry]) -> Result<(), String> {
    let file = std::fs::File::create(dest).map_err(|e| format!("Create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in entries {
        let mut src =
            std::fs::File::open(&entry.path).map_err(|e| format!("Open {}: {e}", entry.path))?;
        zip.start_file(&entry.archive_name, options)
            .map_err(|e| format!("Zip entry {}: {e}", entry.archive_name))?;
        std::io::copy(&mut src, &mut zip).map_err(|e| format!("Write {}: {e}", entry.archive_name))?;
    }
    zip.finish().map_err(|e| format!("Finish zip: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn export_all(
    app: AppHandle,
    entries: Vec<ZipEntry>,
    suggested_name: String,
) -> Result<(), String> {
    if entries.is_empty() {
        return Err("Nothing to export".to_string());
    }

    let Some(dest) = choose_save_path(&app, &suggested_name, "Zip Archive", &["zip"]).await? else {
        return Ok(());
    };

    tauri::async_runtime::spawn_blocking(move || write_zip_archive(&dest, &entries))
        .await
        .map_err(|e| format!("Zip task: {e}"))?
}

// --- Take (recorded track) commands ---

/// Ask the sidecar to RMS-normalize a raw recording against `reference_path`
/// (or the fixed fallback target). Returns the normalized WAV's path, or
/// `None` when normalization was not possible — the caller then keeps the raw
/// recording, so every failure here is logged rather than raised.
fn normalize_take_via_sidecar(
    state: &SidecarState,
    recording_path: &str,
    output_path: &str,
    reference_path: Option<&str>,
    audio_offset: f64,
) -> Option<String> {
    let mut cmd = serde_json::json!({
        "cmd": "normalize_take",
        "recordingPath": recording_path,
        "outputPath": output_path,
        "audioOffset": audio_offset,
    });
    if let Some(reference) = reference_path {
        cmd["referencePath"] = serde_json::json!(reference);
    }
    match run_sidecar_command(state, &cmd, Duration::from_secs(120), |_, _| {}) {
        Ok(data) => data.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()),
        Err(e) => {
            log::warn!("Take normalization failed, keeping the raw recording: {e}");
            None
        }
    }
}

pub(crate) fn save_take_impl(
    state: &SidecarState,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
    audio_offset: f64,
) -> Result<Take, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let song_dir = storage::song_dir(&song_id);
    let takes_dir = song_dir.join("takes");
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create takes dir: {e}"))?;

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let normalized_output_str = takes_dir.join(format!("{take_id}.wav")).to_string_lossy().to_string();
    let vocals_path = song_dir.join("vocals.wav");
    let reference_path_str = vocals_path.exists().then(|| vocals_path.to_string_lossy().to_string());

    let normalized_path = normalize_take_via_sidecar(
        state,
        &file_path_str,
        &normalized_output_str,
        reference_path_str.as_deref(),
        audio_offset,
    );

    // Prefer the loudness-normalized WAV; fall back to the raw webm if normalization failed.
    let final_file_path_str = match &normalized_path {
        Some(p) => {
            if let Err(e) = std::fs::remove_file(&file_path) {
                log::warn!("Could not remove raw take recording {file_path_str}: {e}");
            }
            p.clone()
        }
        None => file_path_str,
    };

    let take = Take {
        id: take_id,
        song_id: song_id.clone(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: final_file_path_str,
        name: None,
        start_position,
        audio_offset,
        manual_offset: 0.0,
    };

    takes::add(&song_id, take.clone())?;
    Ok(take)
}

#[tauri::command]
pub async fn save_take(
    state: State<'_, SidecarState>,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
    audio_offset: f64,
) -> Result<Take, String> {
    save_take_impl(&state, song_id, audio_data, start_position, audio_offset)
}

#[tauri::command]
pub async fn list_takes(song_id: String) -> Result<Vec<Take>, String> {
    takes::load(&song_id)
}

#[tauri::command]
pub async fn delete_take(song_id: String, take_id: String) -> Result<(), String> {
    takes::remove(&song_id, &take_id)
}

#[tauri::command]
pub async fn rename_take(song_id: String, take_id: String, name: String) -> Result<Take, String> {
    takes::rename(&song_id, &take_id, &name)
}

#[tauri::command]
pub async fn set_take_manual_offset(song_id: String, take_id: String, offset: f64) -> Result<Take, String> {
    takes::set_manual_offset(&song_id, &take_id, offset)
}

/// Deletes the wrapped temp file when dropped.
#[derive(Debug)]
pub(crate) struct TempFile(pub(crate) PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            log::warn!("Failed to remove temp export file {:?}: {e}", self.0);
        }
    }
}

fn temp_wav_path() -> PathBuf {
    std::env::temp_dir().join(format!("{}.wav", uuid::Uuid::new_v4()))
}

/// The take is webm/opus (whatever MediaRecorder produced) or an already
/// normalized WAV; decode it via the sidecar into a temp WAV file for export.
pub(crate) fn convert_take_to_temp_wav(state: &SidecarState, take_path: &str) -> Result<TempFile, String> {
    if !Path::new(take_path).exists() {
        return Err(format!("Take not found: {take_path}"));
    }
    let temp = TempFile(temp_wav_path());
    let cmd = serde_json::json!({
        "cmd": "convert_take",
        "recordingPath": take_path,
        "outputPath": temp.0.to_string_lossy(),
    });
    run_sidecar_command(state, &cmd, Duration::from_secs(120), |_, _| {})?;
    Ok(temp)
}

#[tauri::command]
pub async fn export_take(
    app: AppHandle,
    state: State<'_, SidecarState>,
    take_path: String,
    suggested_name: String,
) -> Result<(), String> {
    let temp = convert_take_to_temp_wav(&state, &take_path)?;
    save_copy_via_dialog(&app, &temp.0, &suggested_name, "Audio", &["wav"]).await
}

pub(crate) fn pitch_shift_song_impl(
    state: &SidecarState,
    song_dir: String,
    stem_names: Vec<String>,
    n_steps: i32,
) -> Result<serde_json::Value, String> {
    let cache_dir = Path::new(&song_dir).join("pitched").join(n_steps.to_string());
    let cached_path = |name: &str| cache_dir.join(format!("{name}.wav"));

    if stem_names.iter().all(|name| cached_path(name).exists()) {
        let cached: std::collections::HashMap<String, String> = stem_names
            .iter()
            .map(|name| (name.clone(), cached_path(name).to_string_lossy().to_string()))
            .collect();
        return Ok(serde_json::json!({ "stems": cached }));
    }

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir: {e}"))?;

    let cmd = serde_json::json!({
        "cmd": "pitch_shift",
        "songDir": song_dir,
        "cacheDir": cache_dir.to_string_lossy(),
        "stemNames": stem_names,
        "nSteps": n_steps,
    });
    run_sidecar_command(state, &cmd, Duration::from_secs(300), |_, _| {})
}

/// Phase-vocoder pitch-shift every requested stem by `n_steps` semitones,
/// cached under `{song_dir}/pitched/{n_steps}/{stem}.wav` (ported from VPS's
/// `pitch_shift_song`, generalized from the fixed vocals/instrumental pair to
/// SPS's dynamic stem set).
#[tauri::command]
pub async fn pitch_shift_song(
    state: State<'_, SidecarState>,
    song_dir: String,
    stem_names: Vec<String>,
    n_steps: i32,
) -> Result<serde_json::Value, String> {
    pitch_shift_song_impl(&state, song_dir, stem_names, n_steps)
}

/// One track to include in an `export_mix` render. `gain` is the final
/// linear volume already resolved from mute/solo/volume by the frontend —
/// this command has no concept of mute/solo, only gains. `start_position`/
/// `audio_offset` are only meaningful for `is_take` sources (see the
/// `fileTime = projectTime - startPosition + audioOffset` mapping in
/// `player.ts`); omitted for plain stem sources.
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MixSource {
    pub path: String,
    pub gain: f64,
    pub is_take: bool,
    pub start_position: Option<f64>,
    pub audio_offset: Option<f64>,
    pub manual_offset: Option<f64>,
}

pub(crate) fn render_mix_to_temp_wav(
    state: &SidecarState,
    sources: &[MixSource],
    start_sec: f64,
    end_sec: f64,
) -> Result<TempFile, String> {
    if sources.is_empty() {
        return Err("No audible tracks to export".to_string());
    }
    let temp = TempFile(temp_wav_path());
    let cmd = serde_json::json!({
        "cmd": "mix_export",
        "outputPath": temp.0.to_string_lossy(),
        "startSec": start_sec,
        "endSec": end_sec,
        "sources": sources,
    });
    run_sidecar_command(state, &cmd, Duration::from_secs(120), |_, _| {})?;
    Ok(temp)
}

#[tauri::command]
pub async fn export_mix(
    app: AppHandle,
    state: State<'_, SidecarState>,
    sources: Vec<MixSource>,
    start_sec: f64,
    end_sec: f64,
    suggested_name: String,
) -> Result<(), String> {
    let temp = render_mix_to_temp_wav(&state, &sources, start_sec, end_sec)?;
    save_copy_via_dialog(&app, &temp.0, &suggested_name, "Audio", &["wav"]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;
    use serde_json::json;
    use std::cell::RefCell;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn offline_state() -> SidecarState {
        SidecarState(std::sync::Mutex::new(None))
    }

    fn sidecar_was_spawned(state: &SidecarState) -> bool {
        state.0.lock().unwrap().is_some()
    }

    fn take(id: &str) -> Take {
        Take {
            id: id.to_string(),
            song_id: "s1".to_string(),
            recorded_at: "2026-01-01T00:00:00Z".to_string(),
            filepath: String::new(),
            name: None,
            start_position: 0.0,
            audio_offset: 0.0,
            manual_offset: 0.0,
        }
    }

    fn write_takes(song_id: &str, list: &[Take]) {
        for t in list {
            takes::add(song_id, t.clone()).unwrap();
        }
    }

    // ── result -> Song ────────────────────────────────────────────────────

    #[test]
    fn a_full_result_becomes_a_song_with_every_field() {
        let data = json!({
            "stems": {"vocals": "/a/vocals.wav", "bass": "/a/bass.wav"},
            "duration": 215.5, "detectedBpm": 120.5, "detectedKey": "A minor", "chords": true, "bassTab": true,
        });
        let song = song_from_result("id-1", "Title".into(), "/dir".into(), &data);
        assert_eq!((song.id.as_str(), song.title.as_str(), song.directory.as_str()), ("id-1", "Title", "/dir"));
        assert_eq!(song.duration, 215.5);
        assert_eq!(song.detected_bpm, Some(120.5));
        assert_eq!(song.detected_key.as_deref(), Some("A minor"));
        assert!(song.has_chords);
        let mut stems = song.stems.clone();
        stems.sort();
        assert_eq!(stems, ["bass", "vocals"]);
        assert_eq!((song.metronome_offset, song.folder_id, song.sort_index), (None, None, 0));
        assert!(chrono::DateTime::parse_from_rfc3339(&song.processed_at).is_ok());
    }

    #[test]
    fn a_sparse_result_falls_back_to_safe_defaults() {
        let song = song_from_result("id", "T".into(), "/d".into(), &json!({}));
        assert_eq!(song.duration, 0.0);
        assert!(song.detected_bpm.is_none() && song.detected_key.is_none());
        assert!(!song.has_chords);
        assert!(song.stems.is_empty());
    }

    #[test]
    fn null_tempo_and_key_stay_unset_and_wrongly_typed_fields_are_ignored() {
        let song = song_from_result(
            "id", "T".into(), "/d".into(),
            &json!({"detectedBpm": null, "detectedKey": 5, "chords": "yes", "stems": ["vocals"], "duration": "long"}),
        );
        assert!(song.detected_bpm.is_none() && song.detected_key.is_none());
        assert!(!song.has_chords && song.stems.is_empty());
        assert_eq!(song.duration, 0.0);
    }

    // ── processing events ─────────────────────────────────────────────────

    #[test]
    fn processing_status_serializes_camel_case() {
        let v = serde_json::to_value(ProcessingStatus::running("s", 0.5, "separating".into())).unwrap();
        assert_eq!(v["songId"], "s");
        assert_eq!(v["isComplete"], false);
        assert_eq!(v["progress"], 0.5);
        assert!(v["error"].is_null());
        assert!(v.get("is_complete").is_none());
    }

    #[test]
    fn complete_and_failed_statuses_end_the_job() {
        let done = ProcessingStatus::complete("s");
        assert!(done.is_complete && done.progress == 1.0 && done.stage == "complete" && done.error.is_none());
        let failed = ProcessingStatus::failed("s", "boom");
        assert!(failed.is_complete && failed.stage == "error");
        assert_eq!(failed.error.as_deref(), Some("boom"));
    }

    // ── input validation (no sidecar needed) ──────────────────────────────

    #[test]
    fn only_youtube_links_are_accepted() {
        for ok in [
            "https://www.youtube.com/watch?v=abc",
            "https://youtube.com/watch?v=abc",
            "https://music.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "http://youtu.be/abc?t=5",
        ] {
            assert!(is_youtube_url(ok), "{ok}");
        }
        for bad in ["", "https://vimeo.com/123", "https://example.com/", "not a url", "youtube.com", "https://notyoutube.org/x"] {
            assert!(!is_youtube_url(bad), "{bad}");
        }
    }

    #[test]
    fn an_invalid_youtube_url_is_rejected_before_anything_is_created_or_spawned() {
        let home = TestHome::new();
        let state = offline_state();
        let events = RefCell::new(Vec::new());
        let err = import_youtube_impl(&state, "https://vimeo.com/1".into(), None, None, None, &|s| events.borrow_mut().push(s))
            .unwrap_err();
        assert_eq!(err, "Not a valid YouTube URL");
        assert!(events.borrow().is_empty());
        assert!(!sidecar_was_spawned(&state));
        assert!(!home.path().join("library").exists() || home.path().join("library").read_dir().unwrap().next().is_none());
    }

    #[test]
    fn processing_a_missing_file_fails_before_a_song_directory_is_made() {
        let home = TestHome::new();
        let state = offline_state();
        let err = process_song_impl(&state, "/no/such/song.mp3".into(), None, None, &|_| {}).unwrap_err();
        assert_eq!(err, "File not found: /no/such/song.mp3");
        assert!(!sidecar_was_spawned(&state));
        assert!(!home.path().join("library").exists() || home.path().join("library").read_dir().unwrap().next().is_none());
        assert!(library::load_songs().unwrap().is_empty());
    }

    #[test]
    fn exports_with_nothing_to_export_are_refused_without_the_sidecar() {
        let _home = TestHome::new();
        let state = offline_state();
        assert_eq!(render_mix_to_temp_wav(&state, &[], 0.0, 1.0).unwrap_err(), "No audible tracks to export");
        assert_eq!(
            convert_take_to_temp_wav(&state, "/no/such/take.wav").unwrap_err(),
            "Take not found: /no/such/take.wav"
        );
        assert!(!sidecar_was_spawned(&state));
    }

    // ── pitch shift cache ─────────────────────────────────────────────────

    #[test]
    fn a_fully_cached_transpose_is_returned_without_starting_the_sidecar() {
        let home = TestHome::new();
        let cache = home.path().join("song").join("pitched").join("-2");
        std::fs::create_dir_all(&cache).unwrap();
        for n in ["vocals", "bass"] {
            std::fs::write(cache.join(format!("{n}.wav")), b"x").unwrap();
        }
        let state = offline_state();
        let v = pitch_shift_song_impl(
            &state,
            home.path().join("song").to_string_lossy().to_string(),
            vec!["vocals".into(), "bass".into()],
            -2,
        )
        .unwrap();
        assert_eq!(v["stems"]["vocals"], cache.join("vocals.wav").to_string_lossy().to_string());
        assert_eq!(v["stems"]["bass"], cache.join("bass.wav").to_string_lossy().to_string());
        assert!(!sidecar_was_spawned(&state));
    }

    // ── zip export ────────────────────────────────────────────────────────

    fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
        use std::io::Read;
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut f = archive.by_index(i).unwrap();
                let mut body = Vec::new();
                f.read_to_end(&mut body).unwrap();
                (f.name().to_string(), body)
            })
            .collect()
    }

    #[test]
    fn the_zip_holds_every_entry_under_its_archive_name_with_its_contents() {
        let home = TestHome::new();
        let a = home.path().join("a.wav");
        let b = home.path().join("b.wav");
        std::fs::write(&a, vec![1u8; 5000]).unwrap();
        std::fs::write(&b, b"bee").unwrap();
        let dest = home.path().join("out.zip");
        write_zip_archive(
            &dest,
            &[
                ZipEntry { path: a.to_string_lossy().to_string(), archive_name: "Vocals.wav".into() },
                ZipEntry { path: b.to_string_lossy().to_string(), archive_name: "Take 1.wav".into() },
            ],
        )
        .unwrap();
        let got = zip_entries(&dest);
        assert_eq!(got.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["Vocals.wav", "Take 1.wav"]);
        assert_eq!(got[0].1, vec![1u8; 5000]);
        assert_eq!(got[1].1, b"bee");
    }

    #[test]
    fn a_missing_source_file_fails_the_export_and_names_the_file() {
        let home = TestHome::new();
        let err = write_zip_archive(
            &home.path().join("o.zip"),
            &[ZipEntry { path: "/no/such.wav".into(), archive_name: "x.wav".into() }],
        )
        .unwrap_err();
        assert!(err.starts_with("Open /no/such.wav"), "{err}");
    }

    #[test]
    fn two_entries_with_the_same_archive_name_are_an_error_not_a_silent_overwrite() {
        let home = TestHome::new();
        let a = home.path().join("a.wav");
        std::fs::write(&a, b"a").unwrap();
        let p = a.to_string_lossy().to_string();
        let err = write_zip_archive(
            &home.path().join("o.zip"),
            &[
                ZipEntry { path: p.clone(), archive_name: "same.wav".into() },
                ZipEntry { path: p, archive_name: "same.wav".into() },
            ],
        )
        .unwrap_err();
        assert!(err.contains("same.wav"), "{err}");
    }

    #[test]
    fn an_unwritable_destination_is_reported() {
        let home = TestHome::new();
        let err = write_zip_archive(&home.path().join("no-such-dir").join("o.zip"), &[]).unwrap_err();
        assert!(err.starts_with("Create zip"), "{err}");
    }

    #[test]
    fn zip_entries_deserialize_from_the_frontend_shape() {
        let e: ZipEntry = serde_json::from_str(r#"{"path":"/p","archiveName":"A.wav"}"#).unwrap();
        assert_eq!((e.path.as_str(), e.archive_name.as_str()), ("/p", "A.wav"));
    }

    // ── mix sources ───────────────────────────────────────────────────────

    #[test]
    fn a_mix_source_from_the_frontend_deserializes_with_optional_take_fields() {
        let stem: MixSource = serde_json::from_str(r#"{"path":"/s.wav","gain":0.5,"isTake":false}"#).unwrap();
        assert!(!stem.is_take && stem.start_position.is_none() && stem.manual_offset.is_none());
        let t: MixSource = serde_json::from_str(
            r#"{"path":"/t.wav","gain":1,"isTake":true,"startPosition":12.5,"audioOffset":0.25,"manualOffset":-1}"#,
        )
        .unwrap();
        assert_eq!((t.start_position, t.audio_offset, t.manual_offset), (Some(12.5), Some(0.25), Some(-1.0)));
    }

    #[test]
    fn a_mix_source_serializes_back_with_the_keys_the_sidecar_reads() {
        let v = serde_json::to_value(MixSource {
            path: "/p".into(), gain: 0.8, is_take: true,
            start_position: Some(3.0), audio_offset: Some(0.1), manual_offset: None,
        })
        .unwrap();
        for key in ["path", "gain", "isTake", "startPosition", "audioOffset"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        assert!(v["manualOffset"].is_null());
    }

    // ── takes ─────────────────────────────────────────────────────────────

    #[test]
    fn take_serializes_camel_case_and_omits_empty_optionals() {
        let v = serde_json::to_value(take("t")).unwrap();
        for key in ["id", "songId", "recordedAt", "filepath", "startPosition"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        for key in ["name", "audioOffset", "manualOffset"] {
            assert!(v.get(key).is_none(), "{key} should be omitted when empty");
        }
    }

    #[test]
    fn take_keeps_nonzero_offsets_and_its_name() {
        let mut t = take("t");
        t.audio_offset = 0.25;
        t.manual_offset = -1.5;
        t.name = Some("Verse".into());
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!((v["audioOffset"].as_f64(), v["manualOffset"].as_f64()), (Some(0.25), Some(-1.5)));
        assert_eq!(v["name"], "Verse");
    }

    #[test]
    fn take_from_an_old_takes_json_parses_with_defaults() {
        let old = r#"{"id":"t","songId":"s","recordedAt":"x","filepath":"/t.webm"}"#;
        let t: Take = serde_json::from_str(old).unwrap();
        assert_eq!((t.start_position, t.audio_offset, t.manual_offset), (0.0, 0.0, 0.0));
        assert!(t.name.is_none());
    }

    #[test]
    fn take_commands_round_trip_through_the_real_store() {
        let home = TestHome::new();
        assert!(run(list_takes("s1".into())).unwrap().is_empty());
        let file = home.path().join("a.wav");
        std::fs::write(&file, b"a").unwrap();
        let mut a = take("a");
        a.filepath = file.to_string_lossy().to_string();
        write_takes("s1", &[a, take("b")]);

        assert_eq!(run(list_takes("s1".into())).unwrap().len(), 2);
        assert_eq!(run(rename_take("s1".into(), "a".into(), "  Chorus  ".into())).unwrap().name.as_deref(), Some("Chorus"));
        assert_eq!(run(set_take_manual_offset("s1".into(), "a".into(), -0.75)).unwrap().manual_offset, -0.75);

        run(delete_take("s1".into(), "a".into())).unwrap();
        assert!(!file.exists(), "deleting a take deletes its audio file");
        assert_eq!(run(list_takes("s1".into())).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    // ── library command pass-throughs ─────────────────────────────────────

    #[test]
    fn library_commands_round_trip_through_the_real_store() {
        let _home = TestHome::new();
        assert!(run(list_songs()).unwrap().is_empty());
        library::add(song_from_result(
            "a", "A".into(), storage::song_dir("a").to_string_lossy().to_string(), &json!({"duration": 1.0}),
        ))
        .unwrap();

        assert_eq!(run(set_metronome_offset("a".into(), Some(3.0))).unwrap().metronome_offset, Some(3.0));

        let folder = run(create_folder("Band".into())).unwrap();
        assert_eq!(run(list_folders()).unwrap().len(), 1);
        assert_eq!(run(rename_folder(folder.id.clone(), "Group".into())).unwrap().name, "Group");
        let moved = run(move_songs(Some(folder.id.clone()), vec!["a".into()])).unwrap();
        assert_eq!(moved[0].folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!(run(reorder_folders(vec![folder.id.clone()])).unwrap()[0].sort_index, 0);
        run(delete_folder(folder.id)).unwrap();
        assert_eq!(run(list_songs()).unwrap()[0].folder_id, None);

        let dir = storage::song_dir("a");
        assert!(dir.exists());
        run(delete_song("a".into())).unwrap();
        assert!(!dir.exists());
        assert!(run(list_songs()).unwrap().is_empty());
    }

    #[test]
    fn chords_are_read_from_the_songs_chords_json() {
        let _home = TestHome::new();
        let dir = storage::song_dir("a");
        std::fs::write(
            dir.join("chords.json"),
            json!({"version": 1, "duration": 8.0, "segments": [{"start": 0.0, "end": 4.0, "chord": "C:maj"}]}).to_string(),
        )
        .unwrap();
        library::add(song_from_result("a", "A".into(), dir.to_string_lossy().to_string(), &json!({}))).unwrap();
        let segments = run(read_song_chords("a".into())).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!((segments[0].start, segments[0].end, segments[0].chord.as_str()), (0.0, 4.0, "C:maj"));
        assert!(run(read_song_chords("ghost".into())).unwrap_err().contains("ghost"));
    }

    // ── the sidecar's silent-failure paths ────────────────────────────────

    #[test]
    fn temp_files_are_removed_when_dropped_and_a_missing_one_is_tolerated() {
        let home = TestHome::new();
        let path = home.path().join("t.wav");
        std::fs::write(&path, b"x").unwrap();
        drop(TempFile(path.clone()));
        assert!(!path.exists());
        drop(TempFile(path));
    }
}
