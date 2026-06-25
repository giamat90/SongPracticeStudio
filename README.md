# Vocal Practice Studio (VPS)

A Tauri v2 desktop app for singers to practice vocals with AI-powered analysis and feedback.

## Architecture

- **Frontend**: React 19 + TypeScript + Vite + WaveSurfer.js
- **Desktop Shell**: Tauri v2 (Rust)
- **Backend**: Python sidecar (JSON-lines protocol)
- **State**: Zustand stores
- **Audio**: Web Audio API + librosa (onset detection) + torchcrepe (pitch extraction) + demucs (stem separation)

## Setup

### Prerequisites

- **Node 24+** (npm)
- **Rust 1.94.1+** (cargo)
- **Python 3.11+** (with venv)

### Quick Start

1. **Activate dev environment:**
   ```bash
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
VPS/
├── src/                          # React frontend
│   ├── pages/                    # LibraryPage, PracticeRoom
│   ├── components/
│   │   ├── analysis/             # PianoRoll, DualTuner, VibratoCard, etc.
│   │   ├── player/               # Waveform, TransportControls, etc.
│   │   ├── recording/            # RecordButton, TakeList, ABToggle
│   │   ├── upload/               # DropZone
│   │   └── coaching/             # CoachPanel
│   ├── stores/                   # Zustand: library, player, analysis
│   ├── audio/                    # AudioEngine, VocalRecorder, PitchDetector, analysisUtils
│   ├── lib/                      # tauri.ts, types.ts, constants.ts
│   └── styles/                   # global.css
├── src-tauri/                    # Tauri shell & Rust backend
│   └── src/
│       ├── commands.rs           # process_song, save_take, load_analysis, etc.
│       ├── lib.rs               # Command registration, state
│       ├── sidecar.rs           # SidecarManager, JSON-lines IPC
│       ├── library.rs           # Song persistence
│       └── storage.rs           # App data dir management
├── sidecar/                      # Python backend
│   ├── main.py                  # Command router (threaded worker)
│   ├── processor.py             # Song processing pipeline
│   ├── analysis.py              # Take analysis (pitch, onset, dynamics, vibrato)
│   └── requirements.txt
├── dev.bat                       # Dev environment setup
├── package.json                  # Node dependencies
├── tsconfig.json                # TypeScript config
├── vite.config.ts               # Vite + Tauri config
├── index.html                   # App root
└── README.md
```

## Features

### Phase 1 (Complete)
- Library: upload & manage songs
- Stem separation (Demucs)
- Practice room: dual waveforms, playback controls
- Recording: capture vocal takes
- A/B comparison: original vs. take

### Phase 2 (Complete)
- **Analysis visualizations:**
  - Piano roll: pitch contour overlay
  - Dynamics curve: RMS comparison
  - Vibrato metrics: rate/depth/evenness
  - Timing chart: onset deviation scatter
  - Dual tuner: real-time pitch needle
- **Coaching tips:** rule-based feedback on pitch, timing, vibrato, dynamics

## Development

### Key Technologies

- **Demucs v4.0.1**: Stem separation (htdemucs model)
- **torchcrepe**: Pitch extraction (CREPE algorithm)
- **librosa**: Onset detection, RMS dynamics, BPM, key detection
- **WaveSurfer.js v7**: Dual waveform visualization
- **Web Audio API**: Real-time autocorrelation pitch detector
- **MediaRecorder**: Vocal take recording (WebM/Opus)

### Sidecar Protocol

Commands sent via stdin (JSON lines):
```json
{"cmd": "process", "filePath": "/path/to/song.mp3"}
{"cmd": "analyze", "recordingPath": "/path/to/take.webm", "outputDir": "/path/to/song/dir"}
```

Events received on stdout (JSON lines):
```json
{"type": "progress", "cmd": "process", "stage": "demucs", "value": 0.45}
{"type": "result", "cmd": "process", "data": {...}}
```

## Testing

1. Launch app: `npm run tauri dev`
2. Upload a song → stem separation runs, analysis.json saved
3. Practice room: play + record
4. Select take → analysis loads, visualizations appear
5. Check coaching tips for feedback

## Build

```bash
npm run build
npm run tauri build
```

Creates standalone `.msi` installer for Windows.

---

Built with ❤️ for singers. Enjoy your practice session!
