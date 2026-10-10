//! Rust <-> Python integration: the real command bodies driving the real
//! sidecar over its JSON-lines protocol, against a throwaway data directory.
//! Skipped (loudly) when the sidecar's Python environment is not installed;
//! set SPS_REQUIRE_SIDECAR=1 to make that a failure instead.
//!
//! Demucs itself is never run (it needs torch and model weights); the song
//! job is exercised through its validation path, which fails inside the real
//! sidecar before any model is loaded.

use crate::commands::{
    convert_take_to_temp_wav, import_youtube_impl, pitch_shift_song_impl, process_song_impl, render_mix_to_temp_wav,
    save_take_impl, MixSource, ProcessingStatus, SidecarState,
};
use crate::library;
use crate::lyrics;
use crate::sidecar::SidecarManager;
use crate::storage::{self, test_support::TestHome};
use crate::takes;
use crate::test_util::{read_wav, rms_dbfs, sidecar_unavailable, tones, wav_bytes, write_wav};
use std::cell::RefCell;
use std::path::Path;
use std::sync::Mutex;

const SR: u32 = 44100;

/// A home directory plus a running sidecar, or `None` (after reporting the skip).
fn start() -> Option<(TestHome, SidecarState)> {
    let home = TestHome::new();
    // The sidecar caches its yt-dlp freshness check under ~; keep it out of the real home.
    std::env::set_var("USERPROFILE", home.path());
    std::env::set_var("HOME", home.path());
    let state = SidecarState(Mutex::new(None));
    match SidecarManager::spawn() {
        Ok(m) => *state.0.lock().unwrap() = Some(m),
        Err(e) => {
            sidecar_unavailable(&e);
            return None;
        }
    }
    Some((home, state))
}

/// Zero crossings per second of a mono signal, a stand-in for twice its frequency.
fn crossings_per_second(samples: &[f32], sr: u32) -> f64 {
    let crossings = samples.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    crossings as f64 / (samples.len() as f64 / sr as f64)
}

