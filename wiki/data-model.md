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
  directory: string;    // absolute path to ~/.songpracticestudio/library/{id}/
  stems: StemName[];    // e.g. ["vocals","drums","bass","guitar","piano","other"]
  hasChords?: boolean;  // true if chords.json was written during processing — see read_song_chords
  metronomeOffset?: number; // song time (s) where the metronome's beat 1 lands
  folderId?: string | null; // library folder this song belongs to; null/absent = root
  sortIndex: number;        // rank among sibling songs sharing the same folderId
}
```

### Folder

```ts
interface Folder {
  id: string;
  name: string;
  sortIndex: number; // rank among sibling folders
}
```

Flat (non-nested) user-named grouping of songs in the library, e.g. all songs by one band. See [Components: Library Folders](components.md#library-folders-drag-and-drop).

### ChordSegment

```ts
interface ChordSegment {
  start: number;  // seconds
  end: number;    // seconds
  chord: string;  // e.g. "C:maj" / "A:min" — formatted for display via formatChordName() in lib/chords.ts
}
```

One detected chord over a time range, from `_detect_chords_chroma()`'s chroma-template matching in `processor.py`. Not embedded in `Song` — fetched on demand via `read_song_chords(songId)`, which reads `chords.json` from the song's directory. See [Components: ChordCarousel](components.md#chordcarousel).

**`metronomeOffset`** — set via `set_metronome_offset(songId, offset)`, which mirrors `rename_take`'s "find by id, mutate one field, re-save library.json" shape rather than going through `library::add`. `null`/absent means the metronome phase-locks to song position 0 (unchanged legacy behavior). See [Components: TempoControl](components.md#tempocontrol).

### Take

```ts
interface Take {
  id: string;
  songId: string;
  recordedAt: string;     // ISO timestamp
  filepath: string;       // RMS-normalized .wav (raw .webm only if normalization failed)
  name?: string;          // user-assigned; UI falls back to "Take N"
  startPosition: number;  // song time (seconds) where recording began; 0 for full-song takes
  audioOffset?: number;   // seconds into the file to skip on playback (latency compensation overflow)
  manualOffset?: number;  // seconds, signed; user drag nudge on top of startPosition (see Manual Take Sync)
}
```

Unlike VPS's `Take`, there are no analysis fields (`pitchData`, `vibrato`, …) — SPS does no take analysis.

**`manualOffset`** — set via `set_take_manual_offset(songId, takeId, offset)` (mirrors `rename_take`'s "find by id, mutate one field, re-save takes.json" shape), a post-recording user adjustment layered additively on top of `startPosition`, distinct from and independent of `audioOffset`'s one-time auto-latency-compensation. `0`/absent means the take sits at its auto-detected position. See [Audio Engine: Manual Take Sync](audio-engine.md#manual-take-sync) and [Components: Take Sync Controls](components.md#take-sync-controls).

### Lyrics

Stored as `lyrics.json` in the song directory, written atomically. See [Lyrics Sync](lyrics.md).

```ts
interface LyricWord { text: string; start: number; end: number; score: number }
interface LyricLine { text: string; start: number; end: number; score: number; words: LyricWord[] }
interface Lyrics {
  version: number;
  source: "paste" | "lrclib";
  text: string;            // exactly as supplied, kept so it can be edited and re-synced
  aligner: string;
  alignedAt: string;
  meanScore: number;
  warning?: string | null; // set when the text probably does not fit the recording
  lines: LyricLine[];
}
interface FoundLyrics { text: string; synced: boolean; title: string; artist: string; source: string }
interface LyricsProgress { songId: string; progress: number; stage: string }   // "lyrics-progress" event
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

