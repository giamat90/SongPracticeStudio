# Dev Setup

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.94.1+ | Install via rustup |
| Node.js | 24+ | For Vite + npm |
| Python | 3.10+ | For the sidecar |
| WebView2 | — | Pre-installed on Windows 11 |

## Environment Setup — `dev.bat`

Run `dev.bat` at the start of every terminal session. It adds `cargo`, `npm`, and the Python venv to PATH, sets `PYTHONWARNINGS=ignore` and `TOKENIZERS_PARALLELISM=false`, then opens a `cmd` shell ready to go:

```
dev.bat
```

Without this, `npm run tauri build` / `npm run tauri dev` will fail with `cargo not found`.

## Python Sidecar Setup

One-time setup (after cloning or on a new machine):

```powershell
cd sidecar
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

The sidecar is **not started by `npm run tauri dev`**. It is spawned lazily by Rust on the first command that needs it (e.g., when you drop a song file). In dev mode the sidecar runs as a raw Python process; in release mode it is a PyInstaller-bundled executable.

## Running in Development

```powershell
npm install          # first time only
npm run tauri dev
```

This starts:
1. Vite dev server on `http://localhost:5173`
2. Tauri shell (Rust) pointing WebView2 at the dev server

Hot reload works for React/TypeScript changes. Rust changes require a full restart (`Ctrl+C` → `npm run tauri dev`).

## Building for Release

Build the Python sidecar first (required — Tauri bundles it into the installer):

```powershell
cd sidecar
python build.py
copy dist\song-analyzer-sidecar-x86_64-pc-windows-msvc.exe ..\src-tauri\binaries\
cd ..
```

Then build the Tauri app:

```powershell
npm run tauri build
```

Output installers are placed in `src-tauri/target/release/bundle/`:

```
msi\Song Analyzer_0.1.0_x64_en-US.msi
nsis\Song Analyzer_0.1.0_x64-setup.exe
```

The NSIS installer bundles the WebView2 redistributable and is the safer choice for distribution. The MSI does not include WebView2.

> If you get `cargo not found`, run `dev.bat` first.

## Project Structure

```
SongAnalyzer/
├── src/                   React + TypeScript frontend
│   ├── audio/             AudioEngine (dynamic stems Map, rAF loop)
│   ├── components/        UI components (player/, upload/)
│   ├── lib/               Tauri IPC bindings + shared types
│   ├── pages/             LibraryPage, AnalyzerPage
│   └── stores/            Zustand player + library stores
├── src-tauri/             Rust backend
│   ├── src/
│   │   ├── main.rs        Tauri entry point
│   │   ├── lib.rs         Command registration
│   │   ├── commands.rs    Tauri command handlers
│   │   ├── library.rs     Song library CRUD + library.json
│   │   └── storage.rs     Path helpers (~/.songanalyzer/)
│   ├── binaries/          Compiled sidecar executable (git-ignored)
│   └── tauri.conf.json    App config (window size, asset scope)
├── sidecar/               Python compute sidecar
│   ├── main.py            JSON-lines dispatch loop
│   ├── processor.py       Demucs separation + BPM + key detection
│   ├── yt_importer.py     yt-dlp download → processor.process()
│   ├── build.py           PyInstaller build script
│   └── requirements.txt
├── dev.bat                Dev environment setup (PATH + venv)
└── wiki/                  This documentation
```

## Tauri Permissions

The app uses these Tauri plugins / permissions:

- `shell` — to spawn the Python sidecar
- `fs` — to read/write `~/.songanalyzer/`
- Asset protocol scope — to serve audio files to WebView2 via `tauri://localhost/`
