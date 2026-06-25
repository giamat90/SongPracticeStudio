# Song Analyzer — Claude Code Context

## What this project is

A Tauri v2 + React + TypeScript + Python desktop app.  
Drop any audio file (or paste a YouTube URL) → Demucs splits it into up to 6 instrument stems → multi-track player lets you listen, solo/mute via volume, loop a region, slow down, and download each stem as WAV.

Forked from **VPS** (`C:\Workspace\GiaMat90\VPS`) which is a vocal practice studio. Song Analyzer strips all recording/analysis/coaching features and repurposes the infrastructure for stem separation.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript (strict), Vite, Zustand |
| Desktop shell | Tauri v2 (Rust) |
| Audio rendering | WaveSurfer.js (one instance per stem) |
| Stem separation | Python sidecar via Demucs `htdemucs_6s` |
| IPC | JSON lines on stdin/stdout (Python ↔ Rust); `invoke()` (Rust ↔ TS) |

**Toolchain**: Rust 1.94.1, Node 24, Tauri v2. `cargo` requires PATH fix in bash — use PowerShell for Rust commands.

---

## Key architecture decisions

### Demucs model
`htdemucs_6s` — produces 6 stems: **vocals, drums, bass, guitar, piano, other**.  
Each is written as an individual `{name}.wav` in the song directory. Previous VPS used `htdemucs` (4 stems) and discarded non-vocal stems into a single `instrumental.wav`.

### Audio engine (`src/audio/engine.ts`)
Replaces the fixed `vocals`/`instrumental`/`take` WaveSurfer trio with a dynamic `Map<string, WaveSurfer>`.  
- First stem loaded (vocals if present) becomes the **master clock**.
- `interaction` events (user clicks only, not programmatic seeks) sync all other stems.
- rAF tick at 60fps; store notifications throttled to ~30fps.
- Loop logic lives in the tick: when `currentTime >= _loopEnd`, seeks to `_loopStart`.

### Player store (`src/stores/player.ts`)
`stemVolumes: Record<string, number>` holds per-stem volume (all default `1.0`).  
Punch region state (`punchIn`, `punchOut`, `punchLoop`) is shared with the TimeRuler — same pattern as VPS.  
No recording, no take, no transpose state.

### Processing pipeline (`sidecar/processor.py`)
Three stages:
1. Demucs separation → writes `{name}.wav` for each of the 6 stems (progress 0→0.78)
2. BPM detection via `librosa.beat.tempo` on the original file (0.78→0.90)
3. Key detection via chromagram + Krumhansl-Kessler profiles (0.90→1.0) — **no pitch extraction**, uses `chroma_cqt` on the first 60 seconds

Returns `{ stems: {name: path}, duration, detectedBpm, detectedKey }`.

### Song data model
```typescript
interface Song {
  id: string;
  title: string;
  duration: number;
  detectedBpm?: number;
  detectedKey?: string;
  processedAt: string;
  directory: string;
  stems: StemName[];   // e.g. ["vocals","drums","bass","guitar","piano","other"]
}
```
Persisted in `~/.local/share/song-analyzer/library.json` (managed by `src-tauri/src/library.rs`).

---

## Project structure

```
SongAnalyzer/
├── sidecar/
│   ├── processor.py      ← Demucs 6s + BPM + key; main pipeline
│   ├── yt_importer.py    ← yt-dlp download → processor.process()
│   ├── main.py           ← JSON-lines command dispatcher (process, import_yt, ping, quit)
│   └── requirements.txt
├── src/
│   ├── audio/engine.ts         ← AudioEngine: dynamic stems Map, rAF loop
│   ├── stores/player.ts        ← Zustand: stemVolumes, punch region, transport
│   ├── stores/library.ts       ← Zustand: song list, upload/import, progress
│   ├── lib/types.ts            ← Song, StemName, ProcessingStatus
│   ├── lib/tauri.ts            ← IPC wrappers: processSong, listSongs, deleteSong, importYoutube, exportStem
│   ├── components/
│   │   ├── player/
│   │   │   ├── StemView.tsx       ← TimeRuler + all StemTracks; loads engine on song.id change
│   │   │   ├── StemTrack.tsx      ← Single stem row: waveform + volume + download button
│   │   │   ├── TimeRuler.tsx      ← Canvas ruler with drag-to-create punch region
│   │   │   ├── TransportControls.tsx  ← Play/pause/stop + time display
│   │   │   └── TempoControl.tsx   ← Speed slider (0.5–2.0x)
│   │   └── upload/
│   │       ├── DropZone.tsx       ← File drag-and-drop → processSong
│   │       └── YouTubeImport.tsx  ← URL paste → importYoutube
│   ├── pages/
│   │   ├── LibraryPage.tsx    ← Song list + import; SongCard shows stem count
│   │   └── AnalyzerPage.tsx   ← Header + StemView + transport/tempo footer
│   └── App.tsx                ← Two-page router: library ↔ analyzer
└── src-tauri/src/
    ├── commands.rs   ← process_song, import_youtube, export_stem, list_songs, delete_song
    ├── library.rs    ← Song struct (includes stems: Vec<String>), library.json CRUD
    └── lib.rs        ← Tauri builder, invoke_handler registration
```

---

## GUI rule

**All dimensions must use relative units** (`%`, `rem`, `vw`, `vh`, `fr`). Never fixed `px` for layout. This is inherited from VPS and must be followed strictly.

---

## Stem colors

Defined in `src/audio/engine.ts → STEM_COLORS`:

| Stem | Color |
|---|---|
| vocals | `rgba(74,158,255,0.85)` blue |
| drums | `rgba(180,80,220,0.85)` purple |
| bass | `rgba(60,200,100,0.85)` green |
| guitar | `rgba(255,140,30,0.85)` orange |
| piano | `rgba(255,220,50,0.85)` yellow |
| other | `rgba(160,160,160,0.85)` gray |

---

## Common tasks

**Run in dev mode:**
```
npm run tauri dev
```

**Type-check only:**
```
npx tsc --noEmit
```

**Build sidecar (needed for release):**
```
cd sidecar && python build.py
```

**The sidecar is NOT auto-started by `beforeDevCommand`** — Tauri's `SidecarManager` spawns it lazily on first use (first song processed or YouTube import).

---

## What's NOT here (stripped from VPS)

- Vocal recording (RecordButton, MicSelector, VocalRecorder, save_take)
- Pitch analysis (PianoRoll, PianoKeyboard, DualTuner, analysis store)
- Take playback and management (TakeList, loadTakeTrack)
- Coaching panel (CoachPanel)
- Key transpose (KeyTranspose, pitch_shift_song)
- Output device selector (OutputSelector — device routing not needed without recording)
- Vibrato / timing / dynamics analysis cards

If any of these are needed, refer to `C:\Workspace\GiaMat90\VPS` for the implementation.

---

## Known open work

- Solo/mute buttons per stem (not yet implemented — volume slider covers it for now)
- The `guitar` icon in `StemTrack.tsx` reuses 🎸 for both guitar and bass; could differentiate
- No waveform error UI per stem (only a top-level `stem-view__error` div)
