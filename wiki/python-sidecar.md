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
4. Chord detection — windowed chroma → 24 major/minor chord-template matching (1s hops) over the whole song, writes `chords.json`; non-fatal on failure (0.92→0.96)
5. Bass tab transcription — only if a `bass` stem was extracted; writes `bass_tab.json`; non-fatal on failure (0.96→1.0). **Backend-only as of this writing** — nothing in `commands.rs`/`library.rs` reads `bass_tab.json` back or persists a flag for it (unlike chords, which get `has_chords` on `Song` + the `read_song_chords` command), and no frontend component consumes it on `master`; a viewer exists only on the unmerged `feat/bass-tab` branch.

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

### `pitch_shift`

Phase-vocoder pitch-shifts each requested stem by `nSteps` semitones (implemented in `processor.py`'s `pitch_shift_song()`), preserving tempo. Ported from VPS 2026-09-05, generalized from VPS's fixed vocals/instrumental pair to SPS's dynamic stem list — `stemNames` is whatever `song.stems` currently holds. Results are written to `cacheDir/{stem}.wav`; Rust's `pitch_shift_song` command checks that cache before sending this command at all.

```json
{"cmd": "pitch_shift", "songDir": "/path/to/song", "cacheDir": "/path/to/song/pitched/2", "stemNames": ["vocals", "drums", "bass"], "nSteps": 2}
```

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
