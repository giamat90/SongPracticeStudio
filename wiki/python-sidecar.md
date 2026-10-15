# Python Sidecar

**Files:** `sidecar/main.py` · `sidecar/processor.py` · `sidecar/recording.py` · `sidecar/yt_importer.py` · `sidecar/build.py`

## Role

The Python sidecar handles computationally heavy audio processing:

- **Stem separation** — split a mixed audio file into up to 6 instrument stems via Demucs
- **BPM detection** — estimate tempo from the full mix
- **Key detection** — estimate musical key via chromagram
- **Take post-processing** — WAV conversion and RMS loudness normalization of recordings (`recording.py`)
- **Mixdown rendering** — sum tracks with per-source gain over a time window (`mix_export`)
- **Key transpose** — phase-vocoder pitch-shift every stem by N semitones, tempo preserved (`pitch_shift`)
- **Lyrics sync** — CTC forced alignment of lyric text to the vocals stem, plus an LRCLIB lookup (`align_lyrics`, `find_lyrics`; `mps_core.lyrics`, see [Lyrics Sync](lyrics.md))

## IPC Protocol

Communication is **JSON lines** on stdin/stdout. Each message is a single JSON object terminated by `\n`. Stderr is not used for structured communication.

The protocol is **UTF-8** in both directions. `SidecarManager::spawn()` sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` on the child, and `main.py` also `reconfigure`s its stdio to UTF-8 at startup. Without this, Python on Windows decodes stdin with the console codepage (e.g. cp1252) and mangles any non-ASCII character in a file path — which surfaces downstream as a misleading `ffprobe`/"ffmpeg was not found" failure inside Demucs rather than an encoding error. (Ported from VPS, 2026-08-30.)

### Startup

On launch the sidecar sends:

```json
{"type": "ready"}
```

Rust waits for this before considering the sidecar usable.

### Request Format

Rust sends one command at a time (the sidecar processes synchronously):

```json
{"cmd": "<command>", ...args}
```

### Response Types

| `type` | When sent |
|--------|-----------|
| `"result"` | Command succeeded; payload in `"data"` |
| `"progress"` | Intermediate progress update |
| `"error"` | Command failed; `"message"` and `"traceback"` fields |
| `"pong"` | Response to `ping` |
| `"bye"` | Response to `quit`, sidecar exits |

### Progress Messages

```json
{"type": "progress", "cmd": "process", "stage": "separating", "value": 0.42}
```

`value` is 0–1. The Rust backend forwards these as `"processing-progress"` Tauri events to the frontend.

## Commands

### `process`

Separates a mixed audio file and extracts BPM, key, chords, and (if a bass stem exists) a bass tab transcription.

```json
{"cmd": "process", "filePath": "/path/to/song.mp3", "outputDir": "/path/to/output/", "stemsToExtract": ["vocals", "drums"], "highQuality": false}
```

`stemsToExtract` (optional) — subset of stems to write; drives smart model selection: no guitar/piano requested → a single `htdemucs`(`_ft`) pass; guitar or piano requested → cascade, `htdemucs`(`_ft`) on the full mix followed by `htdemucs_6s` on the resulting "other" stem. `highQuality` (optional, default `false`) — use `htdemucs_ft` instead of `htdemucs` for the first pass. A request that names no valid stem (empty list, only unknown names) is rejected up front with `No valid stems requested` instead of failing later with an empty message.

Steps (`processor.py`):
1. Demucs (model per the cascade above) → writes each requested stem's WAV (progress 0→0.75)
2. BPM detection via `librosa.beat.tempo` on the original file (0.75→0.86)
3. Key detection via `chroma_cqt` on the first 60 seconds + Krumhansl-Kessler profiles (0.86→0.92)
4. Chord detection — chroma windowed **on the beats** (`_beat_frames`: `librosa.beat.beat_track` on the drums + bass stems when there are drums, on everything otherwise; fewer than `_MIN_BEATS` beats or a median interval outside 0.2–1.5 s means no usable pulse and a fixed 1 s grid is used; a beat longer than `_MAX_WINDOW_SECONDS` is cut in equal parts, a sliver under `_MIN_WINDOW_SECONDS` is folded into its neighbour) → chord-template matching, **decoded with Viterbi** (`_viterbi`) over 61 states (24 triads, 36 sevenths, no-chord): the emission is the cosine score, a seventh pays `_SEVENTH_MARGIN`, a chord of the detected key (`_best_key` on the song's own chroma, `_diatonic_chords`) gets `_KEY_BONUS`, and every change costs `_SWITCH_COST` (less for the same root or a fifth apart, `_transition_costs`) — so one noisy window cannot flip a chord and a change has to be backed by about that much score. This replaced the 3-window median filter in `CHORDS_FORMAT_VERSION` 4. The chroma is computed with an explicit `librosa.estimate_tuning` on the harmonic mix (the same value for the bass chroma): `chroma_cqt`'s own default estimate misses a recording about a quarter-tone off A440 (measured: a 2019 remix at +29 cents went 26% → 60% root accuracy against its reference chart; songs within ±16 cents are unchanged within noise). Chords: 24 major/minor triads, plus 7, maj7 and min7 chords when the seventh clearly beats the best triad (`_SEVENTH_MARGIN`), plus a slash-chord `bass` note read from the bass stem when it holds one chord tone other than the root for most of a window (`_BASS_DOMINANCE`); writes `chords.json`; non-fatal on failure (0.92→0.96). The chroma is taken from the **sum of the extracted stems without `drums` and `vocals`** (`_harmonic_stem_paths`): drums are broadband noise to a chroma and a sung melody adds non-chord tones. At least one of `guitar` / `piano` / `other` has to be among them (`_CHORD_HARMONY_STEMS`) — a bass line alone names roots, not qualities — otherwise the original file is read instead, as before. Two limits: a single pass folds unrequested stems into `other`, so a song extracted as only `vocals` + `other` has its drums inside the harmonic mix; and `_chords_from_signal` weights every stem equally, so a very quiet stem barely counts
5. Bass tab transcription — only if a `bass` stem was extracted; writes `bass_tab.json`; non-fatal on failure (0.96→1.0). Read back by the `read_bass_tab` command (`library::read_bass_tab`: `None` when the file does not exist, an error when it does not parse) and shown by `BassTabPanel`; there is no flag on `Song`, the file's presence is the test. Note format: `{time, duration, pitch, string, fret}`, strings 0=E 1=A 2=D 3=G.

Returns `{ stems: {name: path}, duration, detectedBpm, detectedKey, chords, bassTab }` — the last two are booleans (whether each JSON file was successfully written), not the data itself; chords are fetched separately via `read_song_chords` once `Song.hasChords` is true.

### `import_yt`

Downloads a YouTube video as audio and runs it through the full `process` pipeline.

```json
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "outputDir": "/path/to/output/", "cookiesPath": null}
```

`cookiesPath` (optional) — absolute path to a user-exported Netscape-format `cookies.txt`; see the bot-detection fallback note below.

Implemented in `yt_importer.py` via `yt-dlp`. Steps:
1. Download best audio → `source.wav` (via FFmpegExtractAudio post-processor). Progress maps to 0–15%.
2. Run `processor.process(source_wav, output_dir)`. Progress maps to 15–100%.

Returns the same dict as `process`, with `"title"` added (from yt-dlp metadata).

**Bot-detection fallback:** if `cookiesPath` is set (Settings → YouTube cookies file, a user-exported Netscape-format `cookies.txt`), it's tried first via `cookiefile` — no dependency on a running browser. Otherwise (or if that file is missing/fails), first attempt uses no cookies; if YouTube returns a bot-check error, retries with `cookiesfrombrowser` cycling through Chrome → Firefox → Edge → Brave → Opera. Any other error (private video, bad URL, network failure) raises immediately. Partial output files are cleaned up between attempts.

**Where `cookiesPath` comes from:** Settings → YouTube account either signs in inside the app (`sign_in_youtube` writes `~/.songpracticestudio/youtube_cookies.txt`) or points at a cookies.txt the user exported; the sidecar just receives a path. A signed-in extraction also needs Deno and `yt-dlp-ejs` (bundled by `build.py`, located by `yt_importer._js_runtime_opts()`): see [youtube-signin.md](youtube-signin.md).

**Why `cookiesPath` exists:** live `cookiesfrombrowser` extraction is fragile on Windows — Chromium browsers (Chrome/Edge/Brave/Opera) encrypt their cookie store with a key only reliably reachable while that browser is running (Chrome 127+ "app-bound encryption"), and it only tries five hardcoded browser names, so anyone on a different browser (e.g. Ecosia — Chromium-based but not in the list) always falls through to the no-cookies attempt and gets bot-blocked. A one-time exported `cookies.txt` (e.g. via the "Get cookies.txt LOCALLY" extension) sidesteps this entirely. Ported from VPS 2026-08-14 — see MPS `wiki/known-issues.md`/`wiki/feature-parity.md`.

### `convert_take`

Decodes a take (webm/opus) via `librosa.load` and writes a WAV via `soundfile` — used by `export_take` so exported takes are always WAV.

```json
{"cmd": "convert_take", "recordingPath": "/path/to/take.webm", "outputPath": "/path/to/out.wav"}
```

### `normalize_take`

RMS-normalizes a recording's loudness against a reference stem (in practice `vocals.wav`), peak-capped so nothing clips, and writes the result as WAV (implemented in `recording.py`). Called by Rust's `save_take`; the normalized `{takeId}.wav` replaces the raw `.webm` on disk. This is why recorded takes match the mastered Demucs stems' loudness.

`audioOffset` (seconds of latency padding at the start of the file) only decides which part of the take the loudness is measured on; the written WAV is **not** trimmed, because the player itself skips `audioOffset` into the file (`fileTime = songTime - startPosition + audioOffset`). Before 2026-10-09 the file was trimmed here as well, so a take recorded from the very start of a song was skipped twice and sounded about one round-trip latency early.

```json
{"cmd": "normalize_take", "recordingPath": "/path/to/take.webm", "outputPath": "/path/to/take.wav", "referencePath": "/path/to/vocals.wav", "audioOffset": 0.0}
```

### `mix_export`

Renders a single mixdown WAV from a list of sources, honoring the frontend's live mute/solo/volume state and the punch/loop region (implemented in `recording.py`).

```json
{"cmd": "mix_export", "sources": [{"path": "...", "gain": 0.8, "isTake": false}, {"path": "...", "gain": 1.0, "isTake": true, "startPosition": 12.5, "audioOffset": 0.25}], "startSec": 10.0, "endSec": 42.0, "outputPath": "/path/to/mix.wav"}
```

Each source is loaded only over the `[startSec, endSec)` window; takes are aligned via `fileTime = projectTime - startPosition + audioOffset`. A take that begins *inside* the window is preceded by silence (before 2026-10-09 it slid to the window start whenever the window began before the take), and the first `audioOffset` seconds of its file are never played, matching live playback. Sources are resampled/upmixed to a common rate and channel count, summed with per-source gain, then peak-safe scaled before writing.

### `detect_chords`

Detects a song's chords again from its separated stems and writes `chords.json` (version 5: beat windows, Viterbi, per-chord `confidence`) to `outputPath`. Beats are tracked on every stem passed (the rhythm section when there is a `drums` stem), so the stems have to be the song's own. The stems are summed without `drums` and `vocals`, the same rule as step 4 of `process`; when the song has no stem that carries the harmony there is no original file to fall back to, so every stem is summed instead. The `bass` stem gives slash-chord bass notes. Used by the app's "Re-detect chords" button so songs imported before sevenths, slash chords or the drum/vocal exclusion existed can be upgraded without re-separating.

```json
{"cmd": "detect_chords", "stemPaths": {"other": "/song/other.wav", "bass": "/song/bass.wav"}, "outputPath": "/song/chords.json"}
```

Replies `{"segments": <count>}`; an empty `stemPaths` is an error.

### `pitch_shift`

Phase-vocoder pitch-shifts each requested stem by `nSteps` semitones (implemented in `processor.py`'s `pitch_shift_song()`), preserving tempo. Ported from VPS 2026-09-05, generalized from VPS's fixed vocals/instrumental pair to SPS's dynamic stem list — `stemNames` is whatever `song.stems` currently holds. Results are written to `cacheDir/{stem}.wav`; Rust's `pitch_shift_song` command checks that cache before sending this command at all.

```json
{"cmd": "pitch_shift", "songDir": "/path/to/song", "cacheDir": "/path/to/song/pitched/2", "stemNames": ["vocals", "drums", "bass"], "nSteps": 2}
```

### `align_tab`

Places the bars of a Guitar Pro tab on the song's timeline (`tab_sync.py`, see [Tab sync](tab-sync.md)). `scorePath` is the compact score the app built with alphaTab (played bars, tempo map, guitar/bass/keyboard/drum notes); `stemPaths` the song's stems that exist. Streams `progress` (`tab-features`, `audio-features`, `offset`, `alignment`, `done`). Writes the full result to `outputPath` atomically and replies with a summary.

```json
{"cmd": "align_tab", "scorePath": "/song/tab_score.json", "stemPaths": {"guitar": "/song/guitar.wav", "drums": "/song/drums.wav"}, "outputPath": "/song/tab_sync.json.new"}
```

Result: `{offset, transpose, quality, peak, steadiness, bars}`. Errors are plain messages (`Tab has no bars`, `The song has no guitar, bass, piano or other stem to compare the tab with`, `The song's stems are silent`, `The tab and the recording do not overlap`).

