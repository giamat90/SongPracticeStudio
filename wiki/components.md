# Frontend Components

**Directory:** `src/components/`

## Component Tree

```
App
├── LibraryPage
│   ├── DropZone           — drag-and-drop audio file import
│   ├── YouTubeImport      — paste-and-import YouTube URL
│   └── SongCard           — song list item with stem count + delete
└── AnalyzerPage
    ├── StemView            — orchestrates TimeRuler + all StemTracks; loads AudioEngine
    │   ├── TimeRuler       — canvas time ruler with drag-to-select loop region
    │   └── StemTrack (×N) — one row per stem: waveform + volume slider + download button
    ├── TransportControls   — play/pause/stop + current time display
    └── TempoControl        — playback rate slider (0.5–2.0×)
```

## State Management

### Library Store (`src/stores/library.ts`)

Manages the song list, import/upload flow, and error state.

| Field | Type | Description |
|-------|------|-------------|
| `songs` | `Song[]` | All songs in the library |
| `processing` | `ProcessingStatus \| null` | Active processing job (null when idle) |
| `isLoading` | `boolean` | Initial fetch in progress |
| `error` | `string \| null` | Last friendly error message |

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `deleteSong`, `clearError`, `initProgressListener`.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages.

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
| `punchIn` | `number \| null` | Loop region start (seconds) |
| `punchOut` | `number \| null` | Loop region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions.

## Notable Component Details

### StemView

Mounts/destroys the `AudioEngine` whenever `song.id` changes. Iterates `song.stems` and renders one `StemTrack` per stem. Also renders `TimeRuler` at the top.

### StemTrack

Single stem row. Contains:
- A WaveSurfer waveform container (wired to the engine via `engine.loadStem()`)
- A volume slider that calls `engine.setStemVolume(name, value)`
- A download button that calls `exportStem(songId, stemName)` via a native Save-As dialog

### TimeRuler

Canvas strip above all stem tracks. Shows time ticks at adaptive intervals (≥80 px target). Drag to draw/edit the loop region; click to clear. The ⟳ button toggles `punchLoop`. See [Loop Region & Playback](recording-flow.md) for full interaction details.

### TransportControls

Play/pause/stop buttons + current time display. Stop seeks to 0. Time is read from the player store's `currentTime` (updated at ~30 fps from the rAF loop).

### TempoControl

Slider from 0.5× to 2.0×. Calls `engine.setPlaybackRate(rate)` and persists the value in the player store.

### DropZone

Drag-and-drop target. Accepts audio files and calls `uploadSong(filePath)` on the library store. Disabled while any processing job is active.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates client-side with a regex before calling `importYoutube(url)`. Disabled while any processing job is active. Errors appear as a dismissible red banner in `LibraryPage`.

### SongCard (inline in `LibraryPage`)

Each song in the library list. Shows title, BPM, key, stem count, and a delete button. Clicking the card navigates to `AnalyzerPage` with the song loaded.
