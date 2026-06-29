# Song Analyzer

A Tauri v2 desktop app that separates any song into up to 6 instrument stems for analysis and practice.

## What it does

Drop an audio file or paste a YouTube URL → Demucs splits it into **vocals, drums, bass, guitar, piano, other** → multi-track player lets you listen, solo/mute via volume, loop a region, slow down, and download each stem as WAV.

## Architecture

- **Frontend**: React 19 + TypeScript + Vite + WaveSurfer.js
- **Desktop Shell**: Tauri v2 (Rust)
- **Backend**: Python sidecar (JSON-lines protocol)
- **State**: Zustand stores
- **Stem separation**: Demucs `htdemucs_6s` (6 stems)
- **Analysis**: librosa (BPM detection, key detection via chromagram)

## Setup

### Prerequisites

- **Node 24+** (npm)
- **Rust 1.94.1+** (cargo)
- **Python 3.11+** (with venv)

### Quick Start

1. **Activate dev environment:**
   ```bat
   dev.bat   # Windows
   ```
   This sets up PATH, venv, and Python env vars.

2. **Install dependencies:**
   ```bash
   npm install
   cd src-tauri && cargo fetch
   cd ../sidecar && pip install -r requirements.txt
   ```

3. **Run dev server:**
   ```bash
   npm run tauri dev
   ```

## Project Structure

```
SongAnalyzer/
├── src/                          # React frontend
│   ├── pages/                    # LibraryPage, AnalyzerPage
│   ├── components/
│   │   ├── player/               # StemView, StemTrack, TimeRuler, TransportControls, TempoControl
│   │   └── upload/               # DropZone, YouTubeImport
│   ├── stores/                   # Zustand: library, player
│   ├── audio/                    # AudioEngine (dynamic stems map)
│   └── lib/                      # tauri.ts, types.ts
├── src-tauri/                    # Tauri shell & Rust backend
│   └── src/
│       ├── commands.rs           # process_song, import_youtube, export_stem, list_songs, delete_song
│       ├── lib.rs                # Command registration, state
│       ├── sidecar.rs            # SidecarManager, JSON-lines IPC
│       ├── library.rs            # Song persistence
│       └── storage.rs            # App data dir (~/.songanalyzer/)
├── sidecar/                      # Python compute sidecar
│   ├── main.py                   # JSON-lines command dispatcher
│   ├── processor.py              # Demucs 6s + BPM + key detection
│   ├── yt_importer.py            # yt-dlp download → processor
│   └── requirements.txt
├── dev.bat                       # Dev environment setup (Windows)
├── package.json
├── index.html
└── README.md
```

## Build

```bash
npm run tauri build
```

Creates a standalone `.msi` installer for Windows.
