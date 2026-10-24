//! A song's bars: where each starts, how many pulses it has and which note is one pulse. The detector writes
//! `meter.json`; the user's corrections live apart in `meter_edited.json` and win when present, so detecting
//! again never mixes with them. The Tauri command wrappers live in `commands.rs`.

use crate::library;
use serde::{Deserialize, Serialize};
use std::fs;

const DETECTED_FILE: &str = "meter.json";
const EDITS_FILE: &str = "meter_edited.json";
const FORMAT_VERSION: u32 = 1;
const MAX_BARS: usize = 20_000;
const MAX_PULSES: u32 = 32;
const UNITS: [u32; 6] = [1, 2, 4, 8, 16, 32];
/// A pulse shorter than this could not be heard as a click or told apart on screen.
const MIN_PULSE_SECONDS: f64 = 0.05;
const SOURCES: [&str; 4] = ["detected", "grid", "tapped", "edited"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterBar {
    /// Seconds into the recording at which the bar starts; it lasts until the next bar starts.
    pub start: f64,
    /// Pulses in the bar, spaced evenly over it.
    pub num: u32,
    /// The note that is one pulse (the bottom of the time signature).
    pub den: u32,
    /// How the pulses split into accented groups; absent means the usual split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterDoc {
    pub version: u32,
    pub bars: Vec<MeterBar>,
    /// Where the last bar ends: the song's length.
    pub end: f64,
    /// "detected", "grid", "tapped" or "edited".
    pub source: String,
    /// 0 to 1, how sure the detector was; absent for anything a person made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

fn round3(t: f64) -> f64 {
    (t * 1000.0).round() / 1000.0
}

/// Check a bar map from the editor and return it rounded to the millisecond. The same rules as the frontend's
/// `validateMap`: bars in time order, a real note for a unit, groups that add up, and room for every pulse.
pub fn clean_meter(doc: MeterDoc) -> Result<MeterDoc, String> {
    if doc.bars.is_empty() {
        return Err("A bar map needs at least one bar".to_string());
    }
    if doc.bars.len() > MAX_BARS {
        return Err(format!("Too many bars ({})", doc.bars.len()));
    }
    if !doc.end.is_finite() || doc.end <= 0.0 {
        return Err("The map has no length".to_string());
    }
    if !SOURCES.contains(&doc.source.as_str()) {
        return Err(format!("Unknown source: {}", doc.source));
    }
    let end = round3(doc.end);
    let mut bars: Vec<MeterBar> = Vec::with_capacity(doc.bars.len());
    for (i, bar) in doc.bars.iter().enumerate() {
        let n = i + 1;
        if !bar.start.is_finite() || bar.start < 0.0 {
            return Err(format!("Bar {n} starts before the song"));
        }
        let start = round3(bar.start);
        if let Some(previous) = bars.last() {
            if start <= previous.start {
                return Err(format!("Bar {n} does not start after the bar before it"));
            }
        }
        if bar.num < 1 || bar.num > MAX_PULSES {
            return Err(format!("Bar {n} needs between 1 and {MAX_PULSES} pulses"));
        }
        if !UNITS.contains(&bar.den) {
            return Err(format!("Bar {n} has a unit of 1/{}, which is not a note", bar.den));
        }
        if let Some(groups) = &bar.groups {
            if groups.iter().any(|g| *g < 1) || groups.iter().sum::<u32>() != bar.num {
                return Err(format!("The groups of bar {n} do not add up to {}", bar.num));
            }
        }
        bars.push(MeterBar { start, num: bar.num, den: bar.den, groups: bar.groups.clone() });
    }
    for (i, bar) in bars.iter().enumerate() {
        let bar_end = bars.get(i + 1).map_or(end, |next| next.start);
        if (bar_end - bar.start) / f64::from(bar.num) < MIN_PULSE_SECONDS - 1e-9 {
            return Err(format!("Bar {} is too short for {} pulses", i + 1, bar.num));
        }
    }
    let confidence = doc.confidence.filter(|c| c.is_finite()).map(|c| (c.clamp(0.0, 1.0) * 100.0).round() / 100.0);
    Ok(MeterDoc { version: FORMAT_VERSION, bars, end, source: doc.source, confidence })
}

fn parse(data: &str, what: &str) -> Result<MeterDoc, String> {
    serde_json::from_str(data).map_err(|e| format!("Parse {what}: {e}"))
}

/// A song's bars: the user's when there are any, otherwise what the detector wrote. `None` for a song with neither.
pub fn read_meter(song_id: &str) -> Result<Option<MeterDoc>, String> {
    let dir = library::song_directory(song_id)?;
    for (file, what) in [(EDITS_FILE, "meter edits"), (DETECTED_FILE, "meter")] {
        let path = dir.join(file);
        if path.exists() {
            let data = fs::read_to_string(&path).map_err(|e| format!("Read {what}: {e}"))?;
            return parse(&data, what).map(Some);
        }
    }
    Ok(None)
}

/// Whether the song's bars carry the user's corrections.
pub fn has_meter_edits(song_id: &str) -> Result<bool, String> {
    Ok(library::song_directory(song_id)?.join(EDITS_FILE).exists())
}

/// Throw the user's corrections away; the detected bars show again. Not an error when there are none.
pub fn clear_meter_edits(song_id: &str) -> Result<(), String> {
    let path = library::song_directory(song_id)?.join(EDITS_FILE);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Clear meter edits: {e}")),
    }
}

/// Save the user's bar map for a song and return it as stored.
pub fn save_meter_edits(song_id: &str, doc: MeterDoc) -> Result<MeterDoc, String> {
    let dir = library::song_directory(song_id)?;
    let cleaned = clean_meter(doc)?;
    let path = dir.join(EDITS_FILE);
    let body = serde_json::to_string(&cleaned).map_err(|e| format!("Write meter edits: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("Write meter edits: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Write meter edits: {e}"))?;
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;

    fn bar(start: f64, num: u32, den: u32) -> MeterBar {
        MeterBar { start, num, den, groups: None }
    }

    fn doc(bars: Vec<MeterBar>, end: f64) -> MeterDoc {
        MeterDoc { version: 1, bars, end, source: "edited".to_string(), confidence: None }
    }

    fn song_with_detected_meter(home: &TestHome) {
        let dir = home.path().join("library").join("a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(DETECTED_FILE),
            r#"{"version":1,"algorithm":"x","bars":[{"start":1.0,"num":4,"den":4},{"start":3.0,"num":4,"den":4}],"end":5.0,"source":"detected","confidence":0.4}"#,
        )
        .unwrap();
        let song: library::Song = serde_json::from_str(&format!(
            r#"{{"id":"a","title":"A","duration":5.0,"detectedKey":null,"detectedBpm":120.0,"processedAt":"","directory":{}}}"#,
            serde_json::to_string(&dir.to_string_lossy()).unwrap()
        ))
        .unwrap();
        library::add(song).unwrap();
    }

    #[test]
    fn a_good_map_is_stored_rounded_to_the_millisecond() {
        let cleaned = clean_meter(doc(vec![bar(1.00049, 7, 8), bar(3.5, 4, 4)], 6.0)).unwrap();
        assert_eq!(cleaned.bars[0].start, 1.0);
        assert_eq!(cleaned.version, 1);
    }

    #[test]
    fn a_map_that_could_not_be_played_is_rejected_with_the_reason() {
        let cases: Vec<(MeterDoc, &str)> = vec![
            (doc(vec![], 5.0), "at least one bar"),
            (doc(vec![bar(2.0, 4, 4), bar(1.0, 4, 4)], 5.0), "does not start after"),
            (doc(vec![bar(1.0, 4, 4), bar(1.0, 4, 4)], 5.0), "does not start after"),
            (doc(vec![bar(0.0, 4, 5)], 5.0), "not a note"),
            (doc(vec![bar(0.0, 0, 4)], 5.0), "between 1 and 32"),
            (doc(vec![bar(0.0, 33, 4)], 60.0), "between 1 and 32"),
            (doc(vec![bar(-1.0, 4, 4)], 5.0), "before the song"),
            (doc(vec![bar(0.0, 32, 8)], 1.0), "too short"),
            (doc(vec![bar(0.0, 4, 4)], 0.0), "no length"),
            (
                doc(vec![MeterBar { groups: Some(vec![3, 3]), ..bar(0.0, 7, 8) }], 5.0),
                "do not add up",
            ),
            (MeterDoc { source: "guess".to_string(), ..doc(vec![bar(0.0, 4, 4)], 5.0) }, "Unknown source"),
        ];
        for (bad, reason) in cases {
            let err = clean_meter(bad).unwrap_err();
            assert!(err.contains(reason), "{err} should mention {reason}");
        }
    }

    #[test]
    fn the_detected_bars_show_until_the_user_saves_their_own() {
        let home = TestHome::new();
        song_with_detected_meter(&home);
        let detected = read_meter("a").unwrap().unwrap();
        assert_eq!(detected.source, "detected");
        assert_eq!(detected.confidence, Some(0.4));
        assert!(!has_meter_edits("a").unwrap());

        save_meter_edits("a", doc(vec![bar(1.0, 7, 8)], 5.0)).unwrap();
        assert!(has_meter_edits("a").unwrap());
        let mine = read_meter("a").unwrap().unwrap();
        assert_eq!(mine.bars[0].num, 7);
        assert_eq!(mine.source, "edited");
    }

    #[test]
    fn clearing_the_edits_brings_the_detected_bars_back_and_is_not_an_error_twice() {
        let home = TestHome::new();
        song_with_detected_meter(&home);
        save_meter_edits("a", doc(vec![bar(1.0, 7, 8)], 5.0)).unwrap();
        clear_meter_edits("a").unwrap();
        clear_meter_edits("a").unwrap();
        assert_eq!(read_meter("a").unwrap().unwrap().source, "detected");
    }

    #[test]
    fn a_song_nobody_analysed_has_no_bars() {
        let home = TestHome::new();
        song_with_detected_meter(&home);
        fs::remove_file(home.path().join("library").join("a").join(DETECTED_FILE)).unwrap();
        assert!(read_meter("a").unwrap().is_none());
    }

    #[test]
    fn a_rejected_save_leaves_the_stored_edit_alone() {
        let home = TestHome::new();
        song_with_detected_meter(&home);
        save_meter_edits("a", doc(vec![bar(1.0, 7, 8)], 5.0)).unwrap();
        assert!(save_meter_edits("a", doc(vec![bar(1.0, 0, 8)], 5.0)).is_err());
        assert_eq!(read_meter("a").unwrap().unwrap().bars[0].num, 7);
    }

    #[test]
    fn a_corrupt_edits_file_is_an_error_not_a_silent_fallback() {
        let home = TestHome::new();
        song_with_detected_meter(&home);
        let dir = home.path().join("library").join("a");
        fs::write(dir.join(EDITS_FILE), "{{").unwrap();
        assert!(read_meter("a").unwrap_err().contains("Parse meter edits"));
        clear_meter_edits("a").unwrap();
        assert_eq!(read_meter("a").unwrap().unwrap().source, "detected");
    }

    #[test]
    fn the_commands_name_the_song_that_is_missing() {
        let _home = TestHome::new();
        assert!(read_meter("ghost").unwrap_err().contains("ghost"));
        assert!(save_meter_edits("ghost", doc(vec![bar(0.0, 4, 4)], 5.0)).unwrap_err().contains("ghost"));
        assert!(has_meter_edits("ghost").unwrap_err().contains("ghost"));
        assert!(clear_meter_edits("ghost").unwrap_err().contains("ghost"));
    }
}
