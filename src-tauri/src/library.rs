use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;

/// Song metadata persisted in library.json.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub duration: f64,
    pub detected_key: Option<String>,
    pub detected_bpm: Option<f64>,
    pub processed_at: String,
    pub directory: String,
    #[serde(default)]
    pub stems: Vec<String>,
    // Song time (s) where the metronome's beat 1 lands — lets the user align
    // the click track to the song's actual downbeat when there's silence (or
    // a pickup) before it, instead of always starting at song position 0.
    #[serde(default)]
    pub metronome_offset: Option<f64>,
    #[serde(default)]
    pub has_chords: bool,
    // None = root/uncategorized. Absent from pre-folders library.json files,
    // so every existing song deserializes into the root list.
    #[serde(default)]
    pub folder_id: Option<String>,
    // Rank among sibling songs sharing the same folder_id. Ties (e.g. every
    // song migrated from a pre-folders library.json, which all default to 0)
    // fall back to array order via a stable sort, so migration never
    // reshuffles an existing library.
    #[serde(default)]
    pub sort_index: i32,
}

/// A single detected chord segment, read on demand from `chords.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordSegment {
    pub start: f64,
    pub end: f64,
    pub chord: String,
}

/// A user-named, flat (non-nested) grouping of songs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub sort_index: i32,
}

/// On-disk shape of library.json. Replaces the old bare `Vec<Song>` format;
/// `load()` falls back to parsing that legacy shape when this fails.
#[derive(Serialize, Deserialize, Default)]
struct LibraryFile {
    #[serde(default)]
    folders: Vec<Folder>,
    #[serde(default)]
    songs: Vec<Song>,
}

fn library_path() -> std::path::PathBuf {
    storage::app_data_dir().join("library.json")
}

/// Load the full library (folders + songs) from library.json, transparently
/// upgrading a legacy bare-array file (pre-folders) in memory. The upgraded
/// shape is only actually written back on the next `save()` — reads alone
/// never touch disk.
fn load() -> Result<LibraryFile, String> {
    let path = library_path();
    if !path.exists() {
        return Ok(LibraryFile::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read library: {e}"))?;
    if let Ok(file) = serde_json::from_str::<LibraryFile>(&data) {
        return Ok(file);
    }
    let songs: Vec<Song> =
        serde_json::from_str(&data).map_err(|e| format!("Parse library: {e}"))?;
    Ok(LibraryFile {
        folders: vec![],
        songs,
    })
}

/// Save the full library (folders + songs) to library.json.
fn save(lib: &LibraryFile) -> Result<(), String> {
    let path = library_path();
    let data = serde_json::to_string_pretty(lib).map_err(|e| format!("Serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Write library: {e}"))
}

/// Load all songs from library.json, in stored order.
pub fn load_songs() -> Result<Vec<Song>, String> {
    Ok(load()?.songs)
}

/// Load all folders from library.json, in stored order.
pub fn load_folders() -> Result<Vec<Folder>, String> {
    Ok(load()?.folders)
}

/// Add a song to the library, appended to the end of the root (no folder) list.
pub fn add(mut song: Song) -> Result<(), String> {
    let mut lib = load()?;
    let next_index = lib
        .songs
        .iter()
        .filter(|s| s.folder_id.is_none())
        .map(|s| s.sort_index)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    song.folder_id = None;
    song.sort_index = next_index;
    lib.songs.push(song);
    save(&lib)
}

/// Update a song's metronome downbeat offset and persist it.
pub fn update_metronome_offset(song_id: &str, offset: Option<f64>) -> Result<Song, String> {
    let mut lib = load()?;
    let song = lib
        .songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.metronome_offset = offset;
    let updated = song.clone();
    save(&lib)?;
    Ok(updated)
}

#[derive(Deserialize)]
struct ChordsFile {
    segments: Vec<ChordSegment>,
}

/// Read the detected chord segments for a song from its `chords.json`.
pub fn read_chords(song_id: &str) -> Result<Vec<ChordSegment>, String> {
    let lib = load()?;
    let song = lib
        .songs
        .iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    let path = std::path::Path::new(&song.directory).join("chords.json");
    let data = fs::read_to_string(&path).map_err(|e| format!("Read chords: {e}"))?;
    let parsed: ChordsFile = serde_json::from_str(&data).map_err(|e| format!("Parse chords: {e}"))?;
    Ok(parsed.segments)
}

/// Create a folder and persist it, appended to the end of the folder list.
pub fn create_folder(name: &str) -> Result<Folder, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    let mut lib = load()?;
    let next_index = lib
        .folders
        .iter()
        .map(|f| f.sort_index)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let folder = Folder {
        id: uuid::Uuid::new_v4().to_string(),
        name: trimmed.to_string(),
        sort_index: next_index,
    };
    lib.folders.push(folder.clone());
    save(&lib)?;
    Ok(folder)
}

/// Find `folder_id` in `folders` and set its name to the trimmed `name`.
/// Pulled out of `rename_folder` so the find/trim/mutate logic is
/// unit-testable without touching the real library.json on disk.
fn rename_folder_in(folders: &mut [Folder], folder_id: &str, name: &str) -> Result<Folder, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    let folder = folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| format!("Folder not found: {folder_id}"))?;
    folder.name = trimmed.to_string();
    Ok(folder.clone())
}

