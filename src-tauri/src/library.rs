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
    // Regions the user saved under a name, in time order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loops: Vec<NamedLoop>,
    // What the song is called in the world, kept apart from `title` (which the
    // user renames freely to tell versions apart: live, acoustic...). Online
    // lookups use these; None falls back to `title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub official_artist: Option<String>,
}

impl Song {
    /// The title and artist to look the song up under.
    pub fn lookup_identity(&self) -> (String, Option<String>) {
        fn filled(s: &Option<String>) -> Option<String> {
            s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        }
        (
            filled(&self.official_title).unwrap_or_else(|| self.title.clone()),
            filled(&self.official_artist),
        )
    }
}

/// A region of a song saved under a name, to loop with one click.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedLoop {
    pub id: String,
    pub name: String,
    pub start: f64,
    pub end: f64,
}

const MAX_LOOPS: usize = 100;
const MAX_LOOP_NAME_CHARS: usize = 80;
const MIN_LOOP_SECONDS: f64 = 0.25;

/// Trim the names, check every loop and return them in time order.
fn clean_loops(loops: Vec<NamedLoop>) -> Result<Vec<NamedLoop>, String> {
    if loops.len() > MAX_LOOPS {
        return Err(format!("Too many loops (at most {MAX_LOOPS})"));
    }
    let mut cleaned: Vec<NamedLoop> = Vec::with_capacity(loops.len());
    for mut l in loops {
        l.name = l.name.trim().to_string();
        if l.name.is_empty() || l.name.chars().count() > MAX_LOOP_NAME_CHARS {
            return Err("A loop needs a name of 1 to 80 characters".to_string());
        }
        if !l.start.is_finite() || !l.end.is_finite() || l.start < 0.0 || l.end - l.start < MIN_LOOP_SECONDS {
            return Err(format!("The region of \"{}\" must run forward and be at least a quarter of a second long", l.name));
        }
        if l.id.is_empty() || cleaned.iter().any(|c| c.id == l.id) {
            return Err("Every loop needs its own id".to_string());
        }
        cleaned.push(l);
    }
    cleaned.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    Ok(cleaned)
}

/// Replace a song's saved loops and persist them.
pub fn set_loops(song_id: &str, loops: Vec<NamedLoop>) -> Result<Song, String> {
    let cleaned = clean_loops(loops)?;
    let mut lib = load()?;
    let song = lib
        .songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.loops = cleaned;
    let updated = song.clone();
    save(&lib)?;
    Ok(updated)
}

/// A chord the audio of one segment looked like, and how well it fit (0-1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordAlternative {
    pub chord: String,
    pub fit: f64,
}

/// A single detected chord segment, read on demand from `chords.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordSegment {
    pub start: f64,
    pub end: f64,
    pub chord: String,
    /// The bass note when it is a chord tone other than the root (a slash chord).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bass: Option<String>,
    /// How well the chord's notes matched the audio (0-1), written by the detector;
    /// absent on chords from older detections and on any chord the user set by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// The other chords this stretch of audio looked most like, best first, for the editor's list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<ChordAlternative>>,
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

/// Rename a song and persist it. A song has no placeholder title to fall
/// back to, so an empty or whitespace title is rejected rather than cleared.
pub fn rename(song_id: &str, title: &str) -> Result<Song, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Song title cannot be empty".to_string());
    }
    let mut lib = load()?;
    let song = lib
        .songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    // A song nobody has given an identity yet keeps looking itself up under the
    // name it had, so renaming it to "... (acoustic)" does not change what the
    // lyrics search looks for.
    if song.official_title.is_none() {
        song.official_title = Some(song.title.clone());
    }
    song.title = trimmed.to_string();
    let updated = song.clone();
    save(&lib)?;
    Ok(updated)
}

/// Set the title and artist a song is looked up under. Blank clears the field,
/// which makes the lookup fall back to the song's own title.
pub fn set_identity(
    song_id: &str,
    official_title: Option<&str>,
    official_artist: Option<&str>,
) -> Result<Song, String> {
    let mut lib = load()?;
    let updated = set_identity_in(&mut lib.songs, song_id, official_title, official_artist)?;
    save(&lib)?;
    Ok(updated)
}

