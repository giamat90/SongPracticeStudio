# Song Practice Studio — Claude Code Context

## What this project is

A Tauri v2 + React + TypeScript + Python desktop app.  
Drop any audio file (or paste a YouTube URL) → Demucs splits it into up to 6 instrument stems → multi-track player lets you listen, mute/solo/volume per stem, loop a region, slow down, click along to a phase-lockable metronome, zoom/pan the timeline (ctrl+wheel / shift+wheel), record yourself over the mix (with latency compensation), export a mixdown of the live mix, download each stem as WAV, or download everything (all stems + all recorded takes) at once as a zip via `export_all`.

Forked from **VPS** (`C:\Workspace\GiaMat90\MPS\VPS`), a vocal practice studio. The fork originally stripped all recording/analysis/coaching features; **recording was later reimplemented** for the multi-stem context (commit `a9f0806`, v0.0.7) with its own latency-compensation model. Pitch analysis and coaching remain VPS-only.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript (strict), Vite, Zustand |
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
- A recorded take loads as one extra instance via `loadTakeTrack(path, container, startOffset, audioOffset)`, aligned to song time with `_takeOffset`/`_takeAudioOffset` (same mapping as VPS: `fileTime = songTime - startOffset + audioOffset`).
- `setOutputDevice(deviceId)` re-routes every instance (and future ones) via `setSinkId`.

