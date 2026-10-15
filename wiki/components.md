# Frontend Components

**Directory:** `src/components/`

## Component Tree

```
App
├── LibraryPage
│   ├── DropZone           — drag-and-drop audio file import
│   │   └── StemPicker     — pick which of the 6 stems to extract + high-quality toggle
│   ├── YouTubeImport      — paste-and-import YouTube URL
│   ├── SongCard           — song list item with stem count + delete
│   └── About modal        — version/info dialog
├── AnalyzerPage
│   ├── header
│   │   ├── DownloadAllButton  — zip export of every stem + every take
│   │   └── ExportMixButton    — render the audible mix (mute/solo/volume/punch) to WAV
│   ├── topbar (fixed)
│   │   ├── TransportControls  — play/pause/stop + current time display
│   │   ├── LoopButton         — punch-loop toggle
│   │   ├── TempoControl       — BPM-first speed control
│   │   ├── KeyTranspose       — semitone transpose control (ported from VPS)
│   │   ├── MicSelector        — microphone input picker
│   │   ├── OutputSelector     — audio output device picker (ported from VPS)
│   │   ├── RecordButton       — start/stop recording
│   │   └── ChordCarousel      — gauge-dial-style "now/past/next" chord display
│   ├── StemView            — orchestrates TimeRuler + all StemTracks + TakeTrack; loads AudioEngine
│   │   ├── TimeRuler       — canvas time ruler with drag-to-select punch/loop region
│   │   ├── ChordRow        — chord segments as timeline chips, synced to zoom/scroll
│   │   ├── StemTrack (×N)  — one row per stem: waveform + mute/solo + volume + download button
│   │   └── TakeTrack       — recorded take row, aligned at its startPosition
│   ├── LyricsPanel         — synced lyrics: paste / find online / sync, karaoke view, click a line to seek (below the stems list and bass tab, above the takes, in its own scroller; explains itself when the song has no vocals stem)
│   └── TakeList            — take list with select/rename/delete
│       └── RecordingOffsetControl — per-device latency calibration wizard
└── UpdateDialog            — auto-update modal (tauri-plugin-updater)
```

## State Management

### Library Store (`src/stores/library.ts`)

Manages the song list, import/upload flow, and error state.

