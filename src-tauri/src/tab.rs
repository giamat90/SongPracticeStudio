//! Tab sync: a Guitar Pro tab kept beside a song, and where its bar lines fall
//! in the recording. The file and `tab_sync.json` live in the song directory;
//! the Tauri command wrappers live in `commands.rs`.

use crate::commands::{run_sidecar_command, SidecarState};
use crate::library::{self, Song};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const FORMAT_VERSION: u32 = 1;
const SYNC_FILE: &str = "tab_sync.json";
const SCORE_FILE: &str = "tab_score.json";
/// The user's string choices for a transposed song, per transposition; the stored tab itself never changes for them.
const TRANSPOSED_FILE: &str = "tab_transposed.json";
const MAX_TRANSPOSED_BYTES: usize = 1024 * 1024;
const TAB_STEM: &str = "tab";
/// The file as it was imported, kept once the user edits the tab so the edits can be undone.
const ORIGINAL_STEM: &str = "tab.original";
/// What an edited tab is saved as, whatever format it was imported in.
const EDITED_EXT: &str = "gp";
const MAX_TAB_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SCORE_BYTES: usize = 64 * 1024 * 1024;
const ALIGN_TIMEOUT: Duration = Duration::from_secs(300);
/// The formats alphaTab reads that a user is likely to own.
const EXTENSIONS: [&str; 7] = ["gp", "gp3", "gp4", "gp5", "gpx", "musicxml", "xml"];
/// Stems that carry what a tab plays; the drum stem steadies the bar lines.
const ALIGN_STEMS: [&str; 5] = ["guitar", "bass", "piano", "other", "drums"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBar {
    /// Index of the bar in the tab (its master bar), not its position in play order.
    pub index: u32,
    /// Which pass over a repeated bar this is (0 for the first).
    pub occurrence: u32,
    /// Seconds into the recording at which the bar starts.
    pub time: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSync {
    pub version: u32,
    pub algorithm: String,
    /// Stamped by the app when it stores the result; the sidecar does not send it.
    #[serde(default)]
    pub aligned_at: String,
    /// Where the tab's first bar falls at a constant tempo (the global lag).
    pub offset: f64,
    /// Semitones the recording sounds above the tab.
    pub transpose: i32,
    pub used_drums: bool,
    pub peak: f64,
    pub mean_cost: f64,
    pub steadiness: f64,
    /// "good", "check" or "poor": how far the alignment can be trusted.
    pub quality: String,
    /// True once the user has moved a bar line.
    #[serde(default)]
    pub edited: bool,
    pub bars: Vec<TabBar>,
}

/// What the frontend needs to show a song's tab.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub file_name: String,
    pub original_name: String,
    /// Absolute path of the stored tab (served through the asset protocol).
    pub path: String,
    /// True once the tab has been edited: the imported file is kept for "revert".
    pub has_original: bool,
    pub sync: Option<TabSync>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabMeta {
    original_name: String,
}

fn find_song(song_id: &str) -> Result<Song, String> {
    library::load_songs()?
        .into_iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))
}

fn song_dir(song: &Song) -> PathBuf {
    PathBuf::from(&song.directory)
}

fn sync_path(song: &Song) -> PathBuf {
    song_dir(song).join(SYNC_FILE)
}

fn meta_path(song: &Song) -> PathBuf {
    song_dir(song).join("tab_meta.json")
}

/// The stored tab file, whatever its extension, or `None`.
fn tab_file(song: &Song) -> Result<Option<PathBuf>, String> {
    let dir = song_dir(song);
    if !dir.is_dir() {
        return Ok(None);
    }
    for ext in EXTENSIONS {
        let candidate = dir.join(format!("{TAB_STEM}.{ext}"));
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// The imported file kept beside an edited tab, or `None` while the tab is as imported.
fn original_file(song: &Song) -> Option<PathBuf> {
    EXTENSIONS
        .iter()
        .map(|ext| song_dir(song).join(format!("{ORIGINAL_STEM}.{ext}")))
        .find(|candidate| candidate.is_file())
}

fn write_atomic(path: &Path, data: &[u8], what: &str) -> Result<(), String> {
    if !path.parent().is_some_and(|dir| dir.is_dir()) {
        return Err("The song was removed while its tab was being saved.".to_string());
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data).map_err(|e| format!("Write {what}: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Write {what}: {e}"))
}

fn remove_if_present(path: &Path, what: &str) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete {what}: {e}")),
    }
}

