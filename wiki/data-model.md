# Data Model

**Key files:** `src/lib/types.ts` · `src-tauri/src/commands.rs` · `src-tauri/src/library.rs` · `src-tauri/src/storage.rs`

## TypeScript Interfaces

### Song

```ts
interface Song {
  id: string;           // UUID
  title: string;
  duration: number;     // seconds
  detectedBpm?: number;
  detectedKey?: string; // e.g. "C minor"
  processedAt: string;  // ISO timestamp
  directory: string;    // absolute path to ~/.songanalyzer/library/{id}/
  stems: StemName[];    // e.g. ["vocals","drums","bass","guitar","piano","other"]
}
```

### StemName

```ts
type StemName = "vocals" | "drums" | "bass" | "guitar" | "piano" | "other";
```

All six stems are produced by `htdemucs_6s`. The `stems` array on `Song` lists only the stems that were successfully written to disk.

### ProcessingStatus (event payload)

```ts
interface ProcessingStatus {
  songId: string;
  progress: number;  // 0–1
  stage: string;     // e.g. "separating", "detecting bpm", "detecting key"
  isComplete: boolean;
  error?: string;
}
```

## Storage Layout

All data lives under `~/.songanalyzer/` (`C:\Users\{user}\.songanalyzer\` on Windows).

```
~/.songanalyzer/
├── library.json           master index of all Song records
└── library/
    └── {songId}/          UUID directory per song
        ├── {original}.mp3 copy of the source file (or source.wav for YouTube imports)
        ├── vocals.wav     separated vocals stem
        ├── drums.wav      separated drums stem
        ├── bass.wav       separated bass stem
        ├── guitar.wav     separated guitar stem
        ├── piano.wav      separated piano stem
        └── other.wav      separated other/residual stem
```

## Tauri Commands

| Command | Arguments | Returns |
|---------|-----------|---------|
| `process_song` | `filePath: string` | `Song` |
| `import_youtube` | `url: string` | `Song` |
| `list_songs` | — | `Song[]` |
| `delete_song` | `songId: string` | `void` |
| `export_stem` | `songId, stemName: string` | `void` (native Save-As dialog) |

All commands are async and return a `Promise`. Errors are thrown as strings.

## Tauri Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `"processing-progress"` | Rust → frontend | `ProcessingStatus` |
