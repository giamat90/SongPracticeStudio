use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;

/// A recorded track (take), no analysis data — just the raw recording and
/// where it sits on the song timeline.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub song_id: String,
    pub recorded_at: String,
    pub filepath: String,
    /// User-assigned display name; falls back to "Take N" in the UI when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Song position (seconds) where recording started; 0 for full-song takes.
    #[serde(default)]
    pub start_position: f64,
    /// Seconds into the audio file to skip on playback (non-zero when latency
    /// compensation exceeds start_position).
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub audio_offset: f64,
    /// Seconds, signed; user drag nudge applied on top of start_position to fine-tune
    /// sync after the fact. 0 means untouched.
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub manual_offset: f64,
}

fn is_zero_f64(v: &f64) -> bool {
    *v == 0.0
}

fn takes_json_path(song_id: &str) -> std::path::PathBuf {
    storage::song_dir(song_id).join("takes.json")
}

/// Load all takes recorded for a song.
pub fn load(song_id: &str) -> Result<Vec<Take>, String> {
    let path = takes_json_path(song_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read takes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse takes: {e}"))
}

fn save(song_id: &str, takes: &[Take]) -> Result<(), String> {
    let path = takes_json_path(song_id);
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Write takes: {e}"))
}

/// Append a newly recorded take to the song's take list.
pub fn add(song_id: &str, take: Take) -> Result<(), String> {
    let mut takes = load(song_id)?;
    takes.push(take);
    save(song_id, &takes)
}

/// Delete a take's audio file and remove it from the take list.
pub fn remove(song_id: &str, take_id: &str) -> Result<(), String> {
    let takes = load(song_id)?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("Delete take file: {e}"))?;
        }
    }
    let filtered: Vec<Take> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save(song_id, &filtered)
}

/// Rename a take (empty/whitespace name clears it back to the default "Take N" label).
pub fn rename(song_id: &str, take_id: &str, name: &str) -> Result<Take, String> {
    let mut takes = load(song_id)?;
    let trimmed = name.trim();
    let take = takes
        .iter_mut()
        .find(|t| t.id == take_id)
        .ok_or_else(|| format!("Take not found: {take_id}"))?;
    take.name = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    let updated = take.clone();
    save(song_id, &takes)?;
    Ok(updated)
}

/// Set (or clear, with 0.0) a manual sync-drag offset on top of start_position.
pub fn set_manual_offset(song_id: &str, take_id: &str, offset: f64) -> Result<Take, String> {
    let mut takes = load(song_id)?;
    let take = takes
        .iter_mut()
        .find(|t| t.id == take_id)
        .ok_or_else(|| format!("Take not found: {take_id}"))?;
    take.manual_offset = offset;
    let updated = take.clone();
    save(song_id, &takes)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;

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

    fn ids(song_id: &str) -> Vec<String> {
        load(song_id).unwrap().into_iter().map(|t| t.id).collect()
    }

    #[test]
    fn a_song_without_takes_has_an_empty_list() {
        let _home = TestHome::new();
        assert!(load("s1").unwrap().is_empty());
    }

    #[test]
    fn added_takes_keep_their_order_and_survive_a_reload() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        add("s1", take("b")).unwrap();
        assert_eq!(ids("s1"), ["a", "b"]);
    }

    #[test]
    fn takes_of_different_songs_do_not_mix() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        add("s2", take("b")).unwrap();
        assert_eq!(ids("s1"), ["a"]);
        assert_eq!(ids("s2"), ["b"]);
    }

    #[test]
    fn a_corrupt_takes_file_is_reported_and_not_overwritten() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("takes.json"), "oops").unwrap();
        assert!(load("s1").unwrap_err().contains("Parse takes"));
        assert!(add("s1", take("a")).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("takes.json")).unwrap(), "oops");
    }

    #[test]
    fn rename_trims_and_an_empty_name_clears_back_to_the_default_label() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        assert_eq!(rename("s1", "a", "  Chorus  ").unwrap().name.as_deref(), Some("Chorus"));
        assert_eq!(load("s1").unwrap()[0].name.as_deref(), Some("Chorus"));
        assert_eq!(rename("s1", "a", "   ").unwrap().name, None);
        assert_eq!(load("s1").unwrap()[0].name, None);
    }

    #[test]
    fn rename_only_touches_the_named_take() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        add("s1", take("b")).unwrap();
        rename("s1", "b", "B").unwrap();
        assert_eq!(load("s1").unwrap()[0].name, None);
    }

    #[test]
    fn rename_and_manual_offset_report_an_unknown_take() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        assert!(rename("s1", "zzz", "x").unwrap_err().contains("zzz"));
        assert!(set_manual_offset("s1", "zzz", 1.0).unwrap_err().contains("zzz"));
    }

    #[test]
    fn manual_offset_persists_and_zero_is_not_stored() {
        let _home = TestHome::new();
        add("s1", take("a")).unwrap();
        assert_eq!(set_manual_offset("s1", "a", -0.75).unwrap().manual_offset, -0.75);
        assert_eq!(load("s1").unwrap()[0].manual_offset, -0.75);
        set_manual_offset("s1", "a", 0.0).unwrap();
        let raw = std::fs::read_to_string(storage::song_dir("s1").join("takes.json")).unwrap();
        assert!(!raw.contains("manualOffset"));
    }

    #[test]
    fn remove_deletes_the_entry_and_its_audio_file_only() {
        let home = TestHome::new();
        let file_a = home.path().join("a.wav");
        let file_b = home.path().join("b.wav");
        std::fs::write(&file_a, b"a").unwrap();
        std::fs::write(&file_b, b"b").unwrap();
        let (mut a, mut b) = (take("a"), take("b"));
        a.filepath = file_a.to_string_lossy().to_string();
        b.filepath = file_b.to_string_lossy().to_string();
        add("s1", a).unwrap();
        add("s1", b).unwrap();

        remove("s1", "a").unwrap();

        assert!(!file_a.exists());
        assert!(file_b.exists());
        assert_eq!(ids("s1"), ["b"]);
    }

    #[test]
    fn remove_copes_with_a_missing_file_and_an_unknown_id() {
        let _home = TestHome::new();
        let mut a = take("a");
        a.filepath = "/not/there.wav".into();
        add("s1", a).unwrap();
        remove("s1", "a").unwrap();
        remove("s1", "never").unwrap();
        assert!(load("s1").unwrap().is_empty());
    }

    #[test]
    fn a_take_round_trips_with_every_field() {
        let _home = TestHome::new();
        let mut t = take("a");
        t.name = Some("Verse".into());
        t.start_position = 12.5;
        t.audio_offset = 0.25;
        t.manual_offset = -1.5;
        add("s1", t.clone()).unwrap();
        assert_eq!(format!("{:?}", load("s1").unwrap()[0]), format!("{t:?}"));
    }
}
