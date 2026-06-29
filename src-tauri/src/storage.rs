use std::fs;
use std::path::PathBuf;

/// Root data directory: ~/.songanalyzer/
pub fn app_data_dir() -> PathBuf {
    let base = dirs::home_dir().expect("could not determine home directory");
    let dir = base.join(".songanalyzer");
    fs::create_dir_all(&dir).expect("could not create app data dir");
    dir
}

/// Library directory: ~/.songanalyzer/library/
pub fn library_dir() -> PathBuf {
    let dir = app_data_dir().join("library");
    fs::create_dir_all(&dir).expect("could not create library dir");
    dir
}

/// Per-song directory: ~/.songanalyzer/library/{song_id}/
pub fn song_dir(song_id: &str) -> PathBuf {
    let dir = library_dir().join(song_id);
    fs::create_dir_all(&dir).expect("could not create song dir");
    dir
}