/// Rename a folder and persist it. Empty/whitespace name is rejected.
pub fn rename_folder(folder_id: &str, name: &str) -> Result<Folder, String> {
    let mut lib = load()?;
    let updated = rename_folder_in(&mut lib.folders, folder_id, name)?;
    save(&lib)?;
    Ok(updated)
}

/// Delete a folder and persist it. Songs that belonged to it move back to
/// the root list (folder_id cleared) rather than being deleted — a folder
/// is just a view over songs, not a container they can be lost in.
pub fn delete_folder(folder_id: &str) -> Result<(), String> {
    let mut lib = load()?;
    lib.folders.retain(|f| f.id != folder_id);
    for song in lib.songs.iter_mut() {
        if song.folder_id.as_deref() == Some(folder_id) {
            song.folder_id = None;
        }
    }
    save(&lib)
}

/// Reassign folder sort_index 0..N in the given order and persist.
pub fn reorder_folders(ordered_ids: &[String]) -> Result<Vec<Folder>, String> {
    let mut lib = load()?;
    for (i, id) in ordered_ids.iter().enumerate() {
        if let Some(folder) = lib.folders.iter_mut().find(|f| &f.id == id) {
            folder.sort_index = i as i32;
        }
    }
    save(&lib)?;
    Ok(lib.folders)
}

/// Move the given songs into `folder_id` (None = root) and reassign their
/// sort_index 0..N in the given order. Covers both a same-folder reorder and
/// a cross-folder drag-drop-at-position in one call, since a drag-and-drop
/// UI naturally yields "the final ordered id list of the destination
/// container" for either case. Returns the updated songs so the caller can
/// patch its in-memory list without a full refetch.
pub fn move_songs(
    folder_id: Option<String>,
    ordered_song_ids: &[String],
) -> Result<Vec<Song>, String> {
    let mut lib = load()?;
    for (i, id) in ordered_song_ids.iter().enumerate() {
        if let Some(song) = lib.songs.iter_mut().find(|s| &s.id == id) {
            song.folder_id = folder_id.clone();
            song.sort_index = i as i32;
        }
    }
    save(&lib)?;
    let updated = lib
        .songs
        .into_iter()
        .filter(|s| ordered_song_ids.contains(&s.id))
        .collect();
    Ok(updated)
}