All data lives under `~/.songpracticestudio/` (`C:\Users\{user}\.songpracticestudio\` on Windows).

`library.json`'s top-level shape is `{ folders: Folder[], songs: Song[] }` (changed from a bare `Song[]` array when folders were added). `library::load()` falls back to parsing the legacy raw-array shape and wraps it as `{ folders: [], songs }` in memory — old libraries open with no migration step, and the file is only actually rewritten in the new shape on the next mutation.

```
~/.songpracticestudio/
├── library.json           master index of all Folder + Song records
├── models/
│   └── wav2vec2_fairseq_base_ls960_asr_ls960.pth   speech model for lyrics sync, downloaded on first use
└── library/
    └── {songId}/          UUID directory per song
        ├── {original}.mp3 copy of the source file (or source.wav for YouTube imports)
        ├── vocals.wav     separated vocals stem
        ├── drums.wav      separated drums stem
        ├── bass.wav       separated bass stem
        ├── guitar.wav     separated guitar stem
        ├── piano.wav      separated piano stem
        ├── other.wav      separated other/residual stem
        ├── chords.json    detected chord segments
        ├── lyrics.json    synced lyrics (see lyrics.md)
        ├── takes.json     Take[] metadata
        └── takes/
            └── {takeId}.wav  RMS-normalized take audio (raw .webm kept only when normalization failed)
```

## Tauri Commands

| Command | Arguments | Returns |
|---------|-----------|---------|
| `process_song` | `filePath: string, stemsToExtract?: StemName[], highQuality?: boolean` | `Song` |
| `import_youtube` | `url: string, stemsToExtract?: StemName[], highQuality?: boolean` | `Song` |
| `list_songs` | — | `Song[]` |
| `delete_song` | `songId: string` | `void` |
| `set_metronome_offset` | `songId: string, offset?: f64` | `Song` (persists the metronome's downbeat anchor; `null` clears it back to song start) |
| `read_song_chords` | `songId: string` | `ChordSegment[]` (reads `chords.json` on demand; empty if the song predates chord detection or detection failed) |
| `list_folders` | — | `Folder[]` |
| `create_folder` | `name: string` | `Folder` (empty/whitespace name rejected) |
| `rename_folder` | `folderId, name: string` | `Folder` (empty/whitespace name rejected) |
| `delete_folder` | `folderId: string` | `void` (member songs' `folderId` cleared, songs not deleted) |
| `reorder_folders` | `orderedIds: string[]` | `Folder[]` (reassigns `sortIndex` 0..N) |
| `move_songs` | `folderId: string \| null, orderedSongIds: string[]` | `Song[]` (sets `folderId` + sequential `sortIndex` on exactly the given songs — covers both a same-folder reorder and a cross-folder move-at-position in one call) |
| `save_take` | `songId, audioData: number[], startPosition: f64, audioOffset: f64` | `Take` (RMS-normalizes via sidecar `normalize_take`) |
| `list_takes` | `songId: string` | `Take[]` |
| `delete_take` | `songId, takeId: string` | `void` |
| `rename_take` | `songId, takeId, name: string` | `Take` (empty/whitespace name resets to default) |
| `set_take_manual_offset` | `songId, takeId, offset: f64` | `Take` (`0` resets to the auto-detected position) |
| `export_stem` | `stemPath, suggestedName: string` | `void` (native Save-As dialog) |
| `export_take` | `takePath, suggestedName: string` | `void` (always WAV; sidecar `convert_take` first) |
| `export_mix` | `sources: MixSource[], startSec, endSec: f64, suggestedName: string` | `void` (sidecar `mix_export`, then Save-As) |
| `export_all` | `entries: ZipEntry[] ({path, archiveName}), suggestedName: string` | `void` (native Save-As dialog for `.zip`; `zip` crate writes each entry, no sidecar involved) |
| `pitch_shift_song` | `songDir: string, stemNames: string[], nSteps: i32` | `{ stems: Record<string, string> }` (phase-vocoder shift via sidecar `pitch_shift`, cached under `{songDir}/pitched/{nSteps}/{stem}.wav`; ported from VPS, generalized from the fixed vocals/instrumental pair — see `wiki/audio-engine.md#key-transpose`) |
| `load_lyrics` | `songId: string` | `Lyrics` or `null` |
| `sync_lyrics` | `songId, text: string, source?: "paste"/"lrclib"` | `Lyrics` (aligns via sidecar `align_lyrics`, persists `lyrics.json`, emits `"lyrics-progress"`; errors for empty text / song without the vocals stem or file) |
| `find_lyrics` | `songId: string` | `FoundLyrics` (sidecar `find_lyrics` with the song's title and duration; nothing is saved) |
| `delete_lyrics` | `songId: string` | `void` (no error when there are none) |

All commands are async and return a `Promise`. Errors are thrown as strings.

## Tauri Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `"processing-progress"` | Rust → frontend | `ProcessingStatus` |
| `"lyrics-progress"` | Rust → frontend | `LyricsProgress` |