fn load_sync(song: &Song) -> Result<Option<TabSync>, String> {
    let path = sync_path(song);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read tab sync: {e}"))?;
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Parse tab sync: {e}"))
}

fn save_sync(song: &Song, sync: &TabSync) -> Result<(), String> {
    let json = serde_json::to_string(sync).map_err(|e| format!("Serialize tab sync: {e}"))?;
    write_atomic(&sync_path(song), json.as_bytes(), "tab sync")
}

fn original_name(song: &Song, stored: &Path) -> String {
    std::fs::read_to_string(meta_path(song))
        .ok()
        .and_then(|raw| serde_json::from_str::<TabMeta>(&raw).ok())
        .map(|m| m.original_name)
        .unwrap_or_else(|| stored.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
}

/// The song's tab and its alignment, or `None` when it has no tab.
pub fn read(song_id: &str) -> Result<Option<TabRecord>, String> {
    let song = find_song(song_id)?;
    let Some(path) = tab_file(&song)? else {
        return Ok(None);
    };
    Ok(Some(TabRecord {
        file_name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        original_name: original_name(&song, &path),
        path: path.to_string_lossy().to_string(),
        has_original: original_file(&song).is_some(),
        sync: load_sync(&song)?,
    }))
}

/// Copy a tab file next to the song. A previous tab and its alignment are
/// replaced, because the old bar lines no longer describe the new file.
pub fn import(song_id: &str, source: &Path) -> Result<TabRecord, String> {
    let song = find_song(song_id)?;
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| {
            format!("Unsupported tab file. Choose a Guitar Pro file ({}).", EXTENSIONS.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(", "))
        })?;
    let meta = std::fs::metadata(source).map_err(|e| format!("Read tab file: {e}"))?;
    if !meta.is_file() {
        return Err("The tab is not a file.".to_string());
    }
    if meta.len() == 0 {
        return Err("The tab file is empty.".to_string());
    }
    if meta.len() > MAX_TAB_BYTES {
        return Err("The tab file is larger than 20 MB.".to_string());
    }
    let data = std::fs::read(source).map_err(|e| format!("Read tab file: {e}"))?;
    delete_files(&song)?;
    let dest = song_dir(&song).join(format!("{TAB_STEM}.{ext}"));
    write_atomic(&dest, &data, "tab")?;
    let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let meta_json = serde_json::to_string(&TabMeta { original_name: name }).map_err(|e| format!("Serialize tab: {e}"))?;
    write_atomic(&meta_path(&song), meta_json.as_bytes(), "tab")?;
    read(song_id)?.ok_or_else(|| "The tab could not be stored.".to_string())
}

/// Store the tab the user edited as `tab.gp`. The file as imported is kept once
/// (`tab.original.<ext>`), and the alignment stays: an edit that keeps every
/// pitch cannot move a bar line.
pub fn save_edited(song_id: &str, data: &[u8]) -> Result<TabRecord, String> {
    let song = find_song(song_id)?;
    if data.is_empty() {
        return Err("The edited tab is empty.".to_string());
    }
    if data.len() as u64 > MAX_TAB_BYTES {
        return Err("The edited tab is larger than 20 MB.".to_string());
    }
    let current = tab_file(&song)?.ok_or_else(|| "This song has no tab to edit.".to_string())?;
    if original_file(&song).is_none() {
        let ext = current.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let kept = std::fs::read(&current).map_err(|e| format!("Read tab: {e}"))?;
        write_atomic(&song_dir(&song).join(format!("{ORIGINAL_STEM}.{ext}")), &kept, "tab")?;
    }
    write_atomic(&song_dir(&song).join(format!("{TAB_STEM}.{EDITED_EXT}")), data, "tab")?;
    if current.extension().is_some_and(|e| e != EDITED_EXT) {
        remove_if_present(&current, "tab")?;
    }
    read(song_id)?.ok_or_else(|| "The tab could not be stored.".to_string())
}

