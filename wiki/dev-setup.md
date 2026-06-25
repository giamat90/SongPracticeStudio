# Dev Setup

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.94.1+ | Install via rustup |
| Node.js | 24+ | For Vite + npm |
| Python | 3.10+ | For the sidecar |
| WebView2 | — | Pre-installed on Windows 11 |

### Rust on Windows (PATH note)

When running Rust tools via bash (e.g., in a script or CI), `cargo` may not be on PATH. Add it explicitly:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

PowerShell automatically has it after a normal rustup install.

## Python Sidecar Setup

```powershell
cd sidecar
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

The sidecar is **not started by `npm run tauri dev`**. It is spawned lazily by Rust on the first command that needs it (e.g., when you drop a song file). In dev mode the sidecar runs as a raw Python process; in release mode it is a PyInstaller-bundled executable.

### Building the sidecar executable

```powershell
cd sidecar
.\.venv\Scripts\activate
python build.py
```

The output executable is written to the path Tauri expects (see `tauri.conf.json` `externalBin`).

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

```powershell
npm run tauri build
```

Output installers are placed in `src-tauri/target/release/bundle/`. Ensure the sidecar executable is built first.

## Project Structure

```
VPS/
├── src/                   React + TypeScript frontend
│   ├── audio/             AudioEngine + VocalRecorder
│   ├── components/        UI components (see Components wiki page)
│   ├── lib/               Tauri bindings + shared types
│   └── stores/            Zustand player store
├── src-tauri/             Rust backend
│   ├── src/
│   │   ├── main.rs        Tauri setup, command registration
│   │   ├── commands.rs    Tauri command handlers
│   │   ├── sidecar.rs     Python sidecar process manager
│   │   ├── library.rs     Song library management
│   │   └── storage.rs     Path helpers (~/.vps/)
│   └── tauri.conf.json    App config (window size, asset scope)
├── sidecar/               Python compute sidecar
│   ├── main.py            JSON-lines dispatch loop
│   ├── processor.py       Demucs separation + analysis
│   ├── analysis.py        Take analysis (pitch, onsets, dynamics)
│   └── build.py           PyInstaller build script
└── wiki/                  This documentation
```

## Audio Device Testing

To test recording with a USB audio interface (e.g., Behringer UM2):

1. Plug in the interface before starting the app.
2. In the app, open the microphone selector and choose the UM2 input (e.g., `"Line In (2-Behringer USB WDM Audio)"`).
3. Start recording — the app will automatically pin audio output to the UM2's headphone output to avoid the Windows Communications Device routing issue.

If you hear silence during recording, check the browser console for `[recording]` log lines showing which output device was selected.

## Tauri Permissions

The app uses these Tauri plugins / permissions (configured in `src-tauri/capabilities/`):

- `shell` — to spawn the Python sidecar
- `fs` — to read/write `~/.vps/`
- Asset protocol scope — to serve audio files to WebView2 via `tauri://localhost/`