### `align_lyrics`

Aligns lyric text to a song's `vocals.wav` (`mps_core.lyrics`, ported from VPS 2026-10-10 and now shared, see [Lyrics Sync](lyrics.md)): CTC forced alignment over a wav2vec2 acoustic model, returning every line and word with start/end seconds. Streams `progress` (model download on first use, then the vocals processed in 20 s windows). The weights are fetched into `modelsDir` once; a file that fails to load is deleted so the next call re-downloads.

```json
{"cmd": "align_lyrics", "vocalsPath": "/path/to/vocals.wav", "lyrics": "line one\nline two", "modelsDir": "/home/u/.songpracticestudio/models"}
```

Result: `{aligner, lines: [{text, start, end, score, words: [{text, start, end, score}]}], meanScore, evidenceRatio, alignedWords, totalWords, warning}`. `warning` is non-null when the text probably does not fit the recording. Errors are plain messages: vocals missing/undecodable/silent, no words or no pronounceable letters in the text, text too long for the audio. `SPS_LYRICS_ENGINE=uniform` swaps in a model-free test engine; never set it outside tests.

### `find_lyrics`

Looks a song up on LRCLIB (`https://lrclib.net/api/search`, 20 s timeout). Titles are cleaned of video decoration (`(Official Video)`, `[HQ]`, `lyrics`) first, which matters here because SPS titles are raw YouTube titles and the library has no separate artist. Candidates are ranked by duration closeness (within 15 s), then synced-over-plain, then title overlap. When a synced version exists its timestamps are stripped and the text returned, because synced versions write repeated choruses out in full.

