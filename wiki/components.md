# Frontend Components

**Directory:** `src/components/`

## Component Tree

```
App
├── upload/
│   ├── DropZone          — drag-and-drop audio file import
│   └── YouTubeImport     — paste-and-import YouTube URL
└── player/
    ├── Waveform           — 3-track waveform display (vocals + instrumental + take)
    ├── TimeRuler          — canvas time ruler with drag-to-select punch region
    ├── TransportControls  — play/pause/stop + volume sliders
    ├── TempoControl       — playback rate control
    ├── KeyTranspose       — semitone transpose UI
    └── OutputSelector     — audio output device picker
recording/
    ├── RecordButton       — start/stop recording
    ├── MicSelector        — microphone input source picker
    └── TakeList           — list of recorded takes with delete
analysis/
    ├── DualTuner          — real-time pitch tuner (reference vs. singer)
    ├── PianoKeyboard      — horizontal piano key strip with live/song/take highlight
    ├── PianoRoll          — scrolling pitch ribbon display (song + take + live)
    ├── VibratoCard        — vibrato rate / depth / regularity summary
    ├── TimingChart        — timing deviation chart (user vs. reference onsets)
    └── DynamicsCurve      — RMS dynamics over time
coaching/
    └── CoachPanel         — AI coaching tips panel
```

## State Management

### Library Store (`src/stores/library.ts`)

Manages the song list, import/upload flow, and error state.

| Field | Type | Description |
|-------|------|-------------|
| `songs` | `Song[]` | All songs in the library |
| `processing` | `ProcessingStatus \| null` | Active processing job (null when idle) |
| `isLoading` | `boolean` | Initial fetch in progress |
| `error` | `string \| null` | Last friendly error message (cleared on next import attempt) |

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `deleteSong`, `clearError`, `initProgressListener`.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages covering bot-detection, VPN/proxy blocks, private/geo-blocked videos, and network failures.

### Player Store

All player state lives in a single Zustand store: `src/stores/player.ts`.

```ts
import { usePlayerStore } from "../../stores/player";

const isPlaying = usePlayerStore((s) => s.isPlaying);
const togglePlay = usePlayerStore((s) => s.togglePlay);
```

Components subscribe to individual slices to avoid unnecessary re-renders. The store owns the `AudioEngine` and `VocalRecorder` singletons (accessed via module-level `getEngine()` / `getRecorder()` helpers, not stored in Zustand state).

## Key State Fields

| Field | Type | Description |
|-------|------|-------------|
| `song` | `Song \| null` | Currently loaded song |
| `isPlaying` | `boolean` | Playback state |
| `currentTime` | `number` | Playback position (seconds) |
| `duration` | `number` | Song length (seconds) |
| `playbackRate` | `number` | Speed multiplier (0.5–2.0) |
| `vocalsVolume` | `number` | 0–1 |
| `instrumentalVolume` | `number` | 0–1 |
| `isLooping` | `boolean` | Loop mode active |
| `loopStart / loopEnd` | `number \| null` | Loop region (seconds) |
| `transpose` | `number` | Active semitone shift |
| `isTransposing` | `boolean` | Pitch-shift in progress |
| `isRecording` | `boolean` | Recording in progress |
| `takes` | `Take[]` | All takes for current song |
| `activeTakeId` | `string \| null` | Selected take (loads it as the take track) |
| `takeVolume` | `number` | 0–1 volume for the take track |
| `punchIn` | `number \| null` | Region start (seconds); play always seeks here when set |
| `punchOut` | `number \| null` | Region end (seconds); playback stops or loops here |
| `punchLoop` | `boolean` | Loop the region during playback (cleared with the region) |
| `audioDevices` | `MediaDeviceInfo[]` | Available microphone inputs |
| `selectedDeviceId` | `string \| null` | Selected mic device ID |
| `outputDevices` | `MediaDeviceInfo[]` | Available audio outputs |
| `selectedOutputDeviceId` | `string \| null` | Selected output device ID |

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions. This ensures the UI scales correctly across different screen sizes and DPI settings.

## Notable Component Details

### TransportControls

Stop button routes to `stopRecording()` during recording, `stop()` otherwise:

```tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

An orange **Take** volume slider appears when `activeTakeId` is set.

### RecordButton

Starts recording via `startRecording()`. If recording is already active, clicking stops via `stopRecording()`. Displays a pulsing red indicator while `isRecording` is true.

### TimeRuler

Canvas strip above the waveform tracks. Shows time ticks at adaptive intervals (≥ 80 px target). All ruler interaction is disabled during recording.

**Interactions:**
- **Click + drag** on empty space → draw a new punch region
- **Hover / drag near In or Out handle** (±8 px) → cursor becomes `ew-resize`; drag moves only that boundary, the other stays fixed
- **Click** (< 0.5 s drag) → clear punch region and reset loop toggle
- **⟳ button** (appears at right edge when region is set) → toggle `punchLoop`; red when active

The region is drawn as a red band on the canvas with I-beam caps at the handles. Each waveform track also shows a translucent `PunchOverlay` div (positioned via `left` / `width` percentages of the track).

### Waveform

Renders `TimeRuler` at the top, then up to three stacked WaveSurfer tracks each wrapped in `.waveform__track-body` (position: relative) so `PunchOverlay` can be absolutely positioned over them:

1. **Vocals** — always visible; original vocals track
2. **Instrumental** — always visible; backing track and time reference
3. **Take** — conditionally rendered when `activeTakeId` is set; orange waveform positioned at the correct time offset and proportional width using `eng.loadTakeTrack()`

### MicSelector / OutputSelector

Call `fetchAudioDevices()` / `fetchOutputDevices()` on mount to populate device lists. After `getUserMedia` succeeds during recording, device labels become available and `fetchAudioDevices()` is called again to refresh the list with human-readable names.

### KeyTranspose

Displays the current `transpose` value in semitones with ±12 range. Triggers `setTranspose(n)` which pauses playback, calls the Python sidecar to generate shifted WAVs, then reloads the engine with the new files.

### PianoRoll

VoceVista-inspired scrolling pitch display. Renders at native frame rate via a `requestAnimationFrame` loop that reads `getEngine().getCurrentTime()` directly — no React re-renders during playback.

**Layout:**

```
┌─ piano-roll__ruler-wrap (1.25rem) ─────────────────────┐
│  time ruler: ticks · punch region · center playhead    │  ← drag to create/edit punch region
└────────────────────────────────────────────────────────┘
┌─ canvas (15rem) ───────────────────────────────────────┐
│ |── 36px piano ──|──── scrolling pitch roll ───────── │
│ │  C5 key label  │  song ribbon (blue)                │ │
│ │  white/black   │  take ribbon (red)                 │ │
│ │  keys          │  live ribbon (orange)              │ │
│ │                │       ╎ playhead   [G4 D#4] ──top-right note │
└────────────────────────────────────────────────────────┘
```

**Time ruler (above canvas):**
- Shows the current 8-second window with absolute time tick marks
- Punch region overlay (same `punchIn`/`punchOut` store values as the waveform TimeRuler)
- Drag on empty area → draw new punch region; drag near handle → move that boundary; click → clear
- Loop toggle button (⟳) appears when a region is set
- Coordinates use `capturedT0` from mousedown so the window stays stable during a drag

**Drag-to-seek (main canvas):**
- Horizontal drag on the pitch roll area seeks the playhead and syncs all tracks
- Drag left → forward in time; drag right → backward (pan-content gesture)
- Delta is computed from the initial drag position so the view tracks the finger accurately

**Drawing passes (in order):**
1. Lane backgrounds — black-key rows slightly darker, C-octave boundaries marked with a brighter rule
2. Song pitch ribbon — `rgba(74,158,255,0.88)` thick polyline following SRH pitch data; line breaks on gaps > 80ms or confidence < 0.5
3. Take pitch ribbon — `rgba(233,69,96,0.92)` same style, drawn over the song ribbon
4. Live pitch ribbon — `rgba(255,140,30,0.9)` drawn during recording from autocorrelation readings accumulated in `livePitch[]` (analysis store); disappears when recording stops
5. Playhead — dashed vertical line at canvas center
6. Note label — current note name(s) shown right-aligned at top-right of the roll (e.g. "A4 G#4")
7. Piano key strip — drawn last so it sits on top of any ribbon that bleeds into the left column; key color priority: live (orange) > take (red) > song (blue)

**Constants:** MIDI 45–84 (A2–C6, 40 semitones), 8-second window, `15rem` canvas height.

### PianoKeyboard

Horizontal piano key strip showing the currently playing note highlighted in the matching color (song=blue, take=red, live=orange). White keys show note labels at the bottom of each key: C notes include the octave number (`C3`, `C4`…), other white keys show just the note letter (`D`, `E`, `F`, `G`, `A`, `B`).

### YouTubeImport

Input + button for pasting a YouTube URL. Validates the URL client-side with a regex before calling `importYoutube(url)` on the library store. Disabled while any processing job is active. Errors from the store are shown as a dismissible red banner in `LibraryPage`.

### SongCard (inline in `LibraryPage`)

Each song in the library list is rendered by a `SongCard` component with local state:

- **Pitch control** — ±6 semitone offset (−/+ buttons + value display + × reset). At 0 the export is direct; at any other value `pitchShiftSong(song.directory, n)` is called first and the shifted WAV paths are passed to `exportStem`. The suggested filename includes the offset, e.g. `Song - Vocals (+3st).wav`.
- **Export buttons** — "↓ Vocals" and "↓ Instr." trigger `exportStem` via a native Save-As dialog. Both are disabled and show `…` while pitch-shifting is in progress.
