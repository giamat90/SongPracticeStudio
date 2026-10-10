//! Synced lyrics: persistence of `{song}/lyrics.json` and the sidecar round trip
//! that produces it. The Tauri command wrappers live in `commands.rs`.

use crate::commands::{run_sidecar_command, SidecarState};
use crate::library::{self, Song};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const FORMAT_VERSION: u32 = 1;
const LYRICS_FILE: &str = "lyrics.json";
const VOCALS_STEM: &str = "vocals";
/// Per message, not in total: the sidecar reports progress while it downloads
/// the model (first use only) and while it listens to the vocals.
const SYNC_TIMEOUT: Duration = Duration::from_secs(600);
const FIND_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub words: Vec<LyricWord>,
}

/// A song's lyrics with the time of every line and word on the vocals stem.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    #[serde(default = "format_version")]
    pub version: u32,
    /// "paste" (typed or pasted by the user) or "lrclib" (fetched).
    #[serde(default = "default_source")]
    pub source: String,
    /// The text exactly as the user supplied it, so it can be edited and re-synced.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub aligner: String,
    #[serde(default)]
    pub aligned_at: String,
    #[serde(default)]
    pub mean_score: f64,
    /// Set when the sidecar doubts the text fits the recording.
    #[serde(default)]
    pub warning: Option<String>,
    pub lines: Vec<LyricLine>,
}

fn format_version() -> u32 {
    FORMAT_VERSION
}

fn default_source() -> String {
    "paste".to_string()
}

/// A candidate found online, shown for review before it is synced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundLyrics {
    pub text: String,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub source: String,
}

fn find_song(song_id: &str) -> Result<Song, String> {
    library::load_songs()?
        .into_iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))
}

fn lyrics_path(song: &Song) -> PathBuf {
    std::path::Path::new(&song.directory).join(LYRICS_FILE)
}

/// `Ok(None)` when the song has no lyrics yet; an unreadable file is an error
/// rather than "no lyrics", so a corrupt file is never silently overwritten.
pub fn load(song_id: &str) -> Result<Option<Lyrics>, String> {
    let path = lyrics_path(&find_song(song_id)?);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read lyrics: {e}"))?;
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Parse lyrics: {e}"))
}

/// Written beside the target and renamed into place, so a crash mid-write can
/// never leave a half-written (unparseable) lyrics.json behind. A song deleted
/// while its lyrics were syncing has no directory to write into, and the
/// directory is deliberately not recreated.
fn save(song: &Song, lyrics: &Lyrics) -> Result<(), String> {
    let path = lyrics_path(song);
    if !path.parent().is_some_and(|dir| dir.is_dir()) {
        return Err("The song was removed while its lyrics were syncing.".to_string());
    }
    let json = serde_json::to_string_pretty(lyrics).map_err(|e| format!("Serialize lyrics: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Write lyrics: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Write lyrics: {e}"))
}

pub fn delete(song_id: &str) -> Result<(), String> {
    match std::fs::remove_file(lyrics_path(&find_song(song_id)?)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete lyrics: {e}")),
    }
}

/// Build the stored record from the sidecar's `align_lyrics` result.
pub fn from_alignment(source: &str, text: &str, data: &serde_json::Value, aligned_at: String) -> Result<Lyrics, String> {
    let lines: Vec<LyricLine> = serde_json::from_value(data.get("lines").cloned().unwrap_or_default())
        .map_err(|e| format!("The sidecar returned malformed lyrics: {e}"))?;
    if lines.is_empty() {
        return Err("The sidecar returned no lyric lines".to_string());
    }
    Ok(Lyrics {
        version: FORMAT_VERSION,
        source: source.to_string(),
        text: text.to_string(),
        aligner: data.get("aligner").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        aligned_at,
        mean_score: data.get("meanScore").and_then(|v| v.as_f64()).unwrap_or(0.0),
        warning: data.get("warning").and_then(|v| v.as_str()).map(|s| s.to_string()),
        lines,
    })
}

/// The song's vocals stem. A song imported without the vocals stem has nothing
/// to align the text to.
fn vocals_path(song: &Song) -> Result<PathBuf, String> {
    if !song.stems.iter().any(|s| s == VOCALS_STEM) {
        return Err("Lyrics sync needs the vocals stem; this song was imported without it.".to_string());
    }
    let path = std::path::Path::new(&song.directory).join(format!("{VOCALS_STEM}.wav"));
    if !path.exists() {
        return Err("This song's vocals file is missing, so its lyrics cannot be synced.".to_string());
    }
    Ok(path)
}

