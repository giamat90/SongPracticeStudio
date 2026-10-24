# Song Practice Studio — Claude Code Context

## What this project is

A Tauri v2 + React + TypeScript + Python desktop app.  
Drop any audio file (or paste a YouTube URL) → Demucs splits it into up to 6 instrument stems → multi-track player lets you listen, mute/solo/volume per stem, loop a region, slow down, click along to a phase-lockable metronome, zoom/pan the timeline (ctrl+wheel / shift+wheel), record yourself over the mix (with latency compensation), export a mixdown of the live mix, download each stem as WAV, or download everything (all stems + all recorded takes) at once as a zip via `export_all`.

Forked from **VPS** (`C:\Workspace\GiaMat90\MPS\VPS`), a vocal practice studio. The fork originally stripped all recording/analysis/coaching features; **recording was later reimplemented** for the multi-stem context (commit `a9f0806`, v0.0.7) with its own latency-compensation model. Pitch analysis and coaching remain VPS-only.

---

## Architecture documents

**Every pull request updates them, in the same PR.** `CLAUDE.md`, the wiki pages it touches and `wiki/uml.md` (and `MPS/wiki/uml-architecture.md` / `shared-architecture.md` when the shared shape changed) are part of the PR; if no diagram is affected, the PR description says "UML: no change, because ...". MPS rule 22 (`MPS/wiki/conventions.md`).

---

## Shared code (`@giamat90/mps-core`)

Code that is identical in VPS and SPS lives in `github.com/giamat90/mps-core`, pinned by tag in `package.json` and `sidecar/requirements*.txt`: `metronome`, `recorder`, `countIn` (the count-in slice, plans and tempo), `metronomeSync`, `meter` (bar maps: where each bar starts, its pulses and unit, with the edits, tap fitting and the click cursor), `zoomPan`, `shortcuts` (global key handler), `loops` (named loops, bar sections), note/frequency maths (`music`), the updater store, the lyrics slice (types, timing, IPC wrappers, store), `createPanelStore` (headless show/hide store for optional panels), `windows` (the app-independent half of detachable panels), `youtube` (sign-in IPC wrappers, `cookiesSource`, `isSessionExpiredError`) plus the Rust crate `mps-youtube-signin` (the in-app YouTube sign-in, a Cargo git dependency pinned in `src-tauri/Cargo.toml`), and in the sidecar `mps_core.lyrics`, `mps_core.version_check` and `AppIdentity`. **Do not copy those back into this repository and do not edit them in `node_modules`**: change them in the mps-core repository, tag, and bump the pin here and in VPS. See `wiki/shared-core.md`.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript (strict), Vite, Zustand |
| Desktop shell | Tauri v2 (Rust) |
| Audio rendering | WaveSurfer.js (one instance per stem) |
| Stem separation | Python sidecar via Demucs `htdemucs_6s` |
| IPC | JSON lines on stdin/stdout (Python ↔ Rust); `invoke()` (Rust ↔ TS) |

**Adding an IPC command:** write the `#[tauri::command]` fn with a `///` doc (it becomes the JSDoc), add it to `generate_handler!` in `src-tauri/src/lib.rs`, run `npm run gen:ipc`, add a case to `src/lib/tauri.test.ts`. A new Rust struct or `serde_json::Value` return needs an entry in `scripts/ipc-types.json`; the generator fails loudly otherwise. `tests/contract/ipcContract.test.ts` names whichever step was forgotten.

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

