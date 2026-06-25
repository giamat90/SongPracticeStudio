use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;

/// Song metadata persisted in library.json.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration: f64,
    pub detected_key: Option<String>,
    pub detected_bpm: Option<f64>,
    pub processed_at: String,
    pub directory: String,
}

fn library_path() -> std::path::PathBuf {
    storage::app_data_dir().join("library.json")
}

/// Load all songs from library.json.
pub fn load() -> Result<Vec<Song>, String> {
    let path = library_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read library: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse library: {e}"))
}

/// Save songs to library.json.
fn save(songs: &[Song]) -> Result<(), String> {
    let path = library_path();
    let data = serde_json::to_string_pretty(songs).map_err(|e| format!("Serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Write library: {e}"))
}

/// Add a song to the library.
pub fn add(song: Song) -> Result<(), String> {
    let mut songs = load()?;
    songs.push(song);
    save(&songs)
}

/// Remove a song from the library and delete its directory.
pub fn remove(song_id: &str) -> Result<(), String> {
    let songs = load()?;
    let to_remove = songs.iter().find(|s| s.id == song_id);
    if let Some(song) = to_remove {
        let dir = std::path::Path::new(&song.directory);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("Delete dir: {e}"))?;
        }
    }
    let filtered: Vec<Song> = songs.into_iter().filter(|s| s.id != song_id).collect();
    save(&filtered)
}