/// The string choices saved for transposed songs, as the frontend wrote them, or `None` when there are none.
pub fn read_transposed(song_id: &str) -> Result<Option<String>, String> {
    let path = song_dir(&find_song(song_id)?).join(TRANSPOSED_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Read transposed tab edits: {e}")),
    }
}

/// Store the string choices for transposed songs (a JSON object, kept as written). An empty object removes the file.
pub fn save_transposed(song_id: &str, json: &str) -> Result<(), String> {
    let song = find_song(song_id)?;
    if json.len() > MAX_TRANSPOSED_BYTES {
        return Err("The transposed tab edits are larger than 1 MB.".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("The transposed tab edits are not valid JSON: {e}"))?;
    let object = value.as_object().ok_or_else(|| "The transposed tab edits must be a JSON object.".to_string())?;
    let path = song_dir(&song).join(TRANSPOSED_FILE);
    if object.is_empty() {
        return remove_if_present(&path, "transposed tab edits");
    }
    write_atomic(&path, json.as_bytes(), "transposed tab edits")
}

/// Put the imported file back and drop the edited one. The alignment is kept:
/// it was made from the imported file.
pub fn revert_edits(song_id: &str) -> Result<TabRecord, String> {
    let song = find_song(song_id)?;
    let original = original_file(&song).ok_or_else(|| "This tab has not been edited.".to_string())?;
    let ext = original.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let data = std::fs::read(&original).map_err(|e| format!("Read tab: {e}"))?;
    write_atomic(&song_dir(&song).join(format!("{TAB_STEM}.{ext}")), &data, "tab")?;
    if ext != EDITED_EXT {
        remove_if_present(&song_dir(&song).join(format!("{TAB_STEM}.{EDITED_EXT}")), "tab")?;
    }
    remove_if_present(&original, "tab")?;
    read(song_id)?.ok_or_else(|| "The tab could not be restored.".to_string())
}

fn delete_files(song: &Song) -> Result<(), String> {
    for ext in EXTENSIONS {
        remove_if_present(&song_dir(song).join(format!("{TAB_STEM}.{ext}")), "tab")?;
        remove_if_present(&song_dir(song).join(format!("{ORIGINAL_STEM}.{ext}")), "tab")?;
    }
    remove_if_present(&sync_path(song), "tab sync")?;
    remove_if_present(&meta_path(song), "tab")?;
    remove_if_present(&song_dir(song).join(SCORE_FILE), "tab score")?;
    remove_if_present(&song_dir(song).join(TRANSPOSED_FILE), "transposed tab edits")
}

pub fn delete(song_id: &str) -> Result<(), String> {
    delete_files(&find_song(song_id)?)
}

fn stem_paths(song: &Song) -> serde_json::Map<String, serde_json::Value> {
    let dir = song_dir(song);
    ALIGN_STEMS
        .iter()
        .filter(|name| song.stems.iter().any(|s| s == *name))
        .filter_map(|name| {
            let path = dir.join(format!("{name}.wav"));
            path.is_file().then(|| (name.to_string(), serde_json::Value::String(path.to_string_lossy().to_string())))
        })
        .collect()
}

/// Build the stored record from the sidecar's `tab_sync.json`, checking that
/// every bar the frontend sent came back.
fn load_result(path: &Path, expected_bars: usize, aligned_at: String) -> Result<TabSync, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Read tab alignment: {e}"))?;
    let mut sync: TabSync = serde_json::from_str(&raw).map_err(|e| format!("The sidecar returned a malformed tab alignment: {e}"))?;
    if sync.bars.len() != expected_bars {
        return Err(format!("The sidecar placed {} bars, expected {expected_bars}.", sync.bars.len()));
    }
    sync.version = FORMAT_VERSION;
    sync.aligned_at = aligned_at;
    sync.edited = false;
    Ok(sync)
}