### Player store (`src/stores/player/`)
One `usePlayerStore`, composed in `player/index.ts` from nine zustand slices (`transportSlice`, `mixerSlice`, `timelineSlice`, `devicesSlice`, `countInSlice`, `recordingSlice`, `takesSlice`, `chordsSlice`, `meterSlice`); see `wiki/components.md#player-store`. Shared pieces: `audioMix.ts` (pure gain/mix helpers + the take-audio subscription), `prefs.ts` (localStorage), `singletons.ts` (engine, recorder, recording session). The public surface is unchanged: `usePlayerStore`, `getEngine`, `buildMixSources`, `effectiveStemGain`, `takesSilenced`, `TAKE_TRACK_KEY`, `MAX_CAPO_FRET`, `CalibrationEntry`.
`stemVolumes: Record<string, number>` per-stem volume, `mutedStems: Record<string, boolean>` and `soloedStem: string | null` for the per-stem mute/solo buttons.  
Punch region state (`punchIn`, `punchOut`, `punchLoop`) is shared with the TimeRuler — same pattern as VPS.  
Recording state: `isRecording`, `isSavingTake`, `takes: Take[]`, `activeTakeId`, `takeVolume`, mic/output device selection, and `recordingOffsets: Record<string, CalibrationEntry>` (per-device latency calibration `{ offset, stale?, madMs? }`, localStorage-backed, with `usedLatencyFallback` set when recording starts without a usable calibration). Recording auto-stops when playback stops itself (punch-out or song end).  
`transpose`/`isTransposing` (ported from VPS): active semitone shift (±6) and in-flight flag for `setTranspose(semitones)`, which calls `pitch_shift_song(songDir, song.stems, nSteps)` (phase-vocoder, cached per song/semitone-count under `pitched/{n}/{stem}.wav`) then `AudioEngine.reloadStemsFromPaths()` to swap every loaded stem's file in place — see `wiki/audio-engine.md` and [MPS/wiki/lineage.md](../wiki/lineage.md). `KeyTranspose.tsx` renders the +/-/Reset control in `AnalyzerPage.tsx`'s topbar.  
Timeline zoom/pan state: `minPxPerSec` (zoom level, WaveSurfer's own px-per-second unit) and `scrollTime` (song time at the left edge of the visible window) — ctrl+wheel/shift+wheel over the stem timeline; see `wiki/audio-engine.md#timeline-zoompan`.  
`metronomeOffset` (song time (s) where the metronome's beat 1 lands, persisted per song via `set_metronome_offset`) — drag the downbeat marker on the TimeRuler, or "Set" to the current playhead, in `TempoControl`; see `wiki/components.md#tempocontrol`.  
`meterMap` (the open song's bars: `BarMap` from `@giamat90/mps-core/meter`, the user's own when `meterEdited`, else what `meter.json` held, null when never analysed), `meterHistory` (undo, 40 deep, in memory), `meterSelected`, `tapSession`, `clickDensity` and `applyMeter` / `undoMeter` / `resetMeter` / `detectMeter` / `startMeterFromGrid` / `startTapping`…: every change validates, updates the store and saves `meter_edited.json` in order. The ruler, the loops menu's bar sections, the metronome in `TempoControl` and the recording count-in read `meterMap` when it is set and behave as before when it is not; see `wiki/meter.md`.

### Processing pipeline (`sidecar/processor.py`)
Six stages:
1. Demucs separation → writes `{name}.wav` for each requested stem, model chosen by a stem-count cascade (no guitar/piano → single `htdemucs`(`_ft`) pass; guitar or piano requested → `htdemucs`(`_ft`) on the full mix then `htdemucs_6s` on the resulting "other" stem) (progress 0→0.75)
2. BPM detection via `librosa.beat.tempo` on the original file — **no pitch extraction** (0.75→0.86)
3. Key detection via `chroma_cqt` on the first 60 seconds + Krumhansl-Kessler profiles (0.86→0.92)
4. Chord detection — chroma-template matching (24 major/minor triads, plus 7 / maj7 / min7 when the seventh is clear, plus slash-chord bass notes from the bass stem) over the stems **without drums and vocals** (needs a guitar/piano/other stem, else the original file is read), one window per beat (`librosa.beat.beat_track` on drums + bass; a fixed 1 s grid when there is no usable pulse), decoded with Viterbi (switch cost + key prior) → `chords.json` v6 (each segment also carries a 0-1 `confidence`, the fit of the chosen chord, which the chord row dims when low, and `alternatives`, the six other chords the audio looked most like, for the editor's list; the document carries `tuning`, the recording's cents off A440, so a heard chord is in tune with it), non-fatal on failure (0.92→0.96). The user's corrections live apart in `chords_edited.json` and win when present (`ChordEditor`, `lib/chordEdit.ts`); re-detecting deletes them.
5. Bar finding (`sidecar/meter.py`, `stems-accent-v0`) — tracks the beats on drums + bass and cuts them into whole bars of 2 to 7 beats from the strongest downbeat → `meter.json` (a bar map: each bar's start, pulses and unit, `confidence`), non-fatal on failure (0.96→0.98). **A first guess, not an answer**: it misses the downbeat and the bar length often (see `wiki/meter-detection.md`); the Meter panel is where it is corrected, and the user's bars live apart in `meter_edited.json` and win (`wiki/meter.md`).
6. Bass tab transcription — only if a `bass` stem was extracted → `bass_tab.json`, non-fatal on failure (0.98→1.0). Read back by `read_bass_tab` (`None` for songs without one) and shown by `BassTabPanel`; "Export MIDI" writes it as a `.mid`.

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
  officialTitle?: string;   // what online lookups search for; `title` is the user's to rename
  officialArtist?: string;
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
│   ├── tab_sync.py       ← tab sync: place a Guitar Pro tab's bar lines on the recording (chroma + kick/snare DTW); see wiki/tab-sync.md
│   ├── main.py           ← JSON-lines command dispatcher (process, import_yt, convert_take, normalize_take, mix_export, pitch_shift, detect_chords, detect_meter, align_tab, align_lyrics, find_lyrics, search_lyrics, ping, quit)
│   ├── recording.py      ← take WAV conversion (convert_take_to_wav), RMS loudness normalization (normalize_take), mixdown rendering (mix_export)
│   ├── fetch_models.py   ← vendors htdemucs weights into the frozen build at build time
│   ├── smoke_test.py     ← standalone sanity script, not part of the main.py dispatch loop
│   ├── tab_chords.py     ← dev tool: a tab's MIDI export -> the app's tab score -> `tab_sync` alignment -> a Harte `.lab` chord chart from the notes played in each beat, for `chord_eval.py`; see wiki/testing.md#chord-accuracy
│   ├── meter.py          ← bar finding: beats → bar length and downbeat → `meter.json` (pipeline stage + `detect_meter`); a first guess, see wiki/meter-detection.md
│   ├── meter_lab/        ← dev workspace for the bar finder: reference bar maps from Guitar Pro tabs (`reference.py`), `benchmark.py`, a pulse-level probe, a feature cache; data local and gitignored
│   ├── chord_eval.py     ← dev tool: scores detected chords against a reference .lab chart (WCSR at root / majmin / sevenths); `--detect`, `--set NAME=VALUE`; see wiki/testing.md#chord-accuracy
│   ├── tests/            ← pytest suite (see wiki/testing.md); requirements-test.txt is its light dependency set
│   └── requirements.txt
├── tests/contract/    ← cross-language tests that read the TS and Rust sources (IPC command/argument contract)
│   ├── chord_lab/        ← dev workspace for the chord detector, like VPS's pitch_lab: benchmark with confidence intervals, tune/held-out sweep, plot of chroma + detected + reference chords, sonify; data sets (gitignored) in `datasets/`; read its README.md first
├── src/
│   ├── audio/
│   │   ├── engine.ts           ← AudioEngine: dynamic stems Map + take instance, rAF loop
│   │   ├── chordSynth.ts       ← organ-like Web Audio chord for auditioning (ChordEditor); own AudioContext, follows the output device
│   │   ├── liveInput.ts        ← the Monitor's input: opens the chosen device for analysis (no voice processing, loudest channel) and hands out the newest window
│   │   ├── liveMonitor.ts      ← the Monitor's 100 ms loop, everything injected: reads the input, analyses it, writes the notes into the trace, publishes the reading
│   ├── stores/
│   │   ├── player/             ← Zustand, one store built from slices: transport, mixer (volumes/mute/solo/transpose), timeline (punch, zoom, loops, metronome offset), devices (+ latency calibration), recording, takes, chords; plus audioMix/prefs/singletons helpers
│   │   ├── liveInputStore.ts   ← Zustand factory for the Monitor's state (off / starting / on / error, latest reading)
│   │   ├── liveInput.ts        ← the Monitor's store wired to the player store, plus `liveTrace` (the notes heard, by roll frame) and the registration of `liveMonitorGate`
│   │   ├── library.ts          ← Zustand: song list, upload/import, progress (`libraryStateCreator` from `@giamat90/mps-core/hooks` + this app's request shape)
│   │   ├── settings.ts         ← Zustand: youtubeCookiesPath (localStorage-persisted, `sps_settings`)
│   │   ├── panels.ts           ← which analyzer-page panels are visible (createPanelStore from mps-core, `sps_panels`)
│   │   ├── collapsed.ts        ← which panels are folded down to their title button (createCollapseStore from mps-core, `sps_collapsed`); `usePanelCollapse(id)`
│   │   └── waveforms.ts        ← whether the stem area and the bass tab are shown, and whether each stem is expanded or shrunk to its strip (`sps_waveforms`); hidden = collapsed, never unmounted
│   ├── windows/               ← detachable panels: SPS-specific state and commands on top of `@giamat90/mps-core/windows` (wiki/detachable-panels.md)
│   ├── lib/types.ts            ← Song, StemName, Take, ChordSegment, ProcessingStatus
│   ├── lib/tauri.ts            ← re-exports ipc.generated.ts + the event listeners (onProcessingProgress, onTabProgress)
│   ├── lib/ipc.generated.ts    ← GENERATED IPC wrappers (scripts/gen-ipc.mjs, `npm run gen:ipc`); never edit by hand
│   ├── lib/ipcTypes.ts         ← shapes that cross IPC and are not Rust-derived (MixSource, ZipExportEntry)
│   ├── lib/liveInput.ts        ← the Monitor's pure part: LiveAnalyser (spectrum + note strengths of a window), LiveTrace, liveFrameTime, describeInput
│   ├── lib/meterView.ts        ← the Meter panel's pure helpers: what a press on the lane hits, which bars an edit reaches, accent presets, parsing typed groups and patterns, the drums' hit envelope
│   ├── lib/chords.ts           ← useChordSegments hook + formatChordName/findActiveChordIndex helpers
│   ├── lib/lyrics.ts           ← canSyncLyrics only (SPS songs may lack the vocals stem); the rest of lyrics is @giamat90/mps-core/lyrics
│   ├── components/
│   │   ├── player/
│   │   │   ├── StemView.tsx       ← TimeRuler + all StemTracks + TakeTrack
│   │   │   ├── ExportMixButton.tsx ← export current mix as WAV (rendered in AnalyzerPage header)
│   │   │   ├── LoopsMenu.tsx      ← saved named loops, sections from the chords, bar sections (analyzer topbar)
│   │   │   ├── CapoSelect.tsx     ← capo fret (per song); chord displays and the sheet show the shapes (analyzer topbar)
│   │   │   ├── ChordDetailSelect.tsx ← Easy / Medium / Advanced: triads only, with sevenths, or everything incl. slash bass (one preference for every song; analyzer topbar)
│   │   │   ├── ExportChartButton.tsx ← chord sheet as .txt, with a capo choice (AnalyzerPage header)
│   │   │   ├── BassTabPanel.tsx   ← scrolling four-string bass tab + Export MIDI (below the stems)
│   │   │   ├── DownloadAllButton.tsx ← zip export of all stems + takes (rendered in AnalyzerPage header)
│   │   │   ├── LoopButton.tsx     ← punch-loop toggle
│   │   │   ├── ChordCarousel.tsx  ← "now/past/next" chord display (AnalyzerPage topbar)
│   │   │   ├── MeterPanel.tsx     ← the Meter panel (Panels menu "Meter"): source and readout, overview, lane, click density; with MeterLane (bars around the playhead, drag a bar line), MeterOverview (the song by signature), MeterEditor (count, accents, split, join, repeat a pattern, shift, tap along), useHitEnvelope (drums under the bars); see wiki/meter.md
│   │   │   ├── ChordRoll.tsx      ← the chord panel under the stems (Panels menu "Chord roll"): notes of each stem over time, a strip of chord buttons (click to correct, drag a handle to move a start, + to add), the spectrum section; not detachable (needs decoded audio)
│   │   │   ├── MonitorControl.tsx ← the Monitor switch in the chord roll's header: listens to the chosen input and draws it in pink on the notes and the spectrum against the song; level meter; the "You play C" readout is in the spectrum panel
│   │   │   ├── useNoteRoll.ts     ← loads the saved note strengths (`note_roll.json`) or analyses the decoded stems and saves them
│   │   │   ├── useChordCommit.ts  ← saving a chord correction (stored vs shown chords, `save_chord_edits`, refresh)
│   │   │   ├── ChordEditorHost.tsx ← the editor of the picked chord with its saving; hands its parts to the spectrum panel
│   │   │   ├── ChordEditor.tsx    ← Hear (synth, tuned to the recording), With song (loops the chord's stretch with the chord held under it), Go to / Start here / End here / Split / Join / Delete / Done, and drop-downs of the key's chords and of the detector's other guesses
│   │   │   ├── ChordSpectrumPanel.tsx ← the chord roll's spectrum: ticked stems over a chord's stretch or the playhead plus the spectrum of a synthetic candidate chord (root / quality / slash bass, Use), per-note readings (lib/chordSpectrum.ts); with the Monitor on, the live input as a pink curve and a "You play" readout
│   │   │   ├── StemTrack.tsx      ← Single stem row: waveform + mute/solo/volume + download button
│   │   │   ├── TakeTrack.tsx      ← Recorded take row, aligned at its startPosition
│   │   │   ├── TimeRuler.tsx      ← Canvas ruler with drag-to-create punch region
│   │   │   ├── TransportControls.tsx  ← skip, Stop, Play, Record (renders RecordButton), time display; Play counts in when the count-in is set
│   │   │   ├── CountInButton.tsx  ← ⏱ count-in bars (headless `useCountInButton`); counts in Play and Record
│   │   │   ├── TempoControl.tsx   ← BPM-first speed control + metronome toggle
│   │   │   ├── KeyTranspose.tsx   ← semitone transpose UI (ported from VPS)
│   │   │   └── OutputSelector.tsx ← Audio output device picker (ported from VPS)
│   │   ├── recording/
│   │   │   ├── RecordButton.tsx   ← Start/stop recording (rendered inside TransportControls, in the `--record` red, not the amber accent)
│   │   │   ├── MicSelector.tsx    ← Microphone input picker
│   │   │   ├── RecordingOffsetControl.tsx ← Latency calibration wizard (click-clap)
│   │   │   └── TakeList.tsx       ← Take list with select/rename/delete
│   │   ├── panels/
│   │   │   ├── PanelTitle.tsx     ← a panel's name as the button that folds it (the Lyrics panel's button)
│   │   │   └── PanelMenu.tsx      ← Panels menu in the analyzer header: tick which panels are shown; lists the stem area, its stems and the bass tab first
│   │   ├── tab/
│   │   │   ├── TabPanel.tsx       ← import a Guitar Pro tab, alignment state, track menu, correct a bar (below the stems; Panels menu "Tab")
│   │   │   └── TabScoreView.tsx   ← alphaTab notation with our own cursor from the stored bar times; click a beat to seek
│   │   ├── lyrics/
│   │   │   └── LyricsPanel.tsx    ← paste / find online / sync lyrics, karaoke view, click a line to seek (AnalyzerPage, below the stems)
│   │   ├── updater/
│   │   │   └── UpdateDialog.tsx   ← Auto-update modal
│   │   ├── settings/
│   │   │   └── YouTubeCookiesControl.tsx ← Sign in to YouTube (private window → cookies file, see wiki/youtube-signin.md) or pick a cookies.txt for import_youtube; avoids the flaky live-browser cookie fallback
│   │   └── upload/
│   │       ├── DropZone.tsx       ← File drag-and-drop → processSong
│   │       ├── YouTubeImport.tsx  ← URL paste → importYoutube
│   │       └── StemPicker.tsx     ← per-stem extraction toggle + high-quality checkbox, shared by both import paths
│   ├── pages/
│   │   ├── LibraryPage.tsx    ← Markup of the song list + import + About modal; SongCard shows stem count; state and drag logic are `useLibraryPage` etc. from `@giamat90/mps-core/hooks`
│   │   └── AnalyzerPage.tsx   ← Header + StemView + transport/tempo footer
│   └── App.tsx                ← Two-page router: library ↔ analyzer
└── src-tauri/src/
    ├── commands.rs   ← read_song_meter, has_meter_edits, save_meter_edits, clear_meter_edits, redetect_song_meter, process_song, import_youtube, read_song_chords, redetect_song_chords, cancel_lyrics_sync, read_bass_tab, export_file, export_stem, export_all, export_take, export_mix, save_take, list_takes, delete_take, rename_take, set_take_manual_offset, list_songs, delete_song, rename_song, set_song_identity, set_song_loops, set_metronome_offset, list_folders, create_folder, rename_folder, delete_folder, reorder_folders, move_songs, pitch_shift_song, load_lyrics, sync_lyrics, find_lyrics, search_lyrics, delete_lyrics, read_song_tab, import_song_tab, align_song_tab, save_tab_bars, delete_song_tab
    ├── meter.rs      ← the song's bars: meter.json (detected) and meter_edited.json (the user's, wins), validation that mirrors core's `validateMap`, atomic writes
    ├── tab.rs        ← tab sync: the stored tab file, tab_sync.json (atomic), validation of hand-corrected bar lines, the align_tab round trip
    ├── lyrics.rs     ← Lyrics structs, lyrics.json load/save/delete (atomic), sync_impl / find_impl (validate, then one sidecar round trip)
    ├── library.rs    ← Song struct (includes stems: Vec<String>, hasChords, folderId, sortIndex), Folder/ChordSegment structs, library.json CRUD, read_chords()
    ├── takes.rs      ← Take struct + takes.json CRUD (per song)
    ├── sidecar.rs     ← SidecarManager, JSON-lines IPC
    ├── youtube_signin.rs ← the two sign_in_youtube / sign_out_youtube commands, binding mps-core's `mps-youtube-signin` crate to ~/.songpracticestudio (the window, cookies file and the guard that bars it from the app's commands live in the crate)
    ├── storage.rs     ← ~/.songpracticestudio/ path helpers
    ├── windows.rs    ← detached panel windows: allowlist, creation, remembered geometry, `cursor_over_main`
    └── lib.rs        ← Tauri builder, invoke_handler registration
```

---

## GUI rule

**All dimensions must use relative units** (`%`, `rem`, `vw`, `vh`, `fr`). Never fixed `px` for layout. This is inherited from VPS and must be followed strictly.

---

## App palette

SPS shares VPS's navy base and differs only by accent: amber (`--accent #d97706`, `--accent-hover #f59e0b`) instead of VPS's coral-red, so the two apps are distinguishable side by side. Each app also has its own icon (`src-tauri/icons/`, generated with `tauri icon`). Tokens in `src/styles/global.css :root`; details in `wiki/ui-polish.md`. Do not paste VPS accent values when porting CSS.

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

## Synced lyrics (ported from VPS, 2026-10-10)

Paste lyrics or **Find online** (LRCLIB), then **Sync lyrics**: the text is force-aligned to `vocals.wav` and shown karaoke-style below the stems; clicking a line seeks to it. Needs the `vocals` stem (a song imported without it shows an explanation instead). The speech model (~360 MB) downloads once into `~/.songpracticestudio/models/`. Full detail, wire protocol, measured accuracy and limits: `wiki/lyrics.md`. The engine is `mps_core.lyrics` from the shared package; this app supplies its identity (user agent, `~/.songpracticestudio/models`, `SPS_LYRICS_ENGINE`) as an `AppIdentity` in `sidecar/main.py` (see `wiki/shared-core.md`).

---

## Tab sync (SPS only)

Import a Guitar Pro tab (`.gp`, `.gp3`-`.gp5`, `.gpx`, MusicXML) in the **Tab** panel under the stems; its bars are placed on the recording using the separated stems, and the tab follows the playhead (click a bar to seek, *Set bar to playhead* to correct one). alphaTab (`@coderline/alphatab`, MPL-2.0, pinned exact) reads and draws the file in the webview; the sidecar's `tab_sync.align_tab_to_stems` is the replaceable algorithm. Not in VPS (no guitar stems): see `MPS/wiki/feature-parity.md`. Full detail, measured accuracy and limits: `wiki/tab-sync.md`.

---

## Recording (reimplemented from the VPS concept, v0.0.7+)

Recording exists here — do not trust older docs claiming otherwise. Key points (full detail in `wiki/recording-flow.md`):

- `RecordButton` → `VocalRecorder` (`@giamat90/mps-core/recorder`) with a Web Audio **channel-fix graph** (splits/max-merges input channels so 2-in interfaces that route the mic to one physical channel don't lose ~6 dB to a stereo→mono downmix).
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
- Chord charts are text only (no PDF)
- Detected sections cannot tell a verse from a chorus that loops the same chords

---

## Versioning

Releases are tag-driven (`vX.Y.Z`; CI stamps the manifests). **Every version bump must add a `CHANGELOG.md` entry in the same `chore: release` commit** (package.json, src-tauri/tauri.conf.json, Cargo.toml, Cargo.lock, CHANGELOG.md). The release workflow publishes that entry as the GitHub release body and the in-app updater notes (`scripts/release-notes.sh`); a tag with no entry fails the build.
