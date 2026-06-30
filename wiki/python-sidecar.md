# Python Sidecar

**Files:** `sidecar/main.py` · `sidecar/processor.py` · `sidecar/yt_importer.py` · `sidecar/build.py`

## Role

The Python sidecar handles computationally heavy audio processing:

- **Stem separation** — split a mixed audio file into up to 6 instrument stems via Demucs
- **BPM detection** — estimate tempo from the full mix
- **Key detection** — estimate musical key via chromagram

## IPC Protocol

Communication is **JSON lines** on stdin/stdout. Each message is a single JSON object terminated by `\n`. Stderr is not used for structured communication.

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

Separates a mixed audio file and extracts BPM and key.

```json
{"cmd": "process", "filePath": "/path/to/song.mp3", "outputDir": "/path/to/output/"}
```

Steps (`processor.py`):
1. Demucs `htdemucs_6s` → writes `vocals.wav`, `drums.wav`, `bass.wav`, `guitar.wav`, `piano.wav`, `other.wav` (progress 0→0.78)
2. BPM detection via `librosa.beat.tempo` on the original file (0.78→0.90)
3. Key detection via `chroma_cqt` on the first 60 seconds + Krumhansl-Kessler profiles (0.90→1.0)

Returns `{ stems: {name: path}, duration, detectedBpm, detectedKey }`.

### `import_yt`

Downloads a YouTube video as audio and runs it through the full `process` pipeline.

```json
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "outputDir": "/path/to/output/"}
```

Implemented in `yt_importer.py` via `yt-dlp`. Steps:
1. Download best audio → `source.wav` (via FFmpegExtractAudio post-processor). Progress maps to 0–15%.
2. Run `processor.process(source_wav, output_dir)`. Progress maps to 15–100%.

Returns the same dict as `process`, with `"title"` added (from yt-dlp metadata).

**Bot-detection fallback:** first attempt uses no cookies. If YouTube returns a bot-check error, retries with `cookiesfrombrowser` cycling through Chrome → Firefox → Edge → Brave → Opera. Any other error (private video, bad URL, network failure) raises immediately. Partial output files are cleaned up between attempts.

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