/// Align the song's stored tab to its stems. `score_json` is the compact score
/// the frontend built from the tab (see `src/lib/tabScore.ts`).
pub fn align_impl(
    state: &SidecarState,
    song_id: &str,
    score_json: &str,
    on_progress: &mut dyn FnMut(f32, &str),
) -> Result<TabSync, String> {
    let song = find_song(song_id)?;
    if tab_file(&song)?.is_none() {
        return Err("This song has no tab yet. Import one first.".to_string());
    }
    if score_json.len() > MAX_SCORE_BYTES {
        return Err("The tab is too large to align.".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(score_json).map_err(|e| format!("The tab data is not valid: {e}"))?;
    let bars = parsed.get("bars").and_then(|b| b.as_array()).map(|b| b.len()).unwrap_or(0);
    if bars == 0 {
        return Err("The tab has no bars.".to_string());
    }
    let stems = stem_paths(&song);
    if !stems.keys().any(|k| k != "drums") {
        return Err("This song has no guitar, bass, piano or other stem to compare the tab with.".to_string());
    }

    let score_path = song_dir(&song).join(SCORE_FILE);
    write_atomic(&score_path, score_json.as_bytes(), "tab score")?;
    let out_path = song_dir(&song).join(format!("{SYNC_FILE}.new"));
    let cmd = serde_json::json!({
        "cmd": "align_tab",
        "scorePath": score_path.to_string_lossy(),
        "stemPaths": stems,
        "outputPath": out_path.to_string_lossy(),
    });
    let outcome = run_sidecar_command(state, &cmd, ALIGN_TIMEOUT, |value, stage| on_progress(value, &stage));
    if let Err(e) = remove_if_present(&score_path, "tab score") {
        log::warn!("{e}");
    }
    outcome?;
    let sync = load_result(&out_path, bars, chrono::Utc::now().to_rfc3339());
    if let Err(e) = remove_if_present(&out_path, "tab alignment") {
        log::warn!("{e}");
    }
    let sync = sync?;
    save_sync(&song, &sync)?;
    Ok(sync)
}

/// Store bar lines the user corrected. The bars must be the stored ones, in
/// order, moved only in time, and never run backwards.
pub fn save_bars(song_id: &str, bars: Vec<TabBar>) -> Result<TabSync, String> {
    let song = find_song(song_id)?;
    let mut sync = load_sync(&song)?.ok_or_else(|| "This song's tab has not been aligned yet.".to_string())?;
    if bars.len() != sync.bars.len() {
        return Err("The bar lines do not match the tab.".to_string());
    }
    let mut last = 0.0_f64;
    for (new, old) in bars.iter().zip(&sync.bars) {
        if new.index != old.index || new.occurrence != old.occurrence {
            return Err("The bar lines do not match the tab.".to_string());
        }
        if !new.time.is_finite() || new.time < 0.0 {
            return Err("A bar line has an invalid time.".to_string());
        }
        if new.time < last {
            return Err("Bar lines cannot run backwards.".to_string());
        }
        last = new.time;
    }
    sync.bars = bars.into_iter().map(|b| TabBar { time: (b.time * 1000.0).round() / 1000.0, ..b }).collect();
    sync.edited = true;
    save_sync(&song, &sync)?;
    Ok(sync)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{self, test_support::TestHome};

    fn offline_state() -> SidecarState {
        SidecarState(std::sync::Mutex::new(None))
    }

    fn spawned(state: &SidecarState) -> bool {
        state.0.lock().unwrap().is_some()
    }

    fn add_song(id: &str, stems: &[&str]) -> Song {
        let dir = storage::song_dir(id);
        let song = Song {
            id: id.to_string(),
            title: "A Song".to_string(),
            duration: 100.0,
            detected_key: None,
            detected_bpm: None,
            processed_at: "2026-01-01T00:00:00Z".to_string(),
            directory: dir.to_string_lossy().to_string(),
            stems: stems.iter().map(|s| s.to_string()).collect(),
            metronome_offset: None,
            has_chords: false,
            folder_id: None,
            sort_index: 0,
            loops: vec![],
            official_title: None,
            official_artist: None,
        };
        library::add(song.clone()).unwrap();
        song
    }

    fn write_tab(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn sample_sync() -> TabSync {
        TabSync {
            version: 1,
            algorithm: "chroma-dtw-v1".into(),
            aligned_at: "2026-01-01T00:00:00Z".into(),
            offset: 0.5,
            transpose: 0,
            used_drums: true,
            peak: 0.7,
            mean_cost: 0.3,
            steadiness: 1.0,
            quality: "good".into(),
            edited: false,
            bars: vec![
                TabBar { index: 0, occurrence: 0, time: 0.5 },
                TabBar { index: 1, occurrence: 0, time: 2.5 },
                TabBar { index: 1, occurrence: 1, time: 4.5 },
            ],
        }
    }

    #[test]
    fn a_song_without_a_tab_reads_as_none() {
        let _home = TestHome::new();
        add_song("a", &["guitar"]);
        assert!(read("a").unwrap().is_none());
    }

    #[test]
    fn import_copies_the_file_beside_the_song_and_remembers_its_name() {
        let home = TestHome::new();
        add_song("a", &["guitar"]);
        let src = write_tab(home.path(), "My Song (final).GP", b"tabdata");
        let rec = import("a", &src).unwrap();
        assert_eq!(rec.file_name, "tab.gp");
        assert_eq!(rec.original_name, "My Song (final).GP");
        assert_eq!(std::fs::read(&rec.path).unwrap(), b"tabdata");
        assert!(rec.sync.is_none());
        assert_eq!(read("a").unwrap().unwrap(), rec);
    }

    #[test]
    fn import_refuses_other_files_empty_files_and_missing_files() {
        let home = TestHome::new();
        add_song("a", &["guitar"]);
        let wav = write_tab(home.path(), "song.wav", b"x");
        assert!(import("a", &wav).unwrap_err().starts_with("Unsupported tab file"));
        let empty = write_tab(home.path(), "empty.gp", b"");
        assert_eq!(import("a", &empty).unwrap_err(), "The tab file is empty.");
        assert!(import("a", &home.path().join("gone.gp5")).unwrap_err().starts_with("Read tab file"));
        assert!(import("ghost", &wav).unwrap_err().contains("ghost"));
    }

    #[test]
    fn importing_again_replaces_the_tab_and_forgets_its_alignment() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        let first = write_tab(home.path(), "one.gp", b"one");
        import("a", &first).unwrap();
        save_sync(&song, &sample_sync()).unwrap();
        assert!(read("a").unwrap().unwrap().sync.is_some());

        let second = write_tab(home.path(), "two.gp5", b"two");
        let rec = import("a", &second).unwrap();
        assert_eq!(rec.file_name, "tab.gp5");
        assert!(rec.sync.is_none());
        assert!(!Path::new(&song.directory).join("tab.gp").exists());
    }

    #[test]
    fn an_edit_is_saved_as_gp_and_the_imported_file_is_kept_once() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp5", b"imported")).unwrap();
        save_sync(&song, &sample_sync()).unwrap();

        let rec = save_edited("a", b"edit one").unwrap();
        assert_eq!(rec.file_name, "tab.gp");
        assert!(rec.has_original);
        assert_eq!(rec.original_name, "one.gp5");
        assert_eq!(std::fs::read(&rec.path).unwrap(), b"edit one");
        assert!(!Path::new(&song.directory).join("tab.gp5").exists());
        assert!(rec.sync.is_some(), "a string move keeps the alignment");

        let rec = save_edited("a", b"edit two").unwrap();
        assert_eq!(std::fs::read(&rec.path).unwrap(), b"edit two");
        assert_eq!(std::fs::read(Path::new(&song.directory).join("tab.original.gp5")).unwrap(), b"imported");
    }

    #[test]
    fn saving_an_edit_over_a_gp_import_keeps_the_original_beside_it() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp", b"imported")).unwrap();
        save_edited("a", b"edited").unwrap();
        assert_eq!(std::fs::read(Path::new(&song.directory).join("tab.gp")).unwrap(), b"edited");
        assert_eq!(std::fs::read(Path::new(&song.directory).join("tab.original.gp")).unwrap(), b"imported");
    }

    #[test]
    fn an_edit_needs_a_tab_and_some_bytes() {
        let home = TestHome::new();
        add_song("a", &["guitar"]);
        assert_eq!(save_edited("a", b"x").unwrap_err(), "This song has no tab to edit.");
        import("a", &write_tab(home.path(), "one.gp", b"imported")).unwrap();
        assert_eq!(save_edited("a", b"").unwrap_err(), "The edited tab is empty.");
        assert!(save_edited("ghost", b"x").unwrap_err().contains("ghost"));
        assert!(!read("a").unwrap().unwrap().has_original);
    }

    #[test]
    fn reverting_restores_the_imported_file_and_its_format() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp5", b"imported")).unwrap();
        save_sync(&song, &sample_sync()).unwrap();
        save_edited("a", b"edited").unwrap();

        let rec = revert_edits("a").unwrap();
        assert_eq!(rec.file_name, "tab.gp5");
        assert!(!rec.has_original);
        assert_eq!(std::fs::read(&rec.path).unwrap(), b"imported");
        assert!(!Path::new(&song.directory).join("tab.gp").exists());
        assert!(rec.sync.is_some());
        assert_eq!(revert_edits("a").unwrap_err(), "This tab has not been edited.");
    }

    #[test]
    fn importing_or_deleting_also_clears_the_kept_original() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp5", b"imported")).unwrap();
        save_edited("a", b"edited").unwrap();
        let rec = import("a", &write_tab(home.path(), "two.gp", b"second")).unwrap();
        assert!(!rec.has_original);
        assert!(!Path::new(&song.directory).join("tab.original.gp5").exists());

        save_edited("a", b"edited again").unwrap();
        delete("a").unwrap();
        assert!(!Path::new(&song.directory).join("tab.original.gp").exists());
    }

    #[test]
    fn transposed_edits_round_trip_and_an_empty_object_removes_them() {
        let home = TestHome::new();
        let song = add_song("a", &["bass"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        assert_eq!(read_transposed("a").unwrap(), None);
        save_transposed("a", r#"{"-2":[{"bar":0}]}"#).unwrap();
        assert_eq!(read_transposed("a").unwrap().as_deref(), Some(r#"{"-2":[{"bar":0}]}"#));
        assert!(save_transposed("a", "[1]").is_err());
        assert!(save_transposed("a", "nope").is_err());
        save_transposed("a", "{}").unwrap();
        assert_eq!(read_transposed("a").unwrap(), None);
        save_transposed("a", r#"{"3":[]}"#).unwrap();
        delete("a").unwrap();
        assert!(!song_dir(&song).join(TRANSPOSED_FILE).exists());
    }

    #[test]
    fn delete_removes_the_tab_and_its_alignment_and_is_idempotent() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        save_sync(&song, &sample_sync()).unwrap();
        delete("a").unwrap();
        assert!(read("a").unwrap().is_none());
        assert!(!sync_path(&song).exists());
        delete("a").unwrap();
    }

    #[test]
    fn a_corrupt_alignment_is_an_error_not_no_alignment() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        std::fs::write(sync_path(&song), "{ not json").unwrap();
        assert!(read("a").unwrap_err().contains("Parse tab sync"));
    }

    #[test]
    fn align_without_a_tab_does_not_start_the_sidecar() {
        let _home = TestHome::new();
        add_song("a", &["guitar"]);
        let state = offline_state();
        let err = align_impl(&state, "a", "{}", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("no tab yet"));
        assert!(!spawned(&state));
    }

    #[test]
    fn align_refuses_a_song_with_nothing_to_compare_before_spawning() {
        let home = TestHome::new();
        add_song("a", &["vocals", "drums"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        let state = offline_state();
        let err = align_impl(&state, "a", r#"{"bars":[{"tick":0}]}"#, &mut |_, _| {}).unwrap_err();
        assert!(err.contains("no guitar, bass, piano or other stem"), "{err}");
        assert!(!spawned(&state));
    }

    #[test]
    fn align_refuses_unusable_score_data_before_spawning() {
        let home = TestHome::new();
        add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        let state = offline_state();
        assert!(align_impl(&state, "a", "nope", &mut |_, _| {}).unwrap_err().contains("not valid"));
        assert_eq!(align_impl(&state, "a", r#"{"bars":[]}"#, &mut |_, _| {}).unwrap_err(), "The tab has no bars.");
        assert!(!spawned(&state));
    }

    #[test]
    fn stems_sent_to_the_sidecar_are_the_ones_that_exist_on_disk() {
        let _home = TestHome::new();
        let song = add_song("a", &["guitar", "bass", "drums", "vocals"]);
        std::fs::write(Path::new(&song.directory).join("guitar.wav"), b"x").unwrap();
        std::fs::write(Path::new(&song.directory).join("vocals.wav"), b"x").unwrap();
        let paths = stem_paths(&song);
        assert_eq!(paths.keys().cloned().collect::<Vec<_>>(), vec!["guitar".to_string()]);
    }

    #[test]
    fn a_result_with_a_different_bar_count_is_rejected() {
        let home = TestHome::new();
        let path = home.path().join("r.json");
        std::fs::write(&path, serde_json::to_string(&sample_sync()).unwrap()).unwrap();
        assert!(load_result(&path, 3, "now".into()).is_ok());
        assert!(load_result(&path, 4, "now".into()).unwrap_err().contains("expected 4"));
    }

    #[test]
    fn the_sidecars_own_result_shape_is_accepted_and_stamped() {
        let home = TestHome::new();
        let path = home.path().join("r.json");
        let from_sidecar = r#"{"version":1,"algorithm":"chroma-dtw-v1","offset":0.8,"transpose":1,"usedDrums":false,
            "peak":0.7,"baseline":0.4,"meanCost":0.3,"steadiness":0.9,"quality":"good",
            "bars":[{"index":0,"occurrence":0,"time":0.8},{"index":1,"occurrence":0,"time":2.8}]}"#;
        std::fs::write(&path, from_sidecar).unwrap();
        let sync = load_result(&path, 2, "2026-02-02T00:00:00Z".into()).unwrap();
        assert_eq!(sync.aligned_at, "2026-02-02T00:00:00Z");
        assert_eq!((sync.transpose, sync.used_drums, sync.edited), (1, false, false));
    }

    #[test]
    fn saved_bar_lines_are_validated_rounded_and_marked_edited() {
        let home = TestHome::new();
        let song = add_song("a", &["guitar"]);
        import("a", &write_tab(home.path(), "one.gp", b"one")).unwrap();
        save_sync(&song, &sample_sync()).unwrap();

        let mut bars = sample_sync().bars;
        bars[1].time = 2.60049;
        let saved = save_bars("a", bars.clone()).unwrap();
        assert!(saved.edited);
        assert_eq!(saved.bars[1].time, 2.6);
        assert_eq!(read("a").unwrap().unwrap().sync.unwrap().bars[1].time, 2.6);

        let mut backwards = bars.clone();
        backwards[2].time = 1.0;
        assert_eq!(save_bars("a", backwards).unwrap_err(), "Bar lines cannot run backwards.");
        let mut bad = bars.clone();
        bad[0].time = f64::NAN;
        assert!(save_bars("a", bad).unwrap_err().contains("invalid time"));
        let mut reindexed = bars.clone();
        reindexed[2].occurrence = 5;
        assert!(save_bars("a", reindexed).unwrap_err().contains("do not match"));
        assert!(save_bars("a", bars[..2].to_vec()).unwrap_err().contains("do not match"));
    }

    #[test]
    fn saving_bar_lines_before_an_alignment_exists_is_an_error() {
        let _home = TestHome::new();
        add_song("a", &["guitar"]);
        assert!(save_bars("a", vec![]).unwrap_err().contains("not been aligned"));
    }
}
