# Architecture

## Overview

Song Analyzer is a three-tier desktop application:

```
┌─────────────────────────────────────────────┐
│  React 19 + TypeScript (WebView2 / Vite)    │  UI layer
│  WaveSurfer.js · Zustand                    │
└──────────────────┬──────────────────────────┘
                   │  tauri::invoke()  (async IPC)
                   │  Tauri events     (push: processing-progress)
┌──────────────────▼──────────────────────────┐
│  Tauri v2 backend (Rust)                    │  Shell / FS layer
│  commands.rs · library.rs · storage.rs      │
└──────────────────┬──────────────────────────┘
                   │  JSON lines on stdin / stdout
┌──────────────────▼──────────────────────────┐
│  Python sidecar (subprocess)                │  Heavy compute
│  Demucs · librosa · soundfile               │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Tauri | 2.10.3 |
| Frontend build | Vite + TypeScript | latest |
| UI framework | React | 19 |
| Audio playback | WaveSurfer.js | 7 |
| State management | Zustand | latest |
| Backend language | Rust | 1.94.1+ |
| Compute sidecar | Python | 3.10+ |
| Stem separation | Demucs | htdemucs_6s (6 stems) |
| BPM detection | librosa | beat.tempo on full mix |
| Key detection | librosa | chroma_cqt + Krumhansl-Kessler |

## IPC Layers

### Frontend ↔ Tauri (invoke)

All frontend→backend calls use `invoke()` from `@tauri-apps/api/core`. The bindings live in `src/lib/tauri.ts`. Push events from Rust to frontend use `app.emit()` / `listen()` (e.g., `"processing-progress"`).

### Tauri ↔ Python (JSON lines)

The Rust backend spawns the Python sidecar as a child process (`SidecarManager` in `src-tauri/src/commands.rs`). Communication is newline-delimited JSON on stdin/stdout. The sidecar runs a synchronous dispatch loop to avoid GIL/numpy deadlocks on Windows. See [Python Sidecar](python-sidecar.md) for the message format.

## Startup Sequence

1. Tauri starts; `lib.rs` registers commands and creates `SidecarState` (initially empty).
2. WebView2 renders the React app via the Vite dev server (dev) or bundled `dist/` (release).
3. The Python sidecar is spawned **lazily** on the first command that needs it (e.g., `process_song`). It sends `{"type": "ready"}` when ready.
4. The user drops an audio file → `processSong` invoke → Rust sends `process` command to Python → Python runs Demucs `htdemucs_6s`, writes `vocals.wav`, `drums.wav`, `bass.wav`, `guitar.wav`, `piano.wav`, `other.wav` into `~/.songanalyzer/library/{songId}/`, then detects BPM and key, and responds with song metadata.

## Asset Serving

Audio files stored in `~/.songanalyzer/` are served to the frontend via Tauri's asset protocol (`tauri://localhost/...`). The scope is configured in `tauri.conf.json`:

```json
"assetProtocol": {
  "enable": true,
  "scope": ["$HOME/.songanalyzer/**", "$HOME\\.songanalyzer\\**"]
}
```

`convertFileSrc()` from `@tauri-apps/api/core` converts an absolute path to a valid `tauri://` URL for use in WaveSurfer.