```json
{"cmd": "find_lyrics", "title": "Audioslave - Like a stone (HD)", "duration": 294.1}
```

Result: `{text, synced, title, artist, duration, source}` (`artist` is LRCLIB's, not SPS's).

### `ping` / `quit`

```json
{"cmd": "ping"}
{"cmd": "quit"}
```

## Libraries

| Library | Use |
|---------|-----|
| Demucs | Stem separation (`htdemucs_6s`, CPU or GPU) |
| librosa | BPM detection, key detection (chroma_cqt) |
| soundfile | Audio file I/O |
| numpy / scipy | Numerical operations |
| torch | Required by Demucs |
| yt-dlp | YouTube audio download with browser-cookie fallback |

## Synchronous Execution

The sidecar runs all commands on the main thread without background threads. This avoids GIL/numpy deadlocks on Windows. The Rust side holds the sidecar mutex lock for the entire duration of a command, preventing concurrent jobs.

## Building the Sidecar

`sidecar/build.py` packages the Python environment into a standalone executable using PyInstaller. The output binary must be copied to `src-tauri/binaries/` for Tauri to bundle it into the installer.

```powershell
cd sidecar
python build.py
copy dist\song-practice-studio-sidecar-x86_64-pc-windows-msvc.exe ..\src-tauri\binaries\
```

In development the sidecar runs as a raw Python process — Tauri spawns it lazily on first use.