fn set_identity_in(
    songs: &mut [Song],
    song_id: &str,
    official_title: Option<&str>,
    official_artist: Option<&str>,
) -> Result<Song, String> {
    let clean = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let song = songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.official_title = clean(official_title);
    song.official_artist = clean(official_artist);
    Ok(song.clone())
}

#[derive(Deserialize)]
struct ChordsFile {
    segments: Vec<ChordSegment>,
    /// How far the recording sits from A440, in cents (positive = sharp); absent before `chords.json` v6.
    #[serde(default)]
    tuning: Option<f64>,
}

/// Record that a song now has a `chords.json`.
pub fn mark_chords_detected(song_id: &str) -> Result<Song, String> {
    let mut lib = load()?;
    let song = lib
        .songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.has_chords = true;
    let updated = song.clone();
    save(&lib)?;
    Ok(updated)
}

/// The user's corrections, kept apart from `chords.json` so detecting again never mixes with them.
const CHORD_EDITS_FILE: &str = "chords_edited.json";
const CHORD_NOTES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/// The detector writes the first five; the editor offers all of them.
const CHORD_QUALITIES: [&str; 10] = ["maj", "min", "7", "maj7", "min7", "sus2", "sus4", "dim", "aug", "6"];
const MIN_CHORD_SECONDS: f64 = 0.05;
const MAX_CHORD_SEGMENTS: usize = 5000;

fn song_directory(song_id: &str) -> Result<std::path::PathBuf, String> {
    let lib = load()?;
    let song = lib
        .songs
        .iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    Ok(std::path::PathBuf::from(&song.directory))
}

/// Read a song's chord segments: the user's corrections when there are any,
/// otherwise what was detected (`chords.json`).
pub fn read_chords(song_id: &str) -> Result<Vec<ChordSegment>, String> {
    let dir = song_directory(song_id)?;
    let edited = dir.join(CHORD_EDITS_FILE);
    if edited.exists() {
        let data = fs::read_to_string(&edited).map_err(|e| format!("Read chord edits: {e}"))?;
        let parsed: ChordsFile = serde_json::from_str(&data).map_err(|e| format!("Parse chord edits: {e}"))?;
        return Ok(parsed.segments);
    }
    let data = fs::read_to_string(dir.join("chords.json")).map_err(|e| format!("Read chords: {e}"))?;
    let parsed: ChordsFile = serde_json::from_str(&data).map_err(|e| format!("Parse chords: {e}"))?;
    Ok(parsed.segments)
}

/// How far the recording sits from A440 in cents, as measured when the chords were detected;
/// 0 for a song detected before that was kept, or one with no chords.
pub fn read_chord_tuning(song_id: &str) -> Result<f64, String> {
    let path = song_directory(song_id)?.join("chords.json");
    if !path.exists() {
        return Ok(0.0);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read chords: {e}"))?;
    let parsed: ChordsFile = serde_json::from_str(&data).map_err(|e| format!("Parse chords: {e}"))?;
    Ok(parsed.tuning.filter(|t| t.is_finite()).map_or(0.0, |t| t.clamp(-100.0, 100.0)))
}

/// Whether a song's chords carry the user's corrections.
pub fn has_chord_edits(song_id: &str) -> Result<bool, String> {
    Ok(song_directory(song_id)?.join(CHORD_EDITS_FILE).exists())
}

/// Throw the user's corrections away; the detected chords show again. Not an error when there are none.
pub fn clear_chord_edits(song_id: &str) -> Result<(), String> {
    let path = song_directory(song_id)?.join(CHORD_EDITS_FILE);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Clear chord edits: {e}")),
    }
}

/// Check a list of segments from the editor and return it sorted, rounded to the millisecond.
/// A chord is `Root:quality` with a sharp-spelled root; a segment must have a length and may not overlap the next.
const MAX_ALTERNATIVES: usize = 8;