| Field | Type | Description |
|-------|------|-------------|
| `songs` | `Song[]` | All songs in the library |
| `folders` | `Folder[]` | All folders in the library |
| `processing` | `ProcessingStatus \| null` | Active processing job (null when idle) |
| `isLoading` | `boolean` | Initial fetch in progress |
| `error` | `string \| null` | Last friendly error message |

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `deleteSong`, `renameSong`, `fetchFolders`, `createFolder`, `renameFolder`, `deleteFolder`, `reorderFolders`, `moveSongs`, `clearError`, `initProgressListener`. `renameSong` calls `rename_song` and swaps in the returned song (double-click the title or the ✎ button on a song card; empty titles are rejected by the backend). See [Library Folders](#library-folders-drag-and-drop) below for the folder-related actions.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages.

### Lyrics Store (`useLyricsStore` from `@giamat90/mps-core/lyrics`)

`{ songId, lyrics, draft, draftSource, status: "idle"|"loading"|"finding"|"syncing", progress, stage, error, notice }` with `load`, `setDraft`, `findOnline`, `sync`, `remove`, `clear`. Every async action re-checks `songId` before writing, so a result for a song that is no longer open is dropped. Pure timing logic (`activeLineIndex`, `activeWordIndex`, `lineSeekTime`, `canSyncLyrics`) is in `src/lib/lyrics.ts`. Ported from VPS, see [Lyrics Sync](lyrics.md).

### Player Store (`src/stores/player.ts`)

All player state lives in a single Zustand store.

```ts
import { usePlayerStore } from "../../stores/player";

const isPlaying = usePlayerStore((s) => s.isPlaying);
const togglePlay = usePlayerStore((s) => s.togglePlay);
```

| Field | Type | Description |
|-------|------|-------------|
| `song` | `Song \| null` | Currently loaded song |
| `isPlaying` | `boolean` | Playback state |
| `currentTime` | `number` | Playback position (seconds) |
| `duration` | `number` | Song length (seconds) |
| `playbackRate` | `number` | Speed multiplier (0.5–2.0) |
| `stemVolumes` | `Record<string, number>` | Per-stem volume 0–1 (all default 1.0) |
| `mutedStems` | `Record<string, boolean>` | Per-stem mute toggles |
| `soloedStem` | `string \| null` | Currently soloed stem (mutes all others) |
| `punchIn` | `number \| null` | Loop region start (seconds) |
| `punchOut` | `number \| null` | Loop region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |
| `audioDevices` / `selectedDeviceId` | | Microphone enumeration + selection |
| `outputDevices` / `selectedOutputDeviceId` | | Output device enumeration + selection |
| `isRecording` / `isSavingTake` | `boolean` | Recording lifecycle flags |
| `takes` / `activeTakeId` / `takeVolume` | | Recorded takes + active selection |
| `recordingOffsets` | `Record<string, CalibrationEntry>` | Per-device latency calibration `{ offset, stale?, madMs? }`, localStorage-backed |
| `usedLatencyFallback` | `boolean` | True when recording started without a usable calibration |
| `minPxPerSec` | `number` | Timeline zoom level (WaveSurfer's own px-per-second unit); ctrl+wheel changes this |
| `scrollTime` | `number` | Song time (seconds) at the left edge of the visible timeline window; shift+wheel changes this |
| `metronomeOffset` | `number` | Song time (seconds) where the metronome's beat 1 lands; persisted per song via `set_metronome_offset` |

See [Recording Flow](recording-flow.md) for the recording state machine and latency compensation.

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions.

## Notable Component Details

### Library Folders (drag-and-drop)

`LibraryPage.tsx` groups songs into user-named, flat (non-nested) folders — e.g. all songs by one band — with drag-to-reorder and drag-to-move via `@dnd-kit` (first drag-and-drop library in this project; `react-beautiful-dnd` was ruled out as archived/unmaintained). Same design as VPS's copy — `LibraryPage.tsx`/`library.ts`/`library.rs` were already structurally near-identical between the two projects going in, and this feature doesn't touch the trio-vs-dynamic-stems divergence at all.

**Layout:** the folders block (`.library-page__folders`) and the root song list (`.library-page__list`) sit together inside **one scroll region** (`.library-page__scroll` — `flex: 1; min-height: 0; overflow-y: auto`), so a long folder list scrolls together with the songs under a single scrollbar instead of each region owning its own nested scrollbar. Only the Library toolbar (`.library-page__list-toolbar`, holding `+ New Folder`) stays pinned above the scroll region. One `DndContext` wraps the scroll region — `DndContext` renders no wrapper DOM element — and dnd-kit's built-in auto-scroll drives that single container while dragging. Trade-off vs. the earlier two-independent-scrollers design (folders capped at `max-height: 40vh` and pinned): folders now scroll out of view when the list is scrolled far, so reaching a folder as a drop target can mean scrolling back up — an explicit user call (2026-08-30), preferred over the double scrollbar.

**Components:**
- `FolderSection` — one folder's header (drag handle, collapse toggle, inline double-click-to-rename, delete) plus its song list. `useSortable({ id: "folder:" + folder.id })` makes the folder itself draggable (reorder folders); a separately-prefixed id (`FOLDER_DRAG_PREFIX = "folder:"`) keeps folder-drag ids from colliding with song ids in dnd-kit's shared id namespace. `useDroppable({ id: folder.id })` (unprefixed) on the folder's body makes it a drop target for songs.
- `DraggableSongRow` — wraps `SongCard` with a small drag-handle button (⠿) that receives dnd-kit's `attributes`/`listeners`; the card itself keeps its existing click-to-open/delete handlers untouched.
- `RootDropZone` — `useDroppable({ id: "root" })` wrapping the un-foldered song list.

**Collapsed state persistence:** a folder's collapse toggle is not local component state — `FolderSection` reads/writes `collapsedFolders: Record<string, boolean>` on the settings store (`sps_settings` in localStorage). `LibraryPage` unmounts whenever the user opens a song, so local `useState` was lost on every return to the library (bug fixed 2026-08-31). Missing key = expanded (the default).

**Collision detection:** `DndContext` uses a custom `pointerWithin` → `rectIntersection` fallback strategy, not dnd-kit's default `closestCenter`. `closestCenter` compares rect *centers*, so a short/empty folder next to the tall root song list frequently lost to a nearby list row even with the pointer squarely over the folder — the drop silently resolved to the wrong container (or nothing). Resolving by what's actually under the pointer fixed it; `rectIntersection` is only a fallback for the rare case nothing is directly under the pointer. Both `FolderSection`'s body and `RootDropZone` also read `isOver` from their `useDroppable` call to apply a `--over` highlight class (outline + tint) while a valid drop is armed.

**Drop logic (`handleDragEnd` in `LibraryPage`):** a single store action, `moveSongs(folderId, orderedSongIds)`, covers both a same-folder reorder and a cross-folder move-at-position. Folder-drag (`activeId` starts with `folder:`) is handled separately via `reorderFolders(orderedIds)`.

### StemView

Mounts/destroys the `AudioEngine` whenever `song.id` changes. Iterates `song.stems` and renders one `StemTrack` per stem, plus a `TakeTrack` when a take is selected, and `TimeRuler` at the top. Does **not** render Export Mix or Download All — those live in `AnalyzerPage.tsx`'s header (see below), not here.

#### Timeline Zoom/Pan

`TimeRuler`, the stem rows, and the take row are wrapped in a new `.stem-view__timeline` element (`ref`'d as `timelineRef`), which owns two `useEffect`-mounted listeners:

- A **non-passive `wheel` listener** (`addEventListener("wheel", handler, { passive: false })` — React's `onWheel` prop is passive since React 17 and can't `preventDefault()` native ctrl+wheel page-zoom). Ctrl+wheel calls `computeZoomToCursor()` (`@giamat90/mps-core/zoomPan`) with the cursor's pixel offset within the wrapper, then `eng.zoomAll(newPx, newScroll)`; shift+wheel calls `computePan()` then `eng.setScrollAll(newScroll)`. Both cases call `eng.noteManualScrollInteraction()` first, suppressing the engine's playhead auto-follow (see [Audio Engine: Timeline Zoom/Pan](audio-engine.md#timeline-zoompan)) for 800ms. Wheel events without `ctrlKey`/`shiftKey` are ignored (not `preventDefault()`-ed), so ordinary page scroll/zoom over the timeline behaves normally.
- A **`ResizeObserver`** that reclamps `scrollTime` into bounds and snaps `minPxPerSec` up to the new dynamic "whole song fits" floor if the container shrank, since both depend on live container width.

`@giamat90/mps-core/zoomPan` holds the pure math (one copy, shared with VPS): `computeZoomToCursor()` keeps the exact song-time under the mouse cursor fixed on screen while `minPxPerSec` changes by an exponential factor of wheel delta (`Math.exp(-deltaY * ZOOM_SENSITIVITY)` — proportional zoom feels consistent regardless of current zoom level, unlike a fixed additive step); `computePan()` shifts `scrollTime` by `deltaPx / minPxPerSec`. Both clamp `scrollTime` into `[0, max(0, duration - viewportWidthPx/minPxPerSec)]` and `minPxPerSec` into `[dynamicLowerBound, MAX_PX_PER_SEC]` — the lower bound comes from `eng.getMinPxPerSec()` (the "whole song fills the container" floor), so zooming out can never scroll past the song's edges.

### LoopsMenu and keyboard shortcuts

`LoopsMenu` (analyzer topbar, beside `LoopButton`) keeps two lists in one popover. **Saved loops** are named regions stored on the song (`Song.loops`, `set_song_loops`; the pure rules are `@giamat90/mps-core/loops`: `addLoop`, `renameLoop`, `removeLoop`, `validateLoop`). **Sections from the chords** (`src/lib/sections.ts`, `detectSections`) reads the song in four-bar blocks from the metronome downbeat: a block that plays the same progression as the section before it (cosine of chord-step histograms) joins it, otherwise it starts a section; sections with the same progression share a letter, and silence before the first chord is the Intro. Chords alone cannot tell a verse from a chorus on the same loop. Saving takes the current punch region; clicking a loop calls `applyLoopRegion(start, end)`, which sets the punch region, turns the loop on and seeks to the start. **Bars** cuts the song into groups of 2, 4, 8 or 16 bars counted from the metronome downbeat at four beats to a bar (`barSections`); it is not structure detection, and needs a detected tempo.

Keyboard shortcuts (`src/lib/shortcuts.ts`, installed by `AnalyzerPage` on `window` through `@giamat90/mps-core/shortcuts`): Space play/pause, Home / End skip to start / end, ← → step 5 s (Shift: 1 s), L toggle the loop, [ and ] mark the region start and end at the playhead. Typing in a field, ctrl / alt / meta chords, auto-repeat and a focused button's own Space are left alone, and nothing runs while recording or counting in. The take nudge arrows are focus-scoped and stop their own events first.

### BassTabPanel / ExportChartButton

`BassTabPanel` (below `StemView` in `.analyzer-page__stems`) reads `bass_tab.json` through `read_bass_tab` and draws a four-string tab on a canvas: a 6 s window with the playhead a quarter of the way in (`tabWindowStart`, `tabTimeToX` in `src/lib/bassTab.ts`), fret numbers on the string rows, the sounding note in the accent colour. Clicking seeks. It renders nothing for a song without a bass stem or without a transcription. "Export MIDI" saves a format 0 `.mid` (`bassTabToMidi`, fingered-bass program, the song's detected tempo as a fixed tempo map) through `export_file`.

`ExportChartButton` (header, only when `song.hasChords`) saves a text chord sheet (`buildChordChart`: start time and chord name, four per line). The chords are written in the current transpose and capo (`transpose - capo` semitones, the shapes to play) while the key line keeps the sounding key. The same button row has **Re-detect chords**, which runs `redetect_song_chords` (sevenths and slash chords for songs imported before they existed) and then bumps `chordsRevision` so every chord display reloads. `CapoSelect` (topbar) sets the per-song capo, stored in localStorage `sps_capo_by_song` and mirrored to detached windows with `chordsRevision`; `useChordSegments` applies `transpose - capo` to the chord and its bass note.

`ChordEditor` can also be **listened to**: *Hear* plays the chord on `chordSynth` (a sustained organ-like pad, the root an octave and a half below, a slash bass in the bass), and changing the root / quality / bass plays the new chord at once. The chord is voiced from the stored chord plus the **transpose** only (`chordVoicing`: the capo changes the shapes shown, never the sound, so `soundingOffset` is the capo applied to the shown name) and detuned by the song's `tuning`, so it is in tune with an off-pitch recording. *With song* sets the punch region to the chord's stretch, loops it and holds the chord while the playhead is inside, so the two can be compared on the same notes; closing the editor stops both. Under the selects, **Also heard** lists `segment.alternatives` with their fit and **In this key** lists `keyChords(song.detectedKey)`; clicking a chip previews it, double-click or *Use* applies it (`ChordRow` shifts the alternatives like the rest, `shiftSegment`). The synth follows the output device chosen in `OutputSelector`.

`ChordDetailSelect` (topbar, next to the capo) picks how much of each chord is shown: **Easy** reduces 7 / maj7 / min7 / 6 to the triad and drops the slash bass (sus, dim, aug stay: a triad cannot say them for the player), **Medium** keeps sevenths and drops the bass note, **Advanced** is everything detected (the default). It is one preference for every song (localStorage `sps_chord_detail`), mirrored to detached windows in `SharedState.chordDetail`, and `buildChordChart` takes it as `detail`. `useChordSegments` returns the unchanged `segments` and a parallel `display` list; segments are never merged for display, so a chip in `ChordRow` still points at the stored chord it corrects and the editor always shows the real chord (the sheet does merge neighbours that then read the same, as before). `simplifyChord` in `src/lib/chordNames.ts` is the rule.

### ExportMixButton / DownloadAllButton

Both render in `AnalyzerPage.tsx`'s `.analyzer-page__header`, next to the song title — whole-song actions, not stem-view-specific, so they don't belong inside `StemView.tsx`. `ExportMixButton` was extracted out of `StemView.tsx` into its own file (2026-07-08) to sit alongside `DownloadAllButton` in the header, matching the equivalent move made in VPS (`ExportMixButton` out of `Waveform.tsx` into `PracticeRoom.tsx`'s header).

- **Export Mix**: `buildMixSources(state)` resolves one final linear gain per audible track from mute/solo/volume (plus the take with its `startPosition`/`audioOffset` alignment) and clamps the render window to the punch region; the `export_mix` Tauri command renders it via the sidecar `mix_export` and opens a native Save-As dialog. Native `title` tooltip: "Export the currently audible mix as a WAV file" (or "No audible tracks to export" when disabled).
- **Download All**: bundles every stem WAV plus every take's normalized WAV into one zip via the `export_all` Tauri command and a single Save-As dialog. Native `title` tooltip: "Download all stems and takes as a zip archive".

### StemTrack

Single stem row. Contains:
- A WaveSurfer waveform container (wired to the engine via `engine.loadStem()`)
- Mute (`M`) and solo (`S`) buttons wired to `toggleMute` / `toggleSolo` in the player store
- A volume slider that calls `engine.setStemVolume(name, value)`
- A download button that calls `exportStem(songId, stemName)` via a native Save-As dialog

Its `.stem-track__body` wrapper (`position: relative`, `overflow: hidden`) clips `PunchOverlay` — now positioned in pixels (`left`/`width` derived from `minPxPerSec`/`scrollTime`, not a percentage of the row's raw width — see [Timeline Zoom/Pan](#timeline-zoompan) above) — when the punch region extends off-screen under zoom/pan. `.stem-track__body` already had `overflow: hidden` before zoom/pan existed, so no CSS change was needed here (unlike VPS, where the equivalent `.waveform__track-body` rule had to gain it).

### TakeTrack

Extra row rendered when `activeTakeId` is set. Loads the take into the engine via `loadTakeTrack(path, container, startOffset, audioOffset, manualOffset)` so it plays aligned at its `startPosition` (+ `manualOffset`); visually positioned/sized in pixels derived from the current zoom/scroll (`_resizeTakeTrack()` in the engine — see [Audio Engine: Take Track](audio-engine.md#take-track)), not a fixed ratio. Its own `PunchOverlay` copy gets the same pixel-positioning treatment as `StemTrack`'s.

#### Take Sync Controls

`TakeSyncControls` (local sub-component, rendered in `TakeTrack`'s `.stem-track__controls` row) lets the user drag the take into sync with the other tracks after recording, then reset it back to the auto-detected position.

- **Grip handle** (`⠿`) — a small button, not the waveform body itself, so dragging never conflicts with WaveSurfer's own `"interaction"` click-to-seek on the take waveform. Uses **Pointer Events** (`onPointerDown` + `e.currentTarget.setPointerCapture(e.pointerId)`, then `onPointerMove`/`onPointerUp`) rather than `TimeRuler.tsx`'s plain mouse events — the grip is a small element, so tracking needs to survive the pointer leaving its bounds mid-drag, which pointer capture guarantees and plain React mouse handlers on a small target do not.
- A `< 3px` movement threshold distinguishes an intentional drag from a click before calling `getEngine().setTakeManualOffset(newOffset)` live on every `pointermove` (see [Audio Engine: Manual Take Sync](audio-engine.md#manual-take-sync)) — no store write during drag.
- The offset is **unclamped in both directions** — dragging left of song time 0 is allowed (the take's leading edge before song time 0 simply becomes unreachable during playback via the existing `Math.max(0, …)` guard in `_seekTake`; the recorded file itself is never trimmed or otherwise modified). On `pointerup` the offset is committed via the player store's `setTakeManualOffset(takeId, offset)` action, which rounds to `0.01s` (tightened from `0.1s` — see nudge buttons below) and persists via `set_take_manual_offset`.
- **Reset button** (`↺`) — always mounted, `disabled` (not unmounted) when `take.manualOffset` is falsy, matching how other transport buttons in this codebase indicate unavailability. Calls the same store action with `offset = 0`.
- **Nudge buttons (`◀`/`▶`) + focus-scoped arrow keys** — added because dragging alone was reported hard to use for fine correction. Each click, or each `ArrowLeft`/`ArrowRight` keypress while the `.waveform__take-sync` container has focus (click it or Tab to it — deliberately not a global/app-wide shortcut, since arrow keys aren't claimed for anything else here), nudges by `TAKE_NUDGE_STEP_S` (10ms); holding Shift multiplies by `TAKE_NUDGE_COARSE_MULTIPLIER` (5x = 50ms) for coarser moves. Both paths call the exact same `setTakeManualOffset(take.id, offset)` commit action the drag handle uses on release — no separate live-preview path, no new engine method or Tauri command.
- **Editable offset field** (`waveform__take-offset`, a number input, not a static label) — lets the user type a rough offset directly (e.g. `300` for a ~300ms drift) instead of nudging up from 0 one step at a time, then fine-tune from that starting point with the nudge buttons/arrow keys. Local `offsetInput` text state (not driven straight from the store) so a partially-typed value like a lone `-` survives re-renders; re-synced from `take.manualOffset` via a `useEffect` only while the field isn't focused (tracked with an `inputFocused` ref, since a ref read in an effect wouldn't itself trigger re-sync on blur). Commits on blur or Enter (`Number(offsetInput) / 1000` through the same `setTakeManualOffset` action); Escape reverts the field to the current committed value and blurs without committing. `onFocus` selects all text for quick overwrite. The field's own `onKeyDown` calls `e.stopPropagation()` unconditionally so Left/Right/Up/Down keystrokes move the text cursor / native number-input step instead of triggering the container's arrow-nudge handler — the nudge handler lives one level up on `.waveform__take-sync` and would otherwise catch the same bubbled keydown.

### Recording components (`src/components/recording/`)

- **RecordButton** — starts/stops recording via the player store; disabled until a song is loaded. A separate ⏱ count-in toggle beside it cycles `countInBars` through `0 → 1 → 2 → 0`; when armed, `startRecording()` plays a flat, tempo-locked count-off (`countInBars * 4` beats at `(song.detectedBpm ?? 120) * playbackRate`, via the shared `Metronome` singleton) immediately before its existing `eng.setInteract(false); eng.seekTo(...); eng.play(); rec.start()` sequence, so `Take.startPosition` (captured earlier, unaffected) ends up beat-aligned — click stops the instant capture starts; clicking Record again during the countdown cancels it via `cancelCountIn()`. See VPS's `wiki/components.md#recordbutton` for the full design (byte-identical implementation, ported in parallel).
- **MicSelector** — input device picker; devices get real labels only after the first `getUserMedia` grant.
- **TakeList** — recorded takes with select/rename/delete; selecting a take mounts `TakeTrack`.
- **RecordingOffsetControl** — click-clap latency calibration wizard writing `recordingOffsets` entries with MAD-based confidence; see [Recording Flow](recording-flow.md#latency-compensation).

### OutputSelector

Audio output device picker (ported from VPS). `fetchOutputDevices` / `setOutputDevice` in the player store; the engine re-routes every WaveSurfer instance (and newly created ones) via `setSinkId`.

### UpdateDialog (`src/components/updater/`)

Auto-update modal backed by `useUpdaterStore` (`@giamat90/mps-core/updater`) and `tauri-plugin-updater`: release notes, download progress, install/restart.

### TimeRuler

Canvas strip above all stem tracks. Shows time ticks at adaptive intervals (≥80 px target). Drag to draw/edit the loop region; click to clear. Toggling the loop itself is done from [LoopButton](#loopbutton), not a button on this ruler (moved 2026-07-10 — see that section). See [Loop Region & Playback](recording-flow.md) for full interaction details. Also draws a draggable blue downbeat marker (dashed line + flag at the bottom edge) for the metronome's phase-lock anchor, hit-tested with priority over the loop-region drag modes — see [Metronome: Downbeat offset](#tempocontrol).

All of `tX`/`xToTime` (coordinate mapping), `modeForOffset` (handle hit-testing), and the tick-drawing loop read `minPxPerSec`/`scrollTime` from the player store instead of assuming the whole song spans the full canvas width — tick spacing gets finer as zoom increases (`tickInterval` is computed from the *visible* duration, `canvasWidthPx / minPxPerSec`, not the song's total duration), and only the visible time range is drawn. See [Timeline Zoom/Pan](#timeline-zoompan) above.

### TransportControls

Play/pause/stop buttons + current time display. Stop seeks to 0. Time is read from the player store's `currentTime` (updated at ~30 fps from the rAF loop).

### LoopButton

Standalone component (`src/components/player/LoopButton.tsx`), ported from VPS unchanged apart from field names already matching — reads `punchIn`/`punchOut`/`punchLoop`/`isRecording`/`setPunchLoop` directly from `usePlayerStore`, no props. Always rendered — a circular `⟳` toggle, red-tinted (`.loop-btn--active`) when `punchLoop` is true, `disabled` (dimmed, `opacity: 0.4`) whenever there's no loop region set or while recording, so it stays a stable landmark in the topbar rather than appearing/disappearing. Rendered in `AnalyzerPage.tsx`'s topbar directly after `<TransportControls />`.

Previously `TimeRuler.tsx` rendered its own in-ruler `⟳` with no `isRecording` guard (unlike VPS's, which already hid the button during recording). Moving it here added that guard for parity — cosmetic only, since the `isRecording` branch in `onTimeUpdate`'s punch-out handler already takes priority over `punchLoop` regardless of the button's visibility (recording always auto-stops at punch-out; it never loops).

### TempoControl

BPM-first speed control (ported from VPS): an editable BPM value (derived from `detectedBpm × playbackRate`) alongside an editable ×-rate, clamped to 0.25–2.5× (corrected 2026-07-08; this page previously said 0.5–2.0×, which didn't match the code's `Math.max(0.25, Math.min(2.5, ...))` clamp). Calls `engine.setPlaybackRate(rate)` and persists the value in the player store.

**Metronome (🥁 toggle, header row, ported from VPS):** same design as VPS's — local component state (`metronomeEnabled`, not in the Zustand store), synced to the transport (silent while paused, clicks only while `isPlaying`), effective BPM `(detectedBpm ?? 120) * playbackRate`, accented downbeat every 4th click (assumed 4/4), driven by the lookahead-scheduled `Metronome` singleton (byte-identical to VPS's — same 25 ms tick / 100 ms schedule-ahead Web Audio scheduler). The controlling `useEffect` resyncs (not just retunes) on every `metronomeEnabled`/`isPlaying`/effective-BPM/`metronomeOffset` change.

**Downbeat offset (phase-locking):** the metronome used to always start ticking at beat 0 the instant playback started, drifting out of sync with the song's actual downbeat whenever there's silence (or a pickup) before it. `metronomeOffset` (player store, persisted per song via the `metronomeOffset` field on `Song` and the `set_metronome_offset` Tauri command — mirrors `rename_take`) is a song-time anchor the click track phase-locks to instead: `src/lib/metronomeSync.ts`'s `computeMetronomePhase()` (pure, byte-identical with VPS) returns the wall-clock delay until the next aligned click plus which beat-in-bar it is, fed straight into `Metronome.start(bpm, timeUntilNextBeat, startBeat)` — reworked to always reset phase, even if already running (removed the old "already running → just retuned" early-return and the now-unused `setBpm()`). No SPS-specific adaptation was needed for any of this: it only touches `TempoControl.tsx` (byte-identical file) and the player store's existing `isPlaying`/`playbackRate` shape, same as the original metronome port.

The anchor is set two ways, both in `TempoControl`'s new "Downbeat" row (shown only while `metronomeEnabled`) and on `TimeRuler`:
- **Set button** — captures `getEngine().getCurrentTime()` at the moment it's clicked.
- **Drag** — `TimeRuler` draws a draggable marker (dashed blue vertical line + downward flag at the bottom edge) at the anchor's position, hit-tested with priority over the existing punch-region `create`/`drag-in`/`drag-out` modes (a new `"drag-metronome"` `DragMode` and a third `overrideMetronome` parameter on `draw()`, mirroring `overrideIn`/`overrideOut`).

A "↺" reset-to-0 button appears next to Set once the offset is nonzero.

### KeyTranspose

Semitone transpose control (`src/components/player/KeyTranspose.tsx`), ported from VPS verbatim — same file, only the import path (`../../stores/player`, already the identical relative path in both projects) needed no change. Renders `-`/`+`/Reset buttons around a `±N st` readout, clamped to ±6 semitones; `Reset` only appears once `transpose !== 0`. All three controls are `disabled` while `isTransposing` or with no song loaded, and the readout pulses (`.key-transpose__value--pending`) during a shift.

Clicking `-`/`+` calls the player store's `setTranspose(semitones)`, which — unlike VPS's fixed vocals/instrumental pair — resolves **every stem currently in `song.stems`**: at `semitones === 0` it points each stem back at its plain `{songDir}/{stem}.wav`; otherwise it calls the Tauri `pitch_shift_song(songDir, song.stems, semitones)` command (phase vocoder, Rust-cached per song/semitone-count) and gets back a `{ stems: Record<string, string> }` map. Either way the resulting paths are handed to `AudioEngine.reloadStemsFromPaths()`, which swaps each stem WaveSurfer instance's underlying file in place — see `wiki/audio-engine.md#key-transpose`. Rendered in `AnalyzerPage.tsx`'s topbar next to `TempoControl` (VPS renders it in `PracticeRoom.tsx`'s equivalent topbar).

### DropZone

Drag-and-drop target. Accepts audio files and calls `uploadSong(filePath)` on the library store. Disabled while any processing job is active. Renders `StemPicker` above the drop target so stem selection applies to the next upload or YouTube import alike.

### StemPicker

Controlled component (`value`/`onChange` + `highQuality`/`onHighQualityChange`) rendered in `LibraryPage` above `DropZone`/`YouTubeImport`, shared by both import paths. A chip toggle per stem (`vocals`/`drums`/`bass`/`guitar`/`piano`/`other`, colored via the same `STEM_COLORS` map `engine.ts` uses for waveforms) — at least one stem must stay selected, toggling the last one off is a no-op. Below it, a "High quality" checkbox toggles `htdemucs_ft` vs. `htdemucs` (hint text states the tradeoff: "better isolation, ~2–3× slower" vs. "fast standard quality"). Selected stems + the flag are passed straight through as `stemsToExtract`/`highQuality` on `processSong`/`importYoutube` — see [Data Model](data-model.md) and `processor.py`'s stem-count-driven model cascade (no guitar/piano → single `htdemucs(_ft)` pass; guitar or piano requested → cascade: `htdemucs(_ft)` on the full mix, then `htdemucs_6s` on the resulting "other" stem).

### ChordCarousel / ChordRow

Both read from `useChordSegments(song)` (`src/lib/chords.ts`), which lazily fetches `read_song_chords(song.id)` the first time a song with `hasChords: true` is displayed (empty array, no fetch, if `hasChords` is false — songs processed before chord detection shipped, or where it failed non-fatally in `processor.py`). Chords are detected once at processing time (chroma-template matching, `processor.py`'s `_detect_chords_chroma()`), written to `chords.json`, and never recomputed — no live/on-the-fly detection. The detected chords are shifted by the active `transpose` (`transposeChord`) so the display matches the audio, and the header shows the shifted key (`transposeKey`); `transpose` is part of the detached-window shared state for this reason.

- **ChordCarousel** (`AnalyzerPage`'s topbar) — a gauge-dial-style strip: the currently-playing chord centered ("now"), with up to 2 past and 2 next chords on either side, each positioned by `--dist`/`--dist-abs` CSS custom properties. Returns `null` entirely if `!song.hasChords || segments.length === 0`, so it takes no layout space on a song with no chord data.
- **ChordRow** (inside `StemView`, above the stem tracks) — the same segments laid out as fixed-position chips along the actual timeline, sized/positioned in pixels from `minPxPerSec`/`scrollTime` like everything else in the zoom/pan system. Chips narrower than `MIN_LABEL_PX` (28px) show as an unlabeled tick instead of a clipped label, unless active. Chips are buttons: a click selects one and opens **ChordEditor** under the row (see below). With the playhead paused in a gap (or the chords all deleted) a dashed `+` appears at the playhead to add a chord there. Shown for any song with `hasChords`, so an emptied list still has its `+`.
- **ChordEditor** (`ChordEditor.tsx`, under the row while a chip is selected) — root / quality / slash-bass selects (`CHORD_NOTES`, `CHORD_QUALITIES` in `lib/chordNames.ts`: the detector's five qualities plus sus2, sus4, dim, aug, 6), and `Go to`, `Start here`, `End here` (move the chord's edge to the playhead; a neighbour that touched it keeps touching), `Split here`, `Join next`, `Delete`, `Done`. The pure list operations are in `lib/chordEdit.ts` (`MIN_CHORD_SECONDS` = 0.1); the editor shows chords as played (transpose and capo applied) and `ChordRow` shifts back before saving, so the file always holds the key the song was detected in.

Corrections are saved through `save_chord_edits` to `chords_edited.json` next to `chords.json` (never over it), and `read_song_chords` returns that list while it exists. A save bumps `chordsRevision`, which reloads every chord view, the detached window included. "Reset edits" (header, shown only when there are any, `has_chord_edits`) deletes the file; "Re-detect chords" deletes it too and asks first when it exists, because a new detection replaces the corrections made to the old one. Section detection, the loop menu and the chord sheet all read the corrected list.

Both share `formatChordName()` (`"C:maj"` → `"C"`, `"A:min"` → `"Am"`) and `findActiveChordIndex()`/`findNearestChordIndex()` (binary search over the sorted segments) from `lib/chords.ts`.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates client-side with a regex before calling `importYoutube(url)`. Disabled while any processing job is active. Errors appear as a dismissible red banner in `LibraryPage`.

### SongCard (inline in `LibraryPage`)

Each song in the library list. Shows title, BPM, key, stem count, and a delete button. Clicking the card navigates to `AnalyzerPage` with the song loaded.

## Panel visibility (Panels menu)

The analyzer page lets the user show or hide its optional parts from the **Panels** menu in the header (`src/components/panels/PanelMenu.tsx`). State: `useAnalyzerPanels` in `src/stores/panels.ts` (`createPanelStore` from `@giamat90/mps-core/panels`), persisted under `sps_panels`.

| Panel id | Shows | Default |
|---|---|---|
| `chords` | `ChordCarousel` in the topbar and `ChordRow` above the ruler in `StemView` | on |
| `lyrics` | `LyricsPanel` | on |
| `takes` | `TakeList` | on |

**Order:** Lyrics and Takes (the two panels stacked under the stems) can be moved: the **↕ grip** in a panel's corner handle drags it above or below the other (keyboard: focus it, space, arrows, space), via `SortablePanels` (`@dnd-kit/sortable`). The chord carousel lives in the topbar and does not move, though `order` (mps-core v0.6.0, persisted in `sps_panels` with the visibility choices) lists it too. The Panels menu lists panels in that order and **Reset** restores default visibility and order. A panel that is detached keeps its place in the order and returns to it.

Always on: transport, tempo, transpose, mic/output, record. The stems and the bass tab are not in this list either (see "Waveforms, single stems and the bass tab" below). A hidden panel is not mounted, so it must stay a pure view (the chord segments are loaded by `useChordSegments` inside the components that show them; the takes are fetched by `loadSong`). Known limit: hiding Lyrics during a sync unmounts the panel (its cleanup clears the lyrics store); the sync still finishes and is saved, and showing the panel again loads it.

### Waveforms, single stems and the bass tab

The stem area can be hidden as a whole, each stem's waveform can be shrunk to a strip one by one, as in a DAW, and the bass tab has its own switch. State: `useWaveformPanels` in `src/stores/waveforms.ts` (`createPanelStore`, persisted under `sps_waveforms`, **not** in `sps_panels`). Ids: `waveforms` (the area), `bassTab`, and one per stem name. The Panels menu lists them first: **Waveforms** with the song's own stems indented under it (greyed while the area is off), then **Bass tab** (only for a song with a bass stem). Each stem row starts with an arrow: **^** shrinks the stem to its strip (name, M, S, volume, download), **∨** brings the waveform back. The arrow and the menu tick are the same state, so unticking a stem in the menu also leaves just the strip. The count on the menu button counts the area and the bass tab, not the stems.

- **Hidden means collapsed, never unmounted.** `StemView` owns the containers the audio engine draws into (`loadSong`, the take rails) and `getMinPxPerSec()` reads the width of the master stem, so it always stays mounted. A minimized stem gets `stem-track--collapsed`, which collapses only its `stem-track__body` (height 0, `visibility: hidden`, a small negative margin) so the header strip stays; a hidden area gets `analyzer-page__waveforms--collapsed`; both keep the full width on purpose. The bass tab is a plain pure view and is simply not rendered when off.
- **Hiding a waveform does not change what is heard.** Mute, solo and volume still apply; a hidden stem that is muted or soloed gets a "muted" / "solo" tag in the menu.
- The area stays (ruler and strips) until it is switched off in the menu, even with every stem minimized; the old rule that it vanished when nothing was left to draw (`waveformsOnScreen`) is gone. A choice for a stem the song does not have is ignored. Take lanes keep their own show/hide.
- **Hide all** collapses the area and the bass tab but keeps the choice of stems; **Show all** and **Reset** also expand every stem.
- The chord row above the ruler is still the `chords` panel (it is inside the area, so it goes with it).