/// Remove a song from the library and delete its directory.
pub fn remove(song_id: &str) -> Result<(), String> {
    let mut lib = load()?;
    let to_remove = lib.songs.iter().find(|s| s.id == song_id);
    if let Some(song) = to_remove {
        let dir = std::path::Path::new(&song.directory);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("Delete dir: {e}"))?;
        }
    }
    lib.songs.retain(|s| s.id != song_id);
    save(&lib)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;

    fn song(id: &str, title: &str) -> Song {
        Song {
            id: id.to_string(),
            title: title.to_string(),
            duration: 0.0,
            detected_key: None,
            detected_bpm: None,
            processed_at: String::new(),
            directory: String::new(),
            stems: vec![],
            metronome_offset: None,
            has_chords: false,
            folder_id: None,
            sort_index: 0,
        }
    }

    fn folder(id: &str, name: &str) -> Folder {
        Folder {
            id: id.to_string(),
            name: name.to_string(),
            sort_index: 0,
        }
    }

    fn ids(songs: &[Song]) -> Vec<&str> {
        songs.iter().map(|s| s.id.as_str()).collect()
    }

    fn by_id<'a>(songs: &'a [Song], id: &str) -> &'a Song {
        songs.iter().find(|s| s.id == id).unwrap()
    }

    // ── pure helpers ──────────────────────────────────────────────────────

    #[test]
    fn renames_matching_folder_and_trims_whitespace() {
        let mut folders = vec![folder("f1", "Old Name"), folder("f2", "Other Folder")];
        let updated = rename_folder_in(&mut folders, "f1", "  New Name  ").unwrap();
        assert_eq!(updated.name, "New Name");
        assert_eq!(folders[0].name, "New Name");
        assert_eq!(folders[1].name, "Other Folder");
    }

    #[test]
    fn rejects_empty_or_whitespace_folder_name() {
        let mut folders = vec![folder("f1", "Old Name")];
        assert!(rename_folder_in(&mut folders, "f1", "   ").is_err());
        assert_eq!(folders[0].name, "Old Name");
    }

    #[test]
    fn errors_on_unknown_folder_id() {
        let mut folders = vec![folder("f1", "Old Name")];
        let err = rename_folder_in(&mut folders, "missing-id", "New Name").unwrap_err();
        assert!(err.contains("missing-id"));
    }

    // ── serialization contract with the frontend ──────────────────────────

    #[test]
    fn song_serializes_with_camel_case_keys() {
        let mut s = song("a", "T");
        s.detected_key = Some("C minor".into());
        s.detected_bpm = Some(120.0);
        s.metronome_offset = Some(1.5);
        s.folder_id = Some("f1".into());
        s.sort_index = 3;
        s.has_chords = true;
        s.stems = vec!["vocals".into(), "bass".into()];
        let v = serde_json::to_value(&s).unwrap();
        for key in [
            "id", "title", "duration", "detectedKey", "detectedBpm", "processedAt", "directory", "stems",
            "metronomeOffset", "hasChords", "folderId", "sortIndex",
        ] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        assert_eq!(v["sortIndex"], 3);
        assert_eq!(v["stems"], serde_json::json!(["vocals", "bass"]));
        assert!(v.get("detected_key").is_none());
    }

    #[test]
    fn song_from_an_old_library_gets_defaults() {
        let old = r#"{"id":"a","title":"T","duration":10.0,"detectedKey":null,"detectedBpm":null,
                      "processedAt":"2025-01-01","directory":"/x"}"#;
        let s: Song = serde_json::from_str(old).unwrap();
        assert!(s.stems.is_empty());
        assert!(!s.has_chords);
        assert_eq!(s.metronome_offset, None);
        assert_eq!(s.folder_id, None);
        assert_eq!(s.sort_index, 0);
    }

    #[test]
    fn folder_and_chord_segment_use_camel_case_too() {
        let f = serde_json::to_value(folder("f", "N")).unwrap();
        assert!(f.get("sortIndex").is_some() && f.get("sort_index").is_none());
        let c: ChordSegment = serde_json::from_str(r#"{"start":1.0,"end":2.5,"chord":"A:min"}"#).unwrap();
        assert_eq!((c.start, c.end, c.chord.as_str()), (1.0, 2.5, "A:min"));
    }

    // ── load / save ───────────────────────────────────────────────────────

    #[test]
    fn an_empty_home_has_no_songs_or_folders() {
        let _home = TestHome::new();
        assert!(load_songs().unwrap().is_empty());
        assert!(load_folders().unwrap().is_empty());
    }

    #[test]
    fn a_legacy_bare_array_library_is_read_without_being_rewritten() {
        let home = TestHome::new();
        let legacy = r#"[{"id":"a","title":"A","duration":1.0,"processedAt":"x","directory":"/a"},
                         {"id":"b","title":"B","duration":2.0,"processedAt":"x","directory":"/b"}]"#;
        let path = home.path().join("library.json");
        fs::write(&path, legacy).unwrap();

        let songs = load_songs().unwrap();
        assert_eq!(ids(&songs), ["a", "b"]);
        assert!(load_folders().unwrap().is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), legacy, "a read must not touch the file");
    }

    #[test]
    fn the_first_write_upgrades_a_legacy_library_in_place() {
        let home = TestHome::new();
        fs::write(
            home.path().join("library.json"),
            r#"[{"id":"a","title":"A","duration":1.0,"processedAt":"x","directory":"/a"}]"#,
        )
        .unwrap();
        add(song("b", "B")).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home.path().join("library.json")).unwrap()).unwrap();
        assert!(raw.is_object());
        assert_eq!(raw["songs"].as_array().unwrap().len(), 2);
        assert!(raw["folders"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_library_is_an_error_not_an_empty_list() {
        let home = TestHome::new();
        fs::write(home.path().join("library.json"), "{ not json").unwrap();
        assert!(load_songs().unwrap_err().contains("Parse library"));
        assert!(add(song("a", "A")).is_err());
        assert_eq!(
            fs::read_to_string(home.path().join("library.json")).unwrap(),
            "{ not json",
            "must not overwrite what it could not read"
        );
    }

    #[test]
    fn a_library_object_missing_a_section_still_loads() {
        let home = TestHome::new();
        fs::write(home.path().join("library.json"), r#"{"folders":[{"id":"f","name":"F","sortIndex":0}]}"#).unwrap();
        assert!(load_songs().unwrap().is_empty());
        assert_eq!(load_folders().unwrap().len(), 1);
    }

    // ── add ───────────────────────────────────────────────────────────────

    #[test]
    fn add_appends_to_the_root_with_increasing_sort_index() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        add(song("b", "B")).unwrap();
        add(song("c", "C")).unwrap();
        let songs = load_songs().unwrap();
        assert_eq!(ids(&songs), ["a", "b", "c"]);
        assert_eq!(songs.iter().map(|s| s.sort_index).collect::<Vec<_>>(), [0, 1, 2]);
    }

    #[test]
    fn add_ignores_a_folder_or_index_on_the_incoming_song() {
        let _home = TestHome::new();
        let mut s = song("a", "A");
        s.folder_id = Some("ghost".into());
        s.sort_index = 99;
        add(s).unwrap();
        let songs = load_songs().unwrap();
        assert_eq!(songs[0].folder_id, None);
        assert_eq!(songs[0].sort_index, 0);
    }

    #[test]
    fn add_numbers_among_root_songs_only() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let f = create_folder("F").unwrap();
        move_songs(Some(f.id), &["a".to_string()]).unwrap();
        add(song("b", "B")).unwrap();
        assert_eq!(by_id(&load_songs().unwrap(), "b").sort_index, 0);
    }

    // ── metronome offset ──────────────────────────────────────────────────

    #[test]
    fn metronome_offset_can_be_set_and_cleared() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let set = update_metronome_offset("a", Some(2.25)).unwrap();
        assert_eq!(set.metronome_offset, Some(2.25));
        assert_eq!(load_songs().unwrap()[0].metronome_offset, Some(2.25));
        let cleared = update_metronome_offset("a", None).unwrap();
        assert_eq!(cleared.metronome_offset, None);
        assert_eq!(load_songs().unwrap()[0].metronome_offset, None);
    }

    #[test]
    fn metronome_offset_on_an_unknown_song_fails() {
        let _home = TestHome::new();
        assert!(update_metronome_offset("nope", Some(1.0)).unwrap_err().contains("nope"));
    }

    // ── chords ────────────────────────────────────────────────────────────

    #[test]
    fn chords_are_read_from_the_songs_own_directory() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("chords.json"),
            r#"{"version":1,"duration":8.0,"segments":[{"start":0.0,"end":4.0,"chord":"C:maj"},{"start":4.0,"end":8.0,"chord":"A:min"}]}"#,
        )
        .unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();

        let segments = read_chords("a").unwrap();
        assert_eq!(segments.iter().map(|s| s.chord.as_str()).collect::<Vec<_>>(), ["C:maj", "A:min"]);
        assert_eq!(segments[1].start, 4.0);
    }

    #[test]
    fn chords_errors_name_the_problem() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();

        assert!(read_chords("ghost").unwrap_err().contains("ghost"));
        assert!(read_chords("a").unwrap_err().contains("Read chords"), "no chords.json yet");
        fs::write(dir.join("chords.json"), "{{").unwrap();
        assert!(read_chords("a").unwrap_err().contains("Parse chords"));
    }

    // ── folders ───────────────────────────────────────────────────────────

    #[test]
    fn create_folder_trims_numbers_sequentially_and_gives_unique_ids() {
        let _home = TestHome::new();
        let a = create_folder("  Queen ").unwrap();
        let b = create_folder("Muse").unwrap();
        assert_eq!(a.name, "Queen");
        assert_eq!((a.sort_index, b.sort_index), (0, 1));
        assert_ne!(a.id, b.id);
        assert_eq!(load_folders().unwrap().len(), 2);
    }

    #[test]
    fn create_folder_rejects_blank_names_without_writing() {
        let home = TestHome::new();
        assert!(create_folder("   ").is_err());
        assert!(create_folder("").is_err());
        assert!(!home.path().join("library.json").exists());
    }

    #[test]
    fn rename_folder_persists() {
        let _home = TestHome::new();
        let f = create_folder("Old").unwrap();
        assert_eq!(rename_folder(&f.id, " New ").unwrap().name, "New");
        assert_eq!(load_folders().unwrap()[0].name, "New");
        assert!(rename_folder(&f.id, " ").is_err());
        assert!(rename_folder("ghost", "x").is_err());
    }

    #[test]
    fn delete_folder_returns_its_songs_to_the_root_without_deleting_them() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        add(song("b", "B")).unwrap();
        let f = create_folder("Band").unwrap();
        let other = create_folder("Other").unwrap();
        move_songs(Some(f.id.clone()), &["a".to_string()]).unwrap();
        move_songs(Some(other.id.clone()), &["b".to_string()]).unwrap();

        delete_folder(&f.id).unwrap();

        let songs = load_songs().unwrap();
        assert_eq!(songs.len(), 2);
        assert_eq!(by_id(&songs, "a").folder_id, None);
        assert_eq!(by_id(&songs, "b").folder_id.as_deref(), Some(other.id.as_str()));
        assert_eq!(load_folders().unwrap().len(), 1);
    }

    #[test]
    fn delete_folder_with_an_unknown_id_is_a_noop() {
        let _home = TestHome::new();
        create_folder("Keep").unwrap();
        delete_folder("ghost").unwrap();
        assert_eq!(load_folders().unwrap().len(), 1);
    }

    #[test]
    fn reorder_folders_assigns_the_list_position_and_skips_unknown_ids() {
        let _home = TestHome::new();
        let a = create_folder("A").unwrap();
        let b = create_folder("B").unwrap();
        let c = create_folder("C").unwrap();
        let out = reorder_folders(&[c.id.clone(), "ghost".to_string(), a.id.clone(), b.id.clone()]).unwrap();
        let idx = |id: &str| out.iter().find(|f| f.id == id).unwrap().sort_index;
        assert_eq!(idx(&c.id), 0);
        assert_eq!(idx(&a.id), 2, "position in the list, counting the unknown id");
        assert_eq!(idx(&b.id), 3);
        let stored = load_folders().unwrap();
        assert_eq!(stored.iter().find(|f| f.id == c.id).unwrap().sort_index, 0);
    }

    // ── move_songs ────────────────────────────────────────────────────────

    #[test]
    fn move_songs_into_a_folder_sets_membership_and_order() {
        let _home = TestHome::new();
        for id in ["a", "b", "c"] {
            add(song(id, id)).unwrap();
        }
        let f = create_folder("F").unwrap();
        let moved = move_songs(Some(f.id.clone()), &["c".to_string(), "a".to_string()]).unwrap();

        assert_eq!(moved.len(), 2);
        let stored = load_songs().unwrap();
        assert_eq!(by_id(&stored, "c").folder_id.as_deref(), Some(f.id.as_str()));
        assert_eq!(by_id(&stored, "c").sort_index, 0);
        assert_eq!(by_id(&stored, "a").sort_index, 1);
        assert_eq!(by_id(&stored, "b").folder_id, None, "untouched");
    }

    #[test]
    fn move_songs_back_to_the_root() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let f = create_folder("F").unwrap();
        move_songs(Some(f.id), &["a".to_string()]).unwrap();
        move_songs(None, &["a".to_string()]).unwrap();
        assert_eq!(load_songs().unwrap()[0].folder_id, None);
    }

    #[test]
    fn move_songs_within_one_folder_is_a_reorder() {
        let _home = TestHome::new();
        for id in ["a", "b", "c"] {
            add(song(id, id)).unwrap();
        }
        move_songs(None, &["c".to_string(), "b".to_string(), "a".to_string()]).unwrap();
        let stored = load_songs().unwrap();
        let mut order: Vec<_> = stored.iter().map(|s| (s.sort_index, s.id.as_str())).collect();
        order.sort();
        assert_eq!(order.iter().map(|(_, id)| *id).collect::<Vec<_>>(), ["c", "b", "a"]);
    }

    #[test]
    fn move_songs_ignores_unknown_ids_and_returns_only_real_songs() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let moved = move_songs(None, &["ghost".to_string(), "a".to_string()]).unwrap();
        assert_eq!(ids(&moved), ["a"]);
        assert_eq!(moved[0].sort_index, 1, "index is the position in the requested order");
    }

    // ── remove ────────────────────────────────────────────────────────────

    #[test]
    fn remove_deletes_the_entry_and_its_directory() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vocals.wav"), b"x").unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();
        add(song("b", "B")).unwrap();

        remove("a").unwrap();

        assert!(!dir.exists());
        assert_eq!(ids(&load_songs().unwrap()), ["b"]);
    }

    #[test]
    fn remove_tolerates_a_missing_directory_and_an_unknown_id() {
        let _home = TestHome::new();
        let mut a = song("a", "A");
        a.directory = "/definitely/not/here".to_string();
        add(a).unwrap();
        remove("a").unwrap();
        remove("never-existed").unwrap();
        assert!(load_songs().unwrap().is_empty());
    }
}