fn is_valid_chord(chord: &str) -> bool {
    chord
        .split_once(':')
        .is_some_and(|(root, quality)| CHORD_NOTES.contains(&root) && CHORD_QUALITIES.contains(&quality))
}

pub fn clean_chord_segments(segments: Vec<ChordSegment>) -> Result<Vec<ChordSegment>, String> {
    if segments.len() > MAX_CHORD_SEGMENTS {
        return Err(format!("Too many chord segments ({})", segments.len()));
    }
    let mut cleaned = Vec::with_capacity(segments.len());
    for seg in segments {
        if !seg.start.is_finite() || !seg.end.is_finite() || seg.start < 0.0 {
            return Err("A chord segment has an invalid time".to_string());
        }
        let (start, end) = ((seg.start * 1000.0).round() / 1000.0, (seg.end * 1000.0).round() / 1000.0);
        if end - start < MIN_CHORD_SECONDS {
            return Err(format!("The chord at {start:.2} s is shorter than {MIN_CHORD_SECONDS} s"));
        }
        if !is_valid_chord(&seg.chord) {
            return Err(format!("Unknown chord: {}", seg.chord));
        }
        let bass = match seg.bass {
            Some(b) if b.is_empty() => None,
            Some(b) if CHORD_NOTES.contains(&b.as_str()) => Some(b),
            Some(b) => return Err(format!("Unknown bass note: {b}")),
            None => None,
        };
        let confidence = seg.confidence.filter(|c| c.is_finite()).map(|c| (c.clamp(0.0, 1.0) * 100.0).round() / 100.0);
        // The list is a courtesy of the detector: one entry that is not a chord is dropped, not an error.
        let alternatives = seg.alternatives.map(|alts| {
            alts.into_iter()
                .filter(|a| a.fit.is_finite() && is_valid_chord(&a.chord))
                .take(MAX_ALTERNATIVES)
                .map(|a| ChordAlternative { chord: a.chord, fit: (a.fit.clamp(0.0, 1.0) * 100.0).round() / 100.0 })
                .collect::<Vec<_>>()
        });
        cleaned.push(ChordSegment { start, end, chord: seg.chord, bass, confidence, alternatives });
    }
    cleaned.sort_by(|a, b| a.start.total_cmp(&b.start));
    for i in 1..cleaned.len() {
        let prev_end = cleaned[i - 1].end;
        // Times are whole milliseconds, so one millisecond of overlap is rounding, not an overlap.
        if cleaned[i].start < prev_end - 0.0015 {
            return Err(format!("The chords at {:.2} s overlap", cleaned[i].start));
        }
        if cleaned[i].start < prev_end {
            cleaned[i].start = prev_end;
        }
    }
    Ok(cleaned)
}

/// Save the user's corrected chord list for a song and return it as stored.
pub fn save_chord_edits(song_id: &str, segments: Vec<ChordSegment>) -> Result<Vec<ChordSegment>, String> {
    let dir = song_directory(song_id)?;
    let cleaned = clean_chord_segments(segments)?;
    let path = dir.join(CHORD_EDITS_FILE);
    let body = serde_json::json!({ "version": 1, "segments": cleaned });
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.to_string()).map_err(|e| format!("Write chord edits: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Write chord edits: {e}"))?;
    Ok(cleaned)
}

/// One transcribed bass note, as written by the sidecar's `_transcribe_bass`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BassNote {
    pub time: f64,
    pub duration: f64,
    pub pitch: i32,
    pub string: i32,
    pub fret: i32,
}

/// The contents of a song's `bass_tab.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BassTab {
    #[serde(default)]
    pub version: i32,
    pub duration: f64,
    pub notes: Vec<BassNote>,
}