### Player store (`src/stores/player.ts`)
`stemVolumes: Record<string, number>` per-stem volume, `mutedStems: Record<string, boolean>` and `soloedStem: string | null` for the per-stem mute/solo buttons.  
Punch region state (`punchIn`, `punchOut`, `punchLoop`) is shared with the TimeRuler — same pattern as VPS.  
Recording state: `isRecording`, `isSavingTake`, `takes: Take[]`, `activeTakeId`, `takeVolume`, mic/output device selection, and `recordingOffsets: Record<string, CalibrationEntry>` (per-device latency calibration `{ offset, stale?, madMs? }`, localStorage-backed, with `usedLatencyFallback` set when recording starts without a usable calibration). Recording auto-stops when playback stops itself (punch-out or song end).  
`transpose`/`isTransposing` (ported from VPS): active semitone shift (±6) and in-flight flag for `setTranspose(semitones)`, which calls `pitch_shift_song(songDir, song.stems, nSteps)` (phase-vocoder, cached per song/semitone-count under `pitched/{n}/{stem}.wav`) then `AudioEngine.reloadStemsFromPaths()` to swap every loaded stem's file in place — see `wiki/audio-engine.md` and [MPS/wiki/lineage.md](../wiki/lineage.md). `KeyTranspose.tsx` renders the +/-/Reset control in `AnalyzerPage.tsx`'s topbar.  
Timeline zoom/pan state: `minPxPerSec` (zoom level, WaveSurfer's own px-per-second unit) and `scrollTime` (song time at the left edge of the visible window) — ctrl+wheel/shift+wheel over the stem timeline; see `wiki/audio-engine.md#timeline-zoompan`.  
`metronomeOffset` (song time (s) where the metronome's beat 1 lands, persisted per song via `set_metronome_offset`) — drag the downbeat marker on the TimeRuler, or "Set" to the current playhead, in `TempoControl`; see `wiki/components.md#tempocontrol`.

### Processing pipeline (`sidecar/processor.py`)
Five stages:
1. Demucs separation → writes `{name}.wav` for each requested stem, model chosen by a stem-count cascade (no guitar/piano → single `htdemucs`(`_ft`) pass; guitar or piano requested → `htdemucs`(`_ft`) on the full mix then `htdemucs_6s` on the resulting "other" stem) (progress 0→0.75)
2. BPM detection via `librosa.beat.tempo` on the original file — **no pitch extraction** (0.75→0.86)
3. Key detection via `chroma_cqt` on the first 60 seconds + Krumhansl-Kessler profiles (0.86→0.92)
4. Chord detection — chroma-template matching (24 major/minor triads, 1s hops) over the whole song → `chords.json`, non-fatal on failure (0.92→0.96)
5. Bass tab transcription — only if a `bass` stem was extracted → `bass_tab.json`, non-fatal on failure (0.96→1.0). **Backend-only**: no Rust command or frontend component reads it back yet on `master` (unlike chords — see below); a viewer exists only on the unmerged `feat/bass-tab` branch.

Returns `{ stems: {name: path}, duration, detectedBpm, detectedKey, chords, bassTab }` — `chords`/`bassTab` are booleans (file written or not); actual chord data is fetched separately via `read_song_chords(songId)` once `Song.hasChords` is true.

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
  hasChords?: boolean; // true if chords.json was written — see read_song_chords
  folderId?: string | null; // library folder this song belongs to; null/absent = root
  sortIndex: number;        // rank among sibling songs sharing the same folderId
}

interface Folder {           // flat, user-named grouping of songs (e.g. all songs by one band)
  id: string;
  name: string;
  sortIndex: number;
}
```
Persisted in `~/.songpracticestudio/library.json` (top-level shape `{ folders: Folder[], songs: Song[] }`, with a legacy-raw-array fallback on read — see `wiki/data-model.md#storage-layout`); stem WAVs in `~/.songpracticestudio/library/{song_id}/` (managed by `src-tauri/src/storage.rs` + `library.rs`). Folder drag-and-drop (create/rename/delete/reorder folders, drag songs to reorder/move) lives in `LibraryPage.tsx` via `@dnd-kit` — see `wiki/components.md#library-folders-drag-and-drop`.

### Take data model
```typescript
interface Take {
  id: string;
  songId: string;
  recordedAt: string;
  filepath: string;       // RMS-normalized .wav (raw .webm only if normalization failed)
  name?: string;          // user-assigned; UI falls back to "Take N"
  startPosition: number;  // song time (s) where recording began; 0 = full-song
  audioOffset?: number;   // seconds into the file to skip (latency compensation overflow)
}
```
Persisted in `takes.json` inside the song directory; audio in `takes/{takeId}.wav`. At save time the Rust `save_take` command calls the sidecar `normalize_take` to RMS-match the take's loudness against `vocals.wav` (peak-capped).

---

## Project structure

```
SongPracticeStudio/
├── sidecar/
│   ├── processor.py      ← Demucs 6s + BPM + key + chords + bass tab (main pipeline) + pitch_shift_song (transpose)
│   ├── yt_importer.py    ← yt-dlp download → processor.process()
│   ├── main.py           ← JSON-lines command dispatcher (process, import_yt, convert_take, normalize_take, mix_export, pitch_shift, ping, quit)
│   ├── recording.py      ← take WAV conversion (convert_take_to_wav), RMS loudness normalization (normalize_take), mixdown rendering (mix_export)
│   ├── fetch_models.py   ← vendors htdemucs weights into the frozen build at build time
│   ├── version_check.py  ← proactive + reactive yt-dlp staleness checks (see MPS/wiki/known-issues.md)
│   ├── smoke_test.py     ← standalone sanity script, not part of the main.py dispatch loop
│   ├── tests/            ← pytest suite (see wiki/testing.md); requirements-test.txt is its light dependency set
│   └── requirements.txt
├── tests/contract/    ← cross-language tests that read the TS and Rust sources (IPC command/argument contract)
├── src/
│   ├── audio/
│   │   ├── engine.ts           ← AudioEngine: dynamic stems Map + take instance, rAF loop
│   │   ├── recorder.ts         ← VocalRecorder (MediaRecorder wrapper, Web Audio channel-fix graph)
│   │   └── metronome.ts        ← Metronome class (Web Audio lookahead-scheduled click track)
│   ├── stores/
│   │   ├── player.ts           ← Zustand: stemVolumes/mute/solo, punch region, transport, recording, latency calibration
│   │   ├── library.ts          ← Zustand: song list, upload/import, progress
│   │   ├── updater.ts          ← Zustand: auto-update state (tauri-plugin-updater)
│   │   └── settings.ts         ← Zustand: youtubeCookiesPath (localStorage-persisted, `sps_settings`)
│   ├── lib/types.ts            ← Song, StemName, Take, ChordSegment, ProcessingStatus
│   ├── lib/tauri.ts            ← IPC wrappers: processSong, listSongs, saveTake, exportStem, exportMix, …
│   ├── lib/zoomPan.ts          ← pure zoom-to-cursor / pan math for timeline ctrl+wheel/shift+wheel (byte-identical to VPS)
│   ├── lib/metronomeSync.ts    ← pure phase-lock math for the metronome downbeat anchor (byte-identical to VPS)
│   ├── lib/chords.ts           ← useChordSegments hook + formatChordName/findActiveChordIndex helpers
│   ├── components/
│   │   ├── player/
│   │   │   ├── StemView.tsx       ← TimeRuler + all StemTracks + TakeTrack
│   │   │   ├── ExportMixButton.tsx ← export current mix as WAV (rendered in AnalyzerPage header)
│   │   │   ├── DownloadAllButton.tsx ← zip export of all stems + takes (rendered in AnalyzerPage header)
│   │   │   ├── LoopButton.tsx     ← punch-loop toggle
│   │   │   ├── ChordCarousel.tsx  ← "now/past/next" chord display (AnalyzerPage topbar)
│   │   │   ├── ChordRow.tsx       ← chord segments as timeline chips (inside StemView)
│   │   │   ├── StemTrack.tsx      ← Single stem row: waveform + mute/solo/volume + download button
│   │   │   ├── TakeTrack.tsx      ← Recorded take row, aligned at its startPosition
│   │   │   ├── TimeRuler.tsx      ← Canvas ruler with drag-to-create punch region
│   │   │   ├── TransportControls.tsx  ← Play/pause/stop + time display
│   │   │   ├── TempoControl.tsx   ← BPM-first speed control + metronome toggle
│   │   │   ├── KeyTranspose.tsx   ← semitone transpose UI (ported from VPS)
│   │   │   └── OutputSelector.tsx ← Audio output device picker (ported from VPS)
│   │   ├── recording/
│   │   │   ├── RecordButton.tsx   ← Start/stop recording
│   │   │   ├── MicSelector.tsx    ← Microphone input picker
│   │   │   ├── RecordingOffsetControl.tsx ← Latency calibration wizard (click-clap)
│   │   │   └── TakeList.tsx       ← Take list with select/rename/delete
│   │   ├── updater/
│   │   │   └── UpdateDialog.tsx   ← Auto-update modal
│   │   ├── settings/
│   │   │   └── YouTubeCookiesControl.tsx ← optional cookies.txt picker for import_youtube, avoids the flaky live-browser cookie fallback
│   │   └── upload/
│   │       ├── DropZone.tsx       ← File drag-and-drop → processSong
│   │       ├── YouTubeImport.tsx  ← URL paste → importYoutube
│   │       └── StemPicker.tsx     ← per-stem extraction toggle + high-quality checkbox, shared by both import paths
│   ├── pages/
│   │   ├── LibraryPage.tsx    ← Song list + import + About modal; SongCard shows stem count
│   │   └── AnalyzerPage.tsx   ← Header + StemView + transport/tempo footer
│   └── App.tsx                ← Two-page router: library ↔ analyzer
└── src-tauri/src/
    ├── commands.rs   ← process_song, import_youtube, read_song_chords, export_stem, export_all, export_take, export_mix, save_take, list_takes, delete_take, rename_take, set_take_manual_offset, list_songs, delete_song, set_metronome_offset, list_folders, create_folder, rename_folder, delete_folder, reorder_folders, move_songs, pitch_shift_song
    ├── library.rs    ← Song struct (includes stems: Vec<String>, hasChords, folderId, sortIndex), Folder/ChordSegment structs, library.json CRUD, read_chords()
    ├── takes.rs      ← Take struct + takes.json CRUD (per song)
    ├── sidecar.rs     ← SidecarManager, JSON-lines IPC
    ├── storage.rs     ← ~/.songpracticestudio/ path helpers
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

**Set up dev environment (run once per terminal session):**
```
dev.bat
```
Opens a `cmd` shell with `cargo`, `node`, and the Python venv all on PATH. Required before any `cargo` or `npm run tauri` commands.

**Run in dev mode:**
```
npm run tauri dev
```

**Type-check only:**
```
npx tsc --noEmit
```

**Tests** (details in `wiki/testing.md`):
```
npm test                                   # vitest: libs, audio engine, stores, IPC contract
cd src-tauri && cargo test --lib           # Rust, incl. the real Python sidecar driven through the command bodies
cd sidecar && python -m pytest             # sidecar DSP, pipeline (Demucs faked), stdio protocol
```

**Build for release (Windows):**
```powershell
# 1. Build the Python sidecar (first time or after sidecar changes)
cd sidecar
python build.py
copy dist\song-practice-studio-sidecar-x86_64-pc-windows-msvc.exe ..\src-tauri\binaries\

# 2. Build the Tauri app
cd ..
npm run tauri build
```
Output: `src-tauri/target/release/bundle/msi/` and `nsis/` — both produce an installer named "Song Practice Studio".

> Bundle identifier `com.songpracticestudio.desktop` — use this for all platforms.

**Build sidecar only:**
```
cd sidecar && python build.py
```

**The sidecar is NOT auto-started by `beforeDevCommand`** — Tauri's `SidecarManager` spawns it lazily on first use (first song processed or YouTube import).

---

## Recording (reimplemented from the VPS concept, v0.0.7+)

Recording exists here — do not trust older docs claiming otherwise. Key points (full detail in `wiki/recording-flow.md`):

- `RecordButton` → `VocalRecorder` (`src/audio/recorder.ts`) with a Web Audio **channel-fix graph** (splits/max-merges input channels so 2-in interfaces that route the mic to one physical channel don't lose ~6 dB to a stereo→mono downmix).
- Per-device **latency calibration** (`RecordingOffsetControl.tsx`, click-clap wizard): `recordingOffsets` entries `{ offset, stale?, madMs? }` with devicechange staleness invalidation, MAD-based confidence chip, 0–500 ms and ≥5/8-onset sanity bounds. Unlike VPS there is **no per-recording output routing**, so no `outputDeviceId` on calibration entries.
- Recording **auto-stops** when playback stops itself (punch-out reached, or song end).
- Takes are **RMS-normalized** against `vocals.wav` at save time (sidecar `normalize_take`).
- Take plays back as an extra engine track aligned at `startPosition`/`audioOffset` (`TakeTrack.tsx`).

---

## What's NOT here (still VPS-only)

- Pitch analysis (PianoRoll, PianoKeyboard, DualTuner, analysis store, SRH sidecar)
- Coaching panel (CoachPanel)
- Vibrato / timing / dynamics analysis cards
- Short-Term Spectrum / spectrogram panels
- Free Exercise mode (song-less recording)
- Instrument-only import (`kind: "instrument"`, skips separation)

If any of these are needed, refer to `C:\Workspace\GiaMat90\MPS\VPS` for the implementation — and check `MPS/wiki/feature-parity.md` first for porting notes.

---

## Known open work

- The `guitar` icon in `StemTrack.tsx` reuses 🎸 for both guitar and bass; could differentiate
- No waveform error UI per stem (only a top-level `stem-view__error` div)
- Bass tab transcription runs on every `process` call (`sidecar/processor.py`) and writes `bass_tab.json`, but no Rust command or frontend component reads it back — a viewer exists only on the unmerged `feat/bass-tab` branch (`ee54b89`)
