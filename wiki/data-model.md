# Data Model

**Key files:** `src/lib/types.ts` · `src-tauri/src/commands.rs` · `src-tauri/src/library.rs` · `src-tauri/src/storage.rs`

## TypeScript Interfaces

### Song

```ts
interface Song {
  id: string;           // UUID
  title: string;
  artist?: string;
  duration: number;     // seconds
  detectedKey?: string; // e.g. "C minor"
  detectedBpm?: number;
  processedAt: string;  // ISO timestamp
  directory: string;    // absolute path to ~/.vps/library/{id}/
}
```

### Take

```ts
interface Take {
  id: string;
  songId: string;
  recordedAt: string;     // ISO timestamp
  filepath: string;       // absolute path to the recording file
  startPosition: number;  // song time (seconds) where recording began; 0 for full-song takes
  pitchData?: PitchPoint[];
  onsets?: number[];
  dynamics?: DynamicsPoint[];
  vibrato?: VibratoMetrics;
}
```

### PitchPoint

```ts
interface PitchPoint {
  time: number;       // seconds from start of take
  frequency: number;  // Hz
  confidence: number; // 0–1
}
```

### DynamicsPoint

```ts
interface DynamicsPoint {
  time: number; // seconds
  rms: number;  // RMS amplitude 0–1
}
```

### VibratoMetrics

```ts
interface VibratoMetrics {
  rate: number;       // Hz (typical: 4–7 Hz for healthy vibrato)
  depth: number;      // semitones peak-to-peak
  regularity: number; // 0–1
}
```

### ProcessingStatus (event payload)

```ts
interface ProcessingStatus {
  songId: string;
  progress: number;  // 0–1
  stage: string;     // e.g. "separating", "detecting pitch"
  isComplete: boolean;
  error?: string;
}
```

### CoachingTip

```ts
interface CoachingTip {
  category: "pitch" | "timing" | "vibrato" | "dynamics" | "general";
  title: string;
  detail: string;
}
```

## Storage Layout

All data lives under `~/.vps/` (Windows: `C:\Users\{user}\.vps\`).

```
~/.vps/
└── library/
    └── {songId}/              UUID directory per song
        ├── {original}.mp3     copy of the source file
        ├── vocals.wav         separated vocals (Demucs)
        ├── instrumental.wav   separated instrumental (Demucs)
        ├── pitch.json         CREPE pitch data
        ├── onsets.json        onset times
        ├── dynamics.json      RMS curve
        ├── song.json          Song metadata
        ├── cache/             pitch-shifted WAV cache
        │   └── vocals_+2.wav  shifted files keyed by semitone delta
        └── takes/
            └── {takeId}.webm  recorded take audio files
```

## Tauri Commands

| Command | Arguments | Returns |
|---------|-----------|---------|
| `process_song` | `filePath: string` | `Song` |
| `list_songs` | — | `Song[]` |
| `delete_song` | `songId: string` | `void` |
| `save_take` | `songId, audioData: number[], startPosition: f64` | `Take` |
| `list_takes` | `songId: string` | `Take[]` |
| `delete_take` | `songId, takeId: string` | `void` |
| `load_analysis` | `songId: string` | `{ pitchData, onsets, dynamics }` |
| `pitch_shift_song` | `songDir: string, nSteps: number` | `{ vocalsPath, instrumentalPath }` |

All commands are async and return a `Promise`. Errors are thrown as strings.

## Tauri Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `"processing-progress"` | Rust → frontend | `ProcessingStatus` |