/// Read a song's bass tab. `None` when the song has none: it was imported
/// before the transcription existed, or without a bass stem.
pub fn read_bass_tab(song_id: &str) -> Result<Option<BassTab>, String> {
    let lib = load()?;
    let song = lib
        .songs
        .iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    let path = std::path::Path::new(&song.directory).join("bass_tab.json");
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read bass tab: {e}"))?;
    serde_json::from_str(&data).map(Some).map_err(|e| format!("Parse bass tab: {e}"))
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
            loops: vec![],
            official_title: None,
            official_artist: None,
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
    fn lookup_identity_prefers_the_official_fields_and_falls_back() {
        let mut s = song("a", "Hallelujah (acoustic)");
        assert_eq!(s.lookup_identity(), ("Hallelujah (acoustic)".to_string(), None));
        s.official_title = Some("Hallelujah".into());
        s.official_artist = Some("Leonard Cohen".into());
        assert_eq!(s.lookup_identity(), ("Hallelujah".to_string(), Some("Leonard Cohen".to_string())));
        s.official_title = Some("   ".into());
        assert_eq!(s.lookup_identity().0, "Hallelujah (acoustic)");
    }

    #[test]
    fn renaming_an_unidentified_song_keeps_the_name_it_was_looked_up_under() {
        let _home = TestHome::new();
        add(song("a", "Hallelujah")).unwrap();
        let renamed = rename("a", "Hallelujah (live 2019)").unwrap();
        assert_eq!(renamed.title, "Hallelujah (live 2019)");
        assert_eq!(renamed.official_title.as_deref(), Some("Hallelujah"));
        assert_eq!(renamed.lookup_identity().0, "Hallelujah");
    }

    #[test]
    fn renaming_never_overwrites_an_identity_that_was_set() {
        let _home = TestHome::new();
        add(song("a", "Whatever")).unwrap();
        set_identity("a", Some("Hallelujah"), None).unwrap();
        let renamed = rename("a", "Another name").unwrap();
        assert_eq!(renamed.official_title.as_deref(), Some("Hallelujah"));
    }

    #[test]
    fn set_identity_trims_and_blank_clears() {
        let mut songs = vec![song("a", "Mine")];
        let s = set_identity_in(&mut songs, "a", Some("  Hallelujah "), Some("Leonard Cohen")).unwrap();
        assert_eq!(s.official_title.as_deref(), Some("Hallelujah"));
        assert_eq!(s.official_artist.as_deref(), Some("Leonard Cohen"));
        assert_eq!(s.title, "Mine");
        let s = set_identity_in(&mut songs, "a", Some("  "), None).unwrap();
        assert_eq!(s.official_title, None);
        assert_eq!(s.official_artist, None);
    }

    #[test]
    fn set_identity_reports_an_unknown_song() {
        let mut songs = vec![song("a", "Mine")];
        assert!(set_identity_in(&mut songs, "nope", Some("x"), None).unwrap_err().contains("Song not found"));
    }

    #[test]
    fn a_library_written_before_identities_still_loads() {
        let json = r#"{"id":"a","title":"Old","duration":1.0,"detectedKey":null,"detectedBpm":null,
            "processedAt":"x","directory":"d"}"#;
        let s: Song = serde_json::from_str(json).unwrap();
        assert_eq!(s.official_title, None);
        let out = serde_json::to_string(&s).unwrap();
        assert!(!out.contains("officialTitle"), "absent identity is not written");
    }

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

    fn named(id: &str, name: &str, start: f64, end: f64) -> NamedLoop {
        NamedLoop { id: id.to_string(), name: name.to_string(), start, end }
    }

    #[test]
    fn loops_are_trimmed_sorted_and_persisted() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let updated = set_loops("a", vec![named("l2", " Chorus ", 30.0, 40.0), named("l1", "Verse", 5.0, 15.0)]).unwrap();
        assert_eq!(updated.loops.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Verse", "Chorus"]);
        assert_eq!(load_songs().unwrap()[0].loops, updated.loops);
    }

    #[test]
    fn loops_can_be_cleared() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        set_loops("a", vec![named("l1", "Verse", 5.0, 15.0)]).unwrap();
        assert!(set_loops("a", vec![]).unwrap().loops.is_empty());
        assert!(load_songs().unwrap()[0].loops.is_empty());
    }

    #[test]
    fn bad_loops_are_rejected_and_leave_the_file_alone() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        set_loops("a", vec![named("l1", "Keep", 1.0, 5.0)]).unwrap();
        for bad in [
            vec![named("x", "  ", 1.0, 5.0)],
            vec![named("x", &"n".repeat(81), 1.0, 5.0)],
            vec![named("x", "Backwards", 9.0, 5.0)],
            vec![named("x", "Tiny", 1.0, 1.1)],
            vec![named("x", "Negative", -1.0, 5.0)],
            vec![named("x", "Nan", f64::NAN, 5.0)],
            vec![named("x", "A", 1.0, 5.0), named("x", "B", 6.0, 9.0)],
            vec![named("", "No id", 1.0, 5.0)],
        ] {
            assert!(set_loops("a", bad).is_err());
        }
        assert!(set_loops("a", (0..101).map(|i| named(&format!("l{i}"), "x", i as f64, i as f64 + 1.0)).collect()).is_err());
        assert!(set_loops("ghost", vec![]).unwrap_err().contains("ghost"));
        assert_eq!(load_songs().unwrap()[0].loops.len(), 1);
    }

    #[test]
    fn a_library_written_before_loops_existed_still_loads() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        let raw = std::fs::read_to_string(library_path()).unwrap();
        assert!(!raw.contains("loops"), "an empty loop list is not written");
        assert!(load_songs().unwrap()[0].loops.is_empty());
    }

    #[test]
    fn rename_persists_and_trims() {
        let _home = TestHome::new();
        add(song("a", "Old")).unwrap();
        let updated = rename("a", "  New  ").unwrap();
        assert_eq!(updated.title, "New");
        assert_eq!(load_songs().unwrap()[0].title, "New");
    }

    #[test]
    fn rename_rejections_leave_the_file_alone() {
        let _home = TestHome::new();
        add(song("a", "Old")).unwrap();
        assert!(rename("a", "  ").is_err());
        assert!(rename("zzz", "X").unwrap_err().contains("zzz"));
        assert_eq!(load_songs().unwrap()[0].title, "Old");
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
    fn bass_tab_is_none_until_the_file_exists_and_errors_on_a_bad_file() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();

        assert!(read_bass_tab("a").unwrap().is_none(), "older songs have no bass_tab.json");
        assert!(read_bass_tab("ghost").unwrap_err().contains("ghost"));

        fs::write(
            dir.join("bass_tab.json"),
            r#"{"version":1,"duration":9.5,"notes":[{"time":0.5,"duration":0.25,"pitch":40,"string":0,"fret":0}]}"#,
        )
        .unwrap();
        let tab = read_bass_tab("a").unwrap().unwrap();
        assert_eq!(tab.duration, 9.5);
        assert_eq!((tab.notes[0].pitch, tab.notes[0].string, tab.notes[0].fret), (40, 0, 0));

        fs::write(dir.join("bass_tab.json"), "{{").unwrap();
        assert!(read_bass_tab("a").unwrap_err().contains("Parse bass tab"));
    }

    #[test]
    fn a_slash_chords_bass_note_is_kept_and_a_plain_chord_has_none() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("chords.json"),
            r#"{"version":2,"duration":8,"segments":[{"start":0,"end":4,"chord":"C:maj","bass":"E"},{"start":4,"end":8,"chord":"G:7"}]}"#,
        )
        .unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();

        let segments = read_chords("a").unwrap();
        assert_eq!(segments[0].bass.as_deref(), Some("E"));
        assert_eq!(segments[1].bass, None);
        let json = serde_json::to_string(&segments[1]).unwrap();
        assert!(!json.contains("bass"), "{json}");
    }

    #[test]
    fn marking_chords_detected_sets_the_flag_and_persists_it() {
        let _home = TestHome::new();
        add(song("a", "A")).unwrap();
        assert!(!load_songs().unwrap()[0].has_chords);
        assert!(mark_chords_detected("a").unwrap().has_chords);
        assert!(load_songs().unwrap()[0].has_chords);
        assert!(mark_chords_detected("ghost").unwrap_err().contains("ghost"));
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

    // ── chord edits ───────────────────────────────────────────────────────

    fn seg(start: f64, end: f64, chord: &str) -> ChordSegment {
        ChordSegment { start, end, chord: chord.to_string(), bass: None, confidence: None, alternatives: None }
    }

    fn song_with_detected_chords(home: &TestHome) {
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("chords.json"),
            r#"{"version":4,"duration":8.0,"segments":[{"start":0.0,"end":4.0,"chord":"C:maj"},{"start":4.0,"end":8.0,"chord":"A:min"}]}"#,
        )
        .unwrap();
        let mut a = song("a", "A");
        a.directory = dir.to_string_lossy().to_string();
        add(a).unwrap();
    }

    #[test]
    fn the_tuning_is_read_from_chords_json_and_is_zero_when_it_was_not_kept() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        assert_eq!(read_chord_tuning("a").unwrap(), 0.0, "a v4 file has none");

        let dir = home.path().join("library").join("a");
        let doc = |tuning: &str| format!(r#"{{"version":6,"duration":8.0,"tuning":{tuning},"segments":[]}}"#);
        fs::write(dir.join("chords.json"), doc("29.0")).unwrap();
        assert_eq!(read_chord_tuning("a").unwrap(), 29.0);
        fs::write(dir.join("chords.json"), doc("-640.0")).unwrap();
        assert_eq!(read_chord_tuning("a").unwrap(), -100.0, "clamped: it is cents off pitch, not a transposition");
        fs::remove_file(dir.join("chords.json")).unwrap();
        assert_eq!(read_chord_tuning("a").unwrap(), 0.0, "no chords is not an error");
    }

    #[test]
    fn edits_replace_the_detected_chords_until_they_are_cleared() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        assert!(!has_chord_edits("a").unwrap());

        let saved = save_chord_edits("a", vec![seg(0.0, 2.0, "G:maj"), seg(2.0, 8.0, "D:7")]).unwrap();
        assert_eq!(saved.len(), 2);
        assert!(has_chord_edits("a").unwrap());
        let read = read_chords("a").unwrap();
        assert_eq!(read.iter().map(|s| s.chord.as_str()).collect::<Vec<_>>(), ["G:maj", "D:7"]);

        clear_chord_edits("a").unwrap();
        assert!(!has_chord_edits("a").unwrap());
        assert_eq!(read_chords("a").unwrap()[0].chord, "C:maj", "the detected chords were never touched");
        clear_chord_edits("a").unwrap();
    }

    #[test]
    fn saving_edits_keeps_a_slash_bass_and_drops_an_empty_one() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        let mut with_bass = seg(0.0, 2.0, "C:maj");
        with_bass.bass = Some("E".to_string());
        let mut empty_bass = seg(2.0, 4.0, "A:min");
        empty_bass.bass = Some(String::new());
        let saved = save_chord_edits("a", vec![with_bass, empty_bass]).unwrap();
        assert_eq!(saved[0].bass.as_deref(), Some("E"));
        assert_eq!(saved[1].bass, None);
    }

    #[test]
    fn cleaning_sorts_rounds_and_joins_hairline_gaps() {
        let cleaned = clean_chord_segments(vec![seg(4.0004, 8.0, "A:min"), seg(0.0, 4.0, "C:maj")]).unwrap();
        assert_eq!((cleaned[0].start, cleaned[0].end), (0.0, 4.0));
        assert_eq!((cleaned[1].start, cleaned[1].end), (4.0, 8.0));
        let overlapping_by_a_hair = clean_chord_segments(vec![seg(0.0, 4.0007, "C:maj"), seg(4.0, 8.0, "A:min")]).unwrap();
        assert_eq!(overlapping_by_a_hair[1].start, 4.001, "the start moves to the previous end, never earlier");
    }

    #[test]
    fn cleaning_keeps_a_confidence_in_range_and_drops_one_that_is_not_a_number() {
        let with = |confidence: Option<f64>| ChordSegment { confidence, ..seg(0.0, 4.0, "C:maj") };
        let cleaned = |c| clean_chord_segments(vec![with(c)]).unwrap()[0].confidence;
        assert_eq!(cleaned(Some(0.734)), Some(0.73));
        assert_eq!(cleaned(Some(1.7)), Some(1.0));
        assert_eq!(cleaned(Some(-0.2)), Some(0.0));
        assert_eq!(cleaned(Some(f64::NAN)), None);
        assert_eq!(cleaned(None), None);
    }

    #[test]
    fn cleaning_keeps_good_alternatives_and_drops_the_ones_that_are_not_chords() {
        let alt = |chord: &str, fit: f64| ChordAlternative { chord: chord.to_string(), fit };
        let with = ChordSegment {
            alternatives: Some(vec![alt("A:min", 0.8123), alt("H:maj", 0.7), alt("E:min7", 1.4), alt("G:maj", f64::NAN)]),
            ..seg(0.0, 4.0, "C:maj")
        };
        let cleaned = clean_chord_segments(vec![with]).unwrap();
        assert_eq!(cleaned[0].alternatives, Some(vec![alt("A:min", 0.81), alt("E:min7", 1.0)]));
    }

    #[test]
    fn cleaning_rejects_what_the_player_could_not_show() {
        let err = |segs: Vec<ChordSegment>| clean_chord_segments(segs).unwrap_err();
        assert!(err(vec![seg(0.0, 4.0, "C:maj"), seg(3.0, 6.0, "G:maj")]).contains("overlap"));
        assert!(err(vec![seg(2.0, 2.0, "C:maj")]).contains("shorter"));
        assert!(err(vec![seg(3.0, 2.0, "C:maj")]).contains("shorter"));
        assert!(err(vec![seg(-1.0, 2.0, "C:maj")]).contains("invalid time"));
        assert!(err(vec![seg(f64::NAN, 2.0, "C:maj")]).contains("invalid time"));
        assert!(err(vec![seg(0.0, f64::INFINITY, "C:maj")]).contains("invalid time"));
        assert!(err(vec![seg(0.0, 2.0, "H:maj")]).contains("Unknown chord"));
        assert!(err(vec![seg(0.0, 2.0, "C:wild")]).contains("Unknown chord"));
        assert!(err(vec![seg(0.0, 2.0, "Cmaj")]).contains("Unknown chord"));
        let mut bad_bass = seg(0.0, 2.0, "C:maj");
        bad_bass.bass = Some("Bb".to_string());
        assert!(err(vec![bad_bass]).contains("Unknown bass note"));
        assert!(err((0..5001).map(|i| seg(i as f64, i as f64 + 0.5, "C:maj")).collect()).contains("Too many"));
    }

    #[test]
    fn an_empty_list_is_a_valid_edit() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        assert!(save_chord_edits("a", vec![]).unwrap().is_empty());
        assert!(read_chords("a").unwrap().is_empty());
    }

    #[test]
    fn a_rejected_edit_leaves_the_stored_one_alone() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        save_chord_edits("a", vec![seg(0.0, 8.0, "E:min")]).unwrap();
        assert!(save_chord_edits("a", vec![seg(0.0, 4.0, "Q:maj")]).is_err());
        assert_eq!(read_chords("a").unwrap()[0].chord, "E:min");
    }

    #[test]
    fn edit_commands_name_the_song_that_is_missing() {
        let _home = TestHome::new();
        assert!(save_chord_edits("ghost", vec![]).unwrap_err().contains("ghost"));
        assert!(has_chord_edits("ghost").unwrap_err().contains("ghost"));
        assert!(clear_chord_edits("ghost").unwrap_err().contains("ghost"));
    }

    #[test]
    fn a_corrupt_edits_file_is_an_error_not_a_silent_fallback() {
        let home = TestHome::new();
        song_with_detected_chords(&home);
        let dir = home.path().join("library").join("a");
        fs::write(dir.join("chords_edited.json"), "{{").unwrap();
        assert!(read_chords("a").unwrap_err().contains("Parse chord edits"));
        clear_chord_edits("a").unwrap();
        assert_eq!(read_chords("a").unwrap()[0].chord, "C:maj");
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