/// Align `text` to the song's vocals stem, persist and return the result.
/// `on_progress(fraction, stage)` is called as the sidecar reports.
pub fn sync_impl(
    state: &SidecarState,
    song_id: &str,
    text: &str,
    source: &str,
    on_progress: &mut dyn FnMut(f32, &str),
) -> Result<Lyrics, String> {
    if text.trim().is_empty() {
        return Err("Paste the lyrics first.".to_string());
    }
    let song = find_song(song_id)?;
    let vocals = vocals_path(&song)?;

    let cmd = serde_json::json!({
        "cmd": "align_lyrics",
        "vocalsPath": vocals.to_string_lossy(),
        "lyrics": text,
        "modelsDir": crate::storage::app_data_dir().join("models").to_string_lossy(),
    });
    let data = run_sidecar_command(state, &cmd, SYNC_TIMEOUT, |value, stage| on_progress(value, &stage))?;
    let lyrics = from_alignment(source, text, &data, chrono::Utc::now().to_rfc3339())?;
    save(&song, &lyrics)?;
    Ok(lyrics)
}

/// Look the song's lyrics up online; the user reviews the text before syncing.
/// SPS keeps no separate artist, so the (cleaned) title is the whole query.
pub fn find_impl(state: &SidecarState, song_id: &str) -> Result<FoundLyrics, String> {
    let song = find_song(song_id)?;
    let cmd = serde_json::json!({
        "cmd": "find_lyrics",
        "title": song.title,
        "duration": if song.duration > 0.0 { Some(song.duration) } else { None },
    });
    let data = run_sidecar_command(state, &cmd, FIND_TIMEOUT, |_, _| {})?;
    serde_json::from_value(data).map_err(|e| format!("The sidecar returned malformed lyrics: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{self, test_support::TestHome};
    use serde_json::json;

    fn offline_state() -> SidecarState {
        SidecarState(std::sync::Mutex::new(None))
    }

    fn spawned(state: &SidecarState) -> bool {
        state.0.lock().unwrap().is_some()
    }

    /// A library entry whose directory exists; `stems` decides what it claims to hold.
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
        };
        library::add(song.clone()).unwrap();
        song
    }

    fn sample() -> Lyrics {
        Lyrics {
            version: 1,
            source: "paste".into(),
            text: "hello world".into(),
            aligner: "test".into(),
            aligned_at: "2026-01-01T00:00:00Z".into(),
            mean_score: 0.5,
            warning: None,
            lines: vec![LyricLine {
                text: "hello world".into(),
                start: 1.0,
                end: 2.5,
                score: 0.5,
                words: vec![
                    LyricWord { text: "hello".into(), start: 1.0, end: 1.5, score: 0.6 },
                    LyricWord { text: "world".into(), start: 1.8, end: 2.5, score: 0.4 },
                ],
            }],
        }
    }

    #[test]
    fn lyrics_serialize_camel_case() {
        let v = serde_json::to_value(sample()).unwrap();
        assert_eq!(v["alignedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(v["meanScore"], 0.5);
        assert_eq!(v["lines"][0]["words"][1]["text"], "world");
        assert!(v.get("aligned_at").is_none());
    }

    #[test]
    fn a_minimal_file_parses_with_defaults() {
        let l: Lyrics = serde_json::from_value(json!({"lines": [{"text": "a", "start": 1.0, "end": 2.0}]})).unwrap();
        assert_eq!(l.version, 1);
        assert_eq!(l.source, "paste");
        assert!(l.warning.is_none());
        assert!(l.lines[0].words.is_empty());
    }

    #[test]
    fn save_load_and_delete_round_trip() {
        let _home = TestHome::new();
        let s1 = add_song("s1", &["vocals"]);
        add_song("s2", &["vocals"]);
        assert_eq!(load("s1").unwrap(), None, "a song without lyrics loads as None");

        save(&s1, &sample()).unwrap();
        assert_eq!(load("s1").unwrap(), Some(sample()));
        assert_eq!(load("s2").unwrap(), None, "lyrics belong to one song");

        delete("s1").unwrap();
        assert_eq!(load("s1").unwrap(), None);
        delete("s1").expect("deleting lyrics that are not there is not an error");
    }

    #[test]
    fn lyrics_live_in_the_songs_own_directory() {
        let _home = TestHome::new();
        let song = add_song("s1", &["vocals"]);
        save(&song, &sample()).unwrap();
        assert!(std::path::Path::new(&song.directory).join("lyrics.json").is_file());
    }

    #[test]
    fn saving_leaves_no_temporary_file_and_replaces_an_existing_one() {
        let _home = TestHome::new();
        let song = add_song("s1", &["vocals"]);
        save(&song, &sample()).unwrap();
        let mut changed = sample();
        changed.text = "second version".into();
        save(&song, &changed).unwrap();

        assert_eq!(load("s1").unwrap().unwrap().text, "second version");
        let leftovers: Vec<_> = std::fs::read_dir(&song.directory)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_corrupt_file_is_reported_not_treated_as_empty() {
        let _home = TestHome::new();
        let song = add_song("s1", &["vocals"]);
        std::fs::write(lyrics_path(&song), "{not json").unwrap();
        assert!(load("s1").unwrap_err().contains("Parse lyrics"));
    }

    #[test]
    fn loading_lyrics_of_an_unknown_song_is_reported_and_creates_nothing() {
        let home = TestHome::new();
        assert!(load("ghost").unwrap_err().contains("Song not found"));
        assert!(delete("ghost").unwrap_err().contains("Song not found"));
        assert!(!home.path().join("library").join("ghost").exists());
    }

    #[test]
    fn a_song_removed_during_a_sync_is_not_resurrected_by_the_save() {
        let _home = TestHome::new();
        let song = add_song("s1", &["vocals"]);
        library::remove("s1").unwrap();

        let err = save(&song, &sample()).unwrap_err();
        assert!(err.contains("removed"), "{err}");
        assert!(!std::path::Path::new(&song.directory).exists());
    }

    #[test]
    fn removing_a_song_takes_its_lyrics_with_it() {
        let _home = TestHome::new();
        let song = add_song("s1", &["vocals"]);
        save(&song, &sample()).unwrap();
        library::remove("s1").unwrap();
        assert!(!std::path::Path::new(&song.directory).join("lyrics.json").exists());
    }

    #[test]
    fn the_stored_record_is_built_from_the_sidecar_result() {
        let data = json!({
            "aligner": "wav2vec2-base-960h",
            "meanScore": 0.41,
            "warning": "check the text",
            "lines": [{"text": "la", "start": 1.0, "end": 1.4, "score": 0.4,
                       "words": [{"text": "la", "start": 1.0, "end": 1.4, "score": 0.4}]}],
        });
        let l = from_alignment("lrclib", "la", &data, "2026-02-02T00:00:00Z".into()).unwrap();
        assert_eq!(l.source, "lrclib");
        assert_eq!(l.text, "la");
        assert_eq!(l.aligner, "wav2vec2-base-960h");
        assert_eq!(l.warning.as_deref(), Some("check the text"));
        assert_eq!(l.lines[0].words[0].end, 1.4);
    }

    #[test]
    fn a_null_warning_means_no_warning() {
        let data = json!({"warning": null, "lines": [{"text": "a", "start": 0.0, "end": 1.0}]});
        assert!(from_alignment("paste", "a", &data, String::new()).unwrap().warning.is_none());
    }

    #[test]
    fn malformed_or_empty_results_are_rejected() {
        assert!(from_alignment("paste", "a", &json!({}), String::new()).is_err());
        assert!(from_alignment("paste", "a", &json!({"lines": []}), String::new()).is_err());
        assert!(from_alignment("paste", "a", &json!({"lines": [{"text": 3}]}), String::new()).is_err());
    }

    #[test]
    fn syncing_refuses_empty_text_without_starting_the_sidecar() {
        let _home = TestHome::new();
        let state = offline_state();
        let err = sync_impl(&state, "s1", "  \n ", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("Paste the lyrics"));
        assert!(!spawned(&state));
    }

    #[test]
    fn syncing_an_unknown_song_is_reported() {
        let _home = TestHome::new();
        let state = offline_state();
        let err = sync_impl(&state, "ghost", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("Song not found"));
        assert!(!spawned(&state));
    }

    #[test]
    fn a_song_imported_without_the_vocals_stem_cannot_be_synced() {
        let _home = TestHome::new();
        add_song("drums-only", &["drums", "bass"]);
        let state = offline_state();
        let err = sync_impl(&state, "drums-only", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("without it"), "{err}");
        assert!(!spawned(&state));
    }

    #[test]
    fn a_song_whose_vocals_file_is_gone_is_reported() {
        let _home = TestHome::new();
        add_song("s1", &["vocals", "drums"]);
        let state = offline_state();
        let err = sync_impl(&state, "s1", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("missing"), "{err}");
        assert!(!spawned(&state));
    }

    #[test]
    fn finding_lyrics_for_an_unknown_song_is_reported() {
        let _home = TestHome::new();
        let state = offline_state();
        assert!(find_impl(&state, "ghost").unwrap_err().contains("Song not found"));
        assert!(!spawned(&state));
    }

    #[test]
    fn found_lyrics_deserialize_from_the_sidecar_reply() {
        let f: FoundLyrics = serde_json::from_value(json!({
            "text": "a\nb", "synced": true, "title": "T", "artist": "A", "duration": 200.0, "source": "lrclib"
        }))
        .unwrap();
        assert!(f.synced);
        assert_eq!(f.text, "a\nb");
    }
}