#[test]
fn recording_a_take_normalizes_it_against_the_vocals_and_keeps_the_whole_file() {
    let Some((_home, state)) = start() else { return };
    let song_dir = storage::song_dir("song-1");
    let vocals = song_dir.join("vocals.wav");
    write_wav(&vocals, &tones(&[(300.0, 0.1)], SR, 2.0), SR);
    let reference_rms = rms_dbfs(&read_wav(&vocals).samples);

    // 0.25 s of latency padding (silence) followed by 2 s of a quiet tone.
    let mut samples = vec![0.0f32; (0.25 * SR as f64) as usize];
    samples.extend(tones(&[(220.0, 0.4)], SR, 2.0));
    let raw = wav_bytes(&samples, SR);

    let take = save_take_impl(&state, "song-1".into(), raw, 0.0, 0.25).expect("save_take");

    assert_eq!((take.song_id.as_str(), take.start_position, take.audio_offset), ("song-1", 0.0, 0.25));
    assert!(take.filepath.ends_with(".wav"), "normalized WAV replaces the raw recording: {}", take.filepath);
    assert!(
        !song_dir.join("takes").read_dir().unwrap().any(|e| e.unwrap().path().extension().is_some_and(|x| x == "webm")),
        "raw recording is removed once the normalized file exists"
    );

    let out = read_wav(Path::new(&take.filepath));
    assert_eq!(out.samples.len(), samples.len(), "the file keeps its leading padding: the player skips audioOffset itself");
    assert!(out.samples[..1000].iter().all(|s| s.abs() < 1e-3));
    let audible = &out.samples[(0.25 * SR as f64) as usize..];
    assert!((rms_dbfs(audible) - reference_rms).abs() < 1.0, "loudness of the audible part matches the vocals stem");
    assert!(out.samples.iter().all(|s| s.abs() < 0.9), "never pushed past the peak ceiling");

    let listed = takes::load("song-1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].filepath, take.filepath);
}

#[test]
fn without_a_vocals_stem_a_take_is_normalized_to_the_fallback_loudness() {
    let Some((_home, state)) = start() else { return };
    let raw = wav_bytes(&tones(&[(220.0, 0.05)], SR, 2.0), SR);
    let take = save_take_impl(&state, "bare-song".into(), raw, 4.0, 0.0).expect("save_take");
    let rms = rms_dbfs(&read_wav(Path::new(&take.filepath)).samples);
    assert!((rms + 18.0).abs() < 1.0, "expected about -18 dBFS, got {rms}");
}

#[test]
fn a_recording_the_sidecar_cannot_decode_is_kept_raw_instead_of_being_lost() {
    let Some((_home, state)) = start() else { return };
    let take = save_take_impl(&state, "song-2".into(), b"definitely not audio".to_vec(), 1.0, 0.0).expect("save_take");
    assert!(take.filepath.ends_with(".webm"), "falls back to the raw file: {}", take.filepath);
    assert_eq!(std::fs::read(&take.filepath).unwrap(), b"definitely not audio");
    assert_eq!(takes::load("song-2").unwrap().len(), 1, "the take is still listed");
}

#[test]
fn a_take_can_be_converted_for_export_and_the_temp_file_cleans_up_after_itself() {
    let Some((home, state)) = start() else { return };
    let src = home.path().join("take.wav");
    write_wav(&src, &tones(&[(330.0, 0.3)], 22050, 1.0), 22050);

    let temp = convert_take_to_temp_wav(&state, &src.to_string_lossy()).expect("convert");
    let path = temp.0.clone();
    let wav = read_wav(&path);
    assert_eq!((wav.sample_rate, wav.channels), (22050, 1));
    assert!((wav.samples.len() as f64 - 22050.0).abs() < 100.0);
    drop(temp);
    assert!(!path.exists());

    let err = convert_take_to_temp_wav(&state, "/no/such/take.webm").unwrap_err();
    assert!(err.contains("Take not found"), "{err}");
}

#[test]
fn an_exported_mix_puts_the_take_where_the_timeline_says() {
    let Some((home, state)) = start() else { return };
    let sr = 8000u32;
    let stem = home.path().join("stem.wav");
    write_wav(&stem, &vec![0.1f32; sr as usize * 6], sr);
    let take_file = home.path().join("take.wav");
    write_wav(&take_file, &vec![0.3f32; sr as usize * 2], sr);

    let sources = vec![
        MixSource { path: stem.to_string_lossy().to_string(), gain: 1.0, is_take: false, start_position: None, audio_offset: None, manual_offset: None },
        MixSource {
            path: take_file.to_string_lossy().to_string(), gain: 1.0, is_take: true,
            start_position: Some(3.0), audio_offset: Some(0.0), manual_offset: Some(0.0),
        },
    ];
    let temp = render_mix_to_temp_wav(&state, &sources, 2.0, 6.0).expect("mix");
    let mix = read_wav(&temp.0);
    assert_eq!(mix.channels, 2);
    let at = |t: f64| mix.samples[(t * sr as f64) as usize * 2];
    assert!((at(0.5) - 0.1).abs() < 0.01, "before the take only the stem plays");
    assert!((at(1.5) - 0.4).abs() < 0.01, "the take (3 s .. 5 s) sits over the stem");
    assert!((at(3.5) - 0.1).abs() < 0.01, "after the take only the stem plays");
}

#[test]
fn a_mix_with_a_missing_source_reports_the_sidecars_error() {
    let Some((_home, state)) = start() else { return };
    let sources = vec![MixSource {
        path: "/no/such/stem.wav".into(), gain: 1.0, is_take: false, start_position: None, audio_offset: None, manual_offset: None,
    }];
    assert!(render_mix_to_temp_wav(&state, &sources, 0.0, 1.0).is_err());
}

#[test]
fn transposing_shifts_every_stem_and_is_cached_for_the_next_time() {
    let Some((home, state)) = start() else { return };
    let song_dir = home.path().join("song");
    std::fs::create_dir_all(&song_dir).unwrap();
    for (name, f) in [("vocals", 220.0), ("bass", 110.0)] {
        write_wav(&song_dir.join(format!("{name}.wav")), &tones(&[(f, 0.4)], 22050, 1.0), 22050);
    }
    let dir = song_dir.to_string_lossy().to_string();
    let stems = vec!["vocals".to_string(), "bass".to_string()];

    let result = pitch_shift_song_impl(&state, dir.clone(), stems.clone(), 12).expect("pitch shift");
    for (name, expected_hz) in [("vocals", 440.0), ("bass", 220.0)] {
        let path = result["stems"][name].as_str().unwrap_or_else(|| panic!("no path for {name}: {result}"));
        assert!(path.replace('\\', "/").contains("pitched/12/"), "{path}");
        let wav = read_wav(Path::new(path));
        let hz = crossings_per_second(&wav.samples[2000..wav.samples.len() - 2000], wav.sample_rate) / 2.0;
        assert!((hz - expected_hz).abs() / expected_hz < 0.03, "{name}: {hz} Hz, expected {expected_hz}");
    }

    let offline = SidecarState(Mutex::new(None));
    let cached = pitch_shift_song_impl(&offline, dir.clone(), stems.clone(), 12).expect("cached");
    assert_eq!(cached["stems"]["vocals"], result["stems"]["vocals"]);
    assert!(offline.0.lock().unwrap().is_none(), "a cache hit must not need the sidecar");

    // One missing file means the cache is incomplete: the sidecar must run again and refill it.
    let bass_cached = Path::new(result["stems"]["bass"].as_str().unwrap());
    std::fs::remove_file(bass_cached).unwrap();
    pitch_shift_song_impl(&state, dir.clone(), stems.clone(), 12).expect("refill");
    assert!(bass_cached.exists(), "a partially cached transpose is recomputed");

    let missing = pitch_shift_song_impl(&state, dir, vec!["drums".to_string()], 3);
    assert!(missing.is_err(), "a stem that is not on disk cannot be shifted");
}

#[test]
fn a_failed_song_job_reports_the_error_and_leaves_nothing_behind() {
    let Some((home, state)) = start() else { return };
    let source = home.path().join("my song.wav");
    write_wav(&source, &tones(&[(220.0, 0.3)], 22050, 1.0), 22050);
    let events = RefCell::new(Vec::<ProcessingStatus>::new());

    // An empty stem list is rejected by the sidecar before any model is loaded.
    let err = process_song_impl(&state, source.to_string_lossy().to_string(), Some(vec![]), None, &|s| events.borrow_mut().push(s))
        .unwrap_err();

    assert!(err.contains("No valid stems"), "{err}");
    let events = events.borrow();
    let last = events.last().expect("a status event");
    assert!(last.is_complete && last.stage == "error" && last.error.as_deref() == Some(err.as_str()));
    assert!(library::load_songs().unwrap().is_empty(), "the failed song is not added");
    let leftovers = storage::library_dir().read_dir().unwrap().count();
    assert_eq!(leftovers, 0, "the copied source and any partial output are removed");
    assert!(source.exists(), "the user's own file is untouched");

    let youtube = import_youtube_impl(&state, "https://vimeo.com/1".into(), None, None, None, &|_| {}).unwrap_err();
    assert_eq!(youtube, "Not a valid YouTube URL");
}

#[test]
fn lyrics_sync_goes_through_the_real_sidecar_and_is_persisted() {
    // Test-only sidecar engine: places the letters evenly over the sung part of the
    // file, so this exercises the wire path without the 360 MB acoustic model.
    // Set before the sidecar is spawned; it only affects `align_lyrics`.
    std::env::set_var("SPS_LYRICS_ENGINE", "uniform");
    let Some((_home, state)) = start() else { return };

    let sr = 16000u32;
    let song_dir = storage::song_dir("song-ly");
    let mut samples = vec![0.0f32; sr as usize / 2];
    samples.extend(tones(&[(220.0, 0.3)], sr, 4.0));
    samples.extend(vec![0.0f32; sr as usize / 2]);
    write_wav(&song_dir.join("vocals.wav"), &samples, sr);
    library::add(library::Song {
        id: "song-ly".into(),
        title: "Lyrics Song".into(),
        duration: 5.0,
        detected_key: None,
        detected_bpm: None,
        processed_at: "2026-01-01T00:00:00Z".into(),
        directory: song_dir.to_string_lossy().to_string(),
        stems: vec!["vocals".into(), "drums".into()],
        metronome_offset: None,
        has_chords: false,
        folder_id: None,
        sort_index: 0,
    })
    .unwrap();

    let mut seen: Vec<(f32, String)> = Vec::new();
    let text = "[Verse]
hello there my friend
sing it out loud";
    let result = lyrics::sync_impl(&state, "song-ly", text, "paste", &mut |p, s| seen.push((p, s.to_string())))
        .expect("sync_lyrics");

    assert_eq!(result.lines.len(), 2, "the [Verse] marker is not a lyric line");
    assert_eq!(result.lines[0].text, "hello there my friend");
    assert_eq!(result.text, text, "the user's text is kept verbatim for re-syncing");
    assert_eq!(result.source, "paste");
    assert_eq!(result.aligner, "uniform-test-engine");
    let (a, b) = (&result.lines[0], &result.lines[1]);
    assert!(a.start >= 0.4 && a.start < a.end && a.end <= b.start && b.end <= 5.0, "{a:?} {b:?}");
    assert_eq!(a.words.len(), 4);
    assert!(a.words.windows(2).all(|w| w[0].start <= w[1].start));

    assert!(!seen.is_empty(), "progress is streamed");
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "progress never goes backwards");
    assert_eq!(seen.last().unwrap().0, 1.0);

    assert_eq!(lyrics::load("song-ly").unwrap(), Some(result.clone()), "persisted to lyrics.json");
    assert!(song_dir.join("lyrics.json").exists());

    // A failure inside the sidecar surfaces as its own message and leaves the saved lyrics alone.
    std::fs::write(song_dir.join("vocals.wav"), vec![0u8; 16]).unwrap();
    let err = lyrics::sync_impl(&state, "song-ly", "la la la", "paste", &mut |_, _| {}).unwrap_err();
    assert!(err.to_lowercase().contains("read"), "{err}");
    assert_eq!(lyrics::load("song-ly").unwrap(), Some(result));

    // ...and the sidecar is still usable afterwards.
    write_wav(&song_dir.join("vocals.wav"), &samples, sr);
    lyrics::sync_impl(&state, "song-ly", "la la la", "paste", &mut |_, _| {}).expect("sync after a failure");

    std::env::remove_var("SPS_LYRICS_ENGINE");
}
