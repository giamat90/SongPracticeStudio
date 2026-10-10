# Song Practice Studio (SPS)

A Tauri v2 desktop app that splits any song into instrument stems and turns it into a practice player. Drop an audio file or paste a YouTube URL, pick which of the 6 stems to extract (or take all of them), then listen back with per-stem mute/solo/volume, a loop/punch region, speed control with a phase-lockable metronome, chord labels synced to playback, and timeline zoom/pan. Record yourself over the mix with latency-compensated takes, export a mixdown of whatever's currently audible, or download everything — every stem plus every take — as one zip.

Forked from [**VPS**](../VPS) (Vocal Practice Studio), a vocal practice app with pitch/vibrato analysis and coaching. This fork traded that analysis stack for full-band multi-stem separation; recording was later reimplemented here independently for the multi-stem context. See `CLAUDE.md` for the full architecture writeup and `MPS/wiki/feature-parity.md` for exactly what's shared vs. diverged between the two.

## Architecture

- **Frontend**: React 19 + TypeScript (strict) + Vite + Zustand + WaveSurfer.js (one instance per stem)
- **Desktop shell**: Tauri v2 (Rust)
- **Backend**: Python sidecar, JSON-lines over stdin/stdout, spawned lazily on first use
- **Stem separation**: Demucs `htdemucs_6s` (6 stems: vocals, drums, bass, guitar, piano, other), with a cascaded high-quality mode
- **Chord detection**: chroma-template matching (major/minor triads) over the whole song, windowed at 1 s hops
- **Lyrics sync**: wav2vec2 CTC forced alignment of the lyric text to `vocals.wav` (`mps_core.lyrics`, shared with VPS)
- **BPM / key detection**: `librosa.beat.tempo` / chromagram + Krumhansl-Kessler profiles
- **Bass tab transcription**: the sidecar transcribes the bass stem to `bass_tab.json` during processing, but nothing in the Rust layer or UI reads it back yet on `master` — a scrolling-canvas viewer exists only on the unmerged `feat/bass-tab` branch

## Setup

### Prerequisites

- **Node 24+** (npm)
- **Rust 1.94.1+** (cargo)
- **Python 3.11+** (with venv)

### Quick Start

1. **Activate dev environment:**
   ```bash
   dev.bat   # Windows — puts cargo, node, and the Python venv on PATH
   ```

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
   The sidecar is **not** auto-started by this — it's spawned lazily on the first song processed or YouTube import.

## Project Structure

```
SPS/
├── src/                          # React frontend
│   ├── pages/                    # LibraryPage, AnalyzerPage
│   ├── components/
│   │   ├── player/                # StemView, StemTrack, TakeTrack, TempoControl,
│   │   │                          # TimeRuler, TransportControls, ChordCarousel/ChordRow, …
│   │   ├── recording/             # RecordButton, MicSelector, RecordingOffsetControl, TakeList
│   │   ├── upload/                # DropZone, YouTubeImport, StemPicker (stem selection + high-quality toggle)
│   │   └── updater/               # UpdateDialog
│   ├── stores/                   # Zustand: library, player, updater
│   ├── audio/                    # AudioEngine (dynamic stems Map + take), VocalRecorder, Metronome
│   └── lib/                      # tauri.ts, types.ts, chords.ts, lyrics.ts (zoomPan, metronomeSync etc. come from @giamat90/mps-core)
├── src-tauri/                     # Tauri shell & Rust backend
│   └── src/
│       ├── commands.rs            # process_song, import_youtube, save_take, export_mix, export_all, …
│       ├── library.rs             # Song/Folder persistence (library.json)
│       ├── takes.rs                # Take persistence (takes.json per song)
│       ├── sidecar.rs              # SidecarManager, JSON-lines IPC
│       └── storage.rs              # ~/.songpracticestudio/ path helpers
├── sidecar/                       # Python backend
│   ├── main.py                    # JSON-lines command dispatcher
│   ├── processor.py               # Demucs separation + BPM + key + chord detection
│   ├── recording.py               # take WAV conversion, RMS loudness normalization, mixdown rendering
│   ├── yt_importer.py             # yt-dlp download → processor.process()
│   └── requirements.txt
├── dev.bat                        # Dev environment setup
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── wiki/                          # Authoritative docs — architecture, components, data model, recording flow
```

## Features

- **Library**: upload or YouTube-import songs, organize into drag-and-drop folders, auto-update
- **Stem separation**: pick any subset of vocals/drums/bass/guitar/piano/other before processing; standard (`htdemucs_6s`) or high-quality cascaded mode
- **Player**: per-stem waveform with mute/solo/volume, loop/punch region, ctrl+wheel zoom / shift+wheel pan over the timeline
- **Speed & metronome**: BPM-first speed control, click track phase-locked to a draggable downbeat marker
- **Chords**: chord labels detected per song, scrolled in sync with playback
- **Lyrics**: paste lyrics or look them up on LRCLIB; they are force-aligned to the vocals stem and shown karaoke-style, click a line to jump there (downloads a ~360 MB speech model on first use)
- **Recording**: mic capture over the mix with per-device latency calibration (click-clap wizard), auto-stop at punch-out/song end, RMS loudness normalization against `vocals.wav`, manual take-sync nudging (drag or arrow keys)
- **Export**: mixdown of the live mix (honors mute/solo/volume/punch region), any stem or take individually, or everything as one zip

## Development

### Sidecar Protocol

Commands sent via stdin (JSON lines):
```json
{"cmd": "process", "filePath": "/path/to/song.mp3", "stemsToExtract": ["vocals","drums"], "highQuality": false}
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "highQuality": false}
```

Events received on stdout (JSON lines):
```json
{"type": "progress", "cmd": "process", "stage": "demucs", "value": 0.45}
{"type": "result", "cmd": "process", "data": {...}}
```

### Testing

1. Launch app: `npm run tauri dev`
2. Upload a song or paste a YouTube URL → stem separation runs, `library.json` updated
3. Analyzer page: play, mute/solo/volume per stem, loop a punch region, record a take
4. Select a take → sync it, export it, or delete it
5. Export Mix / Download All from the page header

### Type-check only

```bash
npx tsc --noEmit
```

## Build

```powershell
# 1. Build the Python sidecar (first time or after sidecar changes)
cd sidecar
python build.py
copy dist\song-practice-studio-sidecar-x86_64-pc-windows-msvc.exe ..\src-tauri\binaries\

# 2. Build the Tauri app
cd ..
npm run tauri build
```

Produces installers under `src-tauri/target/release/bundle/msi/` and `nsis/`, both named "Song Practice Studio" (bundle identifier `com.songpracticestudio.desktop`).

---

For the full architecture writeup, data model, and per-feature detail, see `CLAUDE.md` and `wiki/`.
