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
  loops?: NamedLoop[];  // saved named regions, see set_song_loops
  hasChords?: boolean;  // true if chords.json was written during processing — see read_song_chords
  metronomeOffset?: number; // song time (s) where the metronome's beat 1 lands
  folderId?: string | null; // library folder this song belongs to; null/absent = root
  sortIndex: number;        // rank among sibling songs sharing the same folderId
  officialTitle?: string;   // what online lookups search for; `title` is free for the user to rename
  officialArtist?: string;
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
  chord: string;  // "C:maj", "A:min", "G:7", "C:maj7", "A:min7" — formatted for display via formatChordName() in lib/chordNames.ts
  bass?: string;  // the bass note when the bass stem plays a chord tone other than the root (a slash chord), e.g. "E" for C/E
}
```

One detected chord over a time range, from `_chords_from_signal()`'s chroma-template matching in `processor.py` (`chords.json` version 6 adds the document-level `tuning` (cents off A440, + is sharp; read by `read_chord_tuning`, 0 when absent) and per segment `alternatives` (`[{chord, fit}]`, best first, up to six, ranked on fit + seventh margin + key bonus, the chosen chord left out; `clean_chord_segments` drops an entry that is not a chord and clamps the fit); version 5 adds `confidence` (0-1, duration-weighted cosine fit of the chosen chord to the audio; absent on older files and on any chord the user set by hand, and `LOW_CONFIDENCE` = 0.72 in `lib/chords.ts` is where `ChordRow` starts dimming); version 4: windows follow the beats and are decoded with Viterbi; version 3 was read from the stems without drums and vocals on a fixed 1 s grid with a median filter; version 2 files have the same shape but were read from the full mix, version 1 files hold triads only; all are still read. Re-detect chords upgrades an old song). Not embedded in `Song` — fetched on demand via `read_song_chords(songId)`, which reads `chords_edited.json` (the user's corrections, same shape, `version` 1) when it exists, otherwise `chords.json` from the song's directory. `save_chord_edits` sorts and rounds to the millisecond and rejects a chord that is not `Root:quality` (sharp roots; maj, min, 7, maj7, min7, sus2, sus4, dim, aug, 6), a bass note that is not one of the twelve, a segment under 0.05 s or with a bad time, and overlaps. See [Components: ChordCarousel](components.md#chordcarousel).

**`note_roll.json`** (next to `chords.json`, written by the chord roll, not the sidecar) — the per-stem note strengths the chord roll draws: `{ version, hop, notes, transpose, stems: { <stem>: { frames, data } } }`, `data` a base64 `Uint8Array` of `frames × notes` (E1 to E6, 0 to 255). Read and written through `read_note_roll` / `save_note_roll` (opaque JSON text to Rust, validated as JSON, written atomically). A file of another `version`, `hop` or note count is ignored and made again.

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
        ├── chords_edited.json  the user's corrected chords (only when edited; wins over chords.json)
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
| `read_bass_tab` | `songId: string` | `BassTab` or `null` (`bass_tab.json`: `{version, duration, notes[]}`; `null` when the song has none) |
| `export_file` | `data: u8[], suggestedName: string` | `void` (Save As for a file the app built; only `.txt` and `.mid` names are accepted) |
| `set_song_loops` | `songId: string, loops: NamedLoop[]` | `Song` (replaces the saved loops; names trimmed, at most 100, 1-80 characters, regions at least 0.25 s, unique ids, stored in time order) |
| `rename_song` | `songId: string, title: string` | `Song` (title trimmed; empty or whitespace is rejected; leaves `officialTitle` alone, and a song with none yet gets its old title copied into it first) |
| `set_song_identity` | `songId, officialTitle: string \| null, officialArtist: string \| null` | `Song` (trimmed; blank clears, and the lookup then falls back to `title`) |
| `set_metronome_offset` | `songId: string, offset?: f64` | `Song` (persists the metronome's downbeat anchor; `null` clears it back to song start) |
| `read_song_tab` | `songId: string` | `TabRecord` or `null` (`{fileName, originalName, path, sync}`; `sync` is `tab_sync.json` once aligned) |
| `import_song_tab` | `songId: string, sourcePath: string` | `TabRecord` (copies a `.gp`/`.gp3`-`.gp5`/`.gpx`/`.musicxml`/`.xml` of at most 20 MB next to the song as `tab.<ext>`, replacing an earlier tab and its alignment) |
| `align_song_tab` | `songId: string, scoreJson: string` | `TabSync` (runs the sidecar, stores `tab_sync.json`; emits `tab-progress`) |
| `save_tab_bars` | `songId: string, bars: TabBar[]` | `TabSync` (hand-corrected bar lines: same bars, times finite, non-negative, not running backwards; sets `edited`) |
| `delete_song_tab` | `songId: string` | `void` |
| `read_chord_tuning` | `songId: string` | `number` (cents the recording sits from A440, + is sharp; 0 when it was not measured or there are no chords) |
| `redetect_song_chords` | `songId: string` | `Song` (detects the chords again from the stems with the current model, replaces `chords.json`, deletes the user's corrections, sets `hasChords`) |
| `cancel_lyrics_sync` | — | `void` (abandons the running `sync_lyrics`, which then fails with "Cancelled.") |
| `read_song_chords` | `songId: string` | `ChordSegment[]` (the user's corrections from `chords_edited.json` when there are any, otherwise `chords.json`; an error when the song has neither) |
| `save_chord_edits` | `songId: string, segments: ChordSegment[]` | `ChordSegment[]` (validated, sorted, rounded; written atomically to `chords_edited.json`) |
| `clear_chord_edits` | `songId: string` | `void` (deletes `chords_edited.json`; not an error when there is none) |
| `has_chord_edits` | `songId: string` | `bool` |
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
| `find_lyrics` | `songId: string` | `FoundLyrics` (sidecar `find_lyrics` with the song's official title/artist and duration; nothing is saved) |
| `search_lyrics` | `songId: string` | `LyricsSearch` (sidecar `search_lyrics`: every usable result, best first; nothing is saved) |
| `delete_lyrics` | `songId: string` | `void` (no error when there are none) |

All commands are async and return a `Promise`. Errors are thrown as strings.

## Tauri Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `"processing-progress"` | Rust → frontend | `ProcessingStatus` |
| `"lyrics-progress"` | Rust → frontend | `LyricsProgress` |
