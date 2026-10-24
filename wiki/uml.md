# SPS: UML architecture

Song Practice Studio, drawn from the code at `v0.0.65` (mps-core `v0.14.0`). Fifteen [Mermaid](https://mermaid.js.org/) diagrams; they render on GitHub and in VS Code's Markdown preview. Mermaid has no native UML component or deployment diagram, so those are flowcharts with the UML meaning in the caption.

What is shared with VPS is shown as **mps-core** and not redrawn here: see [Shared core](shared-core.md) and `core/wiki/uml.md`. The workspace-level picture of both apps is `MPS/wiki/uml-architecture.md`; the VPS counterpart of this page is `VPS/wiki/uml.md`. When code and a diagram disagree, the code wins; fix the diagram.

What makes SPS different from VPS, and so what this page spends its diagrams on: **stems** (a dynamic set of up to six per song), **chords** (detected, editable, transposable, with a capo), **tab sync** (a Guitar Pro tab placed on the recording), **bass tab**, and **no pitch analysis of takes** (takes are only loudness-normalised).

| # | Diagram | Kind | Question |
|---|---|---|---|
| 1 | Layers and processes | Deployment | What runs, and where does each concern live? |
| 2 | Screens and panels | Component | Which page shows which components? |
| 3 | Domain model | Class | Song, stems, chords, takes, tab, bass tab, lyrics. |
| 4 | Data on disk | Component | Which file holds which part of the model? |
| 5 | Player store | Class | How is the player state split into slices? |
| 6 | AudioEngine | Class | How does a dynamic `Map` of stems differ from VPS's fixed trio? |
| 7 | Chord data flow | Component | From stems to detected chords, edits, display and export. |
| 8 | Tab sync data flow | Component | From a Guitar Pro file to bar lines on the waveform. |
| 9 | Rust backend | Class | Which modules make up the shell, who calls the sidecar? |
| 10 | Python sidecar | Component | Which commands exist, which module serves each? |
| 11 | Process a song | Sequence | Five stages from import to library. |
| 12 | Align a tab | Sequence | Import, parse, align, edit bars. |
| 13 | Record a take | Sequence | Recording and loudness normalisation. |
| 14 | Transpose | Sequence | Pitch-shifted stems swapped in place. |
| 15 | Tab states | State | The tab store's status machine. |

---

## 1. Layers and processes (deployment view)

```mermaid
flowchart LR
    subgraph machine["User machine"]
        subgraph tauri["SPS process (Tauri v2)"]
            subgraph web["WebView2 (React 19, Zustand, WaveSurfer, alphaTab)"]
                PAGES["pages: Library, Analyzer"]
                STORES["stores: player slices, library, tab, panels ..."]
                ENGINE["AudioEngine<br/>Map of stem to WaveSurfer"]
                IPCG["ipc.generated.ts"]
                SYNTH["chordSynth (audition tone)"]
            end
            subgraph rust["Rust shell"]
                CMDS["commands.rs + tab, takes, windows,<br/>youtube_signin (51 registered commands)"]
                LIB["library.rs, storage.rs, lyrics.rs, tab.rs, takes.rs"]
                SIDE["sidecar.rs (wrapper)"]
            end
        end
        SC["Python sidecar (PyInstaller)<br/>Demucs htdemucs / htdemucs_6s, librosa,<br/>chord + bass-tab + tab-sync code, yt-dlp"]
        DATA[("~/.songpracticestudio<br/>library.json, songs, stems, takes, charts")]
    end
    NET["YouTube, lyrics sources, GitHub updater"]

    PAGES --> STORES --> IPCG
    STORES --> ENGINE
    PAGES --> SYNTH
    IPCG -- "invoke()" --> CMDS
    CMDS --> LIB --> DATA
    CMDS --> SIDE
    SIDE -- "JSON lines" --> SC
    SC --> DATA
    SC --> NET
    web -- "updater" --> NET
```

## 2. Screens and panels (component view)

Two pages in a route held in `App.tsx`. The analyzer is a stack of **panels**; `chords`, `lyrics` and `takes` are in the panel store (visible, ordered, detachable), and the waveform area is collapsible but never unmounted because it owns the engine's containers.

```mermaid
flowchart TB
    APP["App.tsx<br/>route: library | analyzer songId"]
    APP --> LP["LibraryPage<br/>folders, import, StemPicker, search"]
    APP --> AP["AnalyzerPage<br/>one song"]
    APP --> UD["UpdateDialog"]

    subgraph ap["AnalyzerPage"]
        direction TB
        TOP["Topbar: TransportControls, TempoControl, KeyTranspose,<br/>CapoSelect, ChordDetailSelect, LoopButton, LoopsMenu,<br/>OutputSelector, Export buttons"]
        SV["StemView: StemTrack per stem, TakeTrack, TimeRuler,<br/>(collapsible waveform area)"]
        CR["ChordRoll panel: notes per stem, chord strip,<br/>spectrum, chord editor (note_roll.json cache)"]
        MON["MonitorControl (in the ChordRoll header):<br/>the input drawn in pink on the notes and the spectrum"]
        BT["BassTabPanel (bass stem only)"]
        TB["TabPanel + TabScoreView (alphaTab)"]
        REC["Recording: RecordButton, MicSelector, RecordingOffsetControl"]
        SP["SortablePanels (drag to reorder, detach)"]
    end
    AP --> ap
    CR --> MON
    SP --> P1["chords: ChordCarousel (now / past / next)"]
    SP --> P2["lyrics: LyricsPanel"]
    SP --> P3["takes: TakeList, TakesBar"]
    PM["PanelMenu + useAnalyzerPanels (chords, lyrics, takes)"]
    PM -.-> SP
```

## 3. Domain model (class view)

TypeScript types are in `src/lib/types.ts`, `tabScore.ts` and `bassTab.ts`; the Rust twins in `library.rs`, `tab.rs`, `takes.rs` and `lyrics.rs` (camelCase over the wire). Note: SPS's `Song` has `stems` and `hasChords` where VPS has `kind` and an artist.

```mermaid
classDiagram
    direction LR
    class Folder {
        +id
        +name
        +sortIndex
    }
    class Song {
        +id
        +title
        +duration
        +detectedKey
        +detectedBpm
        +stems : StemName list
        +hasChords
        +metronomeOffset
        +folderId
        +sortIndex
        +officialTitle
        +officialArtist
        +directory
    }
    class StemName {
        <<enumeration>>
        vocals
        drums
        bass
        guitar
        piano
        other
    }
    class NamedLoop {
        +id
        +name
        +start
        +end
    }
    class ChordSegment {
        +start
        +end
        +chord
        +bass
        +confidence (0 to 1)
        +alternatives
    }
    class ChordAlternative {
        +chord
        +fit
    }
    class Take {
        +id
        +songId
        +recordedAt
        +filepath
        +name
        +startPosition
        +audioOffset
        +manualOffset
    }
    class BassTab {
        +version
        +duration
        +notes : BassNote list
    }
    class BassNote {
        +time
        +duration
        +pitch
        +string
        +fret
    }
    class TabRecord {
        +fileName
        +originalName
        +path
        +sync : TabSync
    }
    class TabSync {
        +algorithm
        +offset
        +transpose
        +usedDrums
        +quality
        +steadiness
        +edited
        +bars : TabBar list
    }
    class TabBar {
        +index
        +occurrence
        +time
    }
    class Lyrics {
        +lines with words and timings
        +source
        +meanScore
    }

    Folder "1" o-- "0..*" Song : folderId
    Song "1" o-- "1..6" StemName
    Song "1" *-- "0..*" NamedLoop : loops
    Song "1" *-- "0..*" Take : takes.json
    Song "1" o-- "0..*" ChordSegment : chords.json, or chords_edited.json
    ChordSegment "1" *-- "0..*" ChordAlternative
    Song "1" o-- "0..1" BassTab : bass_tab.json
    BassTab "1" *-- "0..*" BassNote
    Song "1" o-- "0..1" TabRecord : tab_meta.json
    TabRecord "1" o-- "0..1" TabSync : tab_sync.json
    TabSync "1" *-- "1..*" TabBar
    Song "1" o-- "0..1" Lyrics : lyrics.json
```

## 4. Data on disk (component view)

`~/.songpracticestudio` (see `storage.rs`; it was `~/.songanalyzer` before a rename). Chords the user corrected live in a separate file that wins when present, so re-detecting never destroys the detected result unasked.

```mermaid
flowchart TB
    ROOT["~/.songpracticestudio"]
    ROOT --> LJ["library.json<br/>songs + folders"]
    ROOT --> YC["youtube_cookies.txt"]
    ROOT --> MD["models/ (lyrics-sync model)"]
    ROOT --> SD["library/ID/ (one folder per song)"]
    SD --> ST["STEM.wav per extracted stem<br/>(vocals, drums, bass, guitar, piano, other)"]
    SD --> CH["chords.json (detected, v6, with tuning)"]
    SD --> CE["chords_edited.json (user corrections)"]
    SD --> BTJ["bass_tab.json"]
    SD --> TAB["tab.EXT (imported Guitar Pro file)"]
    SD --> TM["tab_meta.json, tab_score.json, tab_sync.json"]
    SD --> LY["lyrics.json"]
    SD --> TJ["takes.json"]
    SD --> TK["takes/ID.wav (normalised) or ID.webm (fallback)"]
    SD --> PS["pitched/N/STEM.wav (transpose cache)"]
    LJ -. "Song.directory" .-> SD
```

## 5. Player store (class view)

One `usePlayerStore` built from seven slices in `src/stores/player/`. The chords slice is only presentation preferences (capo, detail level, a revision counter); the chord data itself is fetched per song, not held in the store.

```mermaid
classDiagram
    direction TB
    class PlayerStore {
        <<usePlayerStore>>
    }
    class TransportSlice {
        isPlaying, currentTime, playbackRate, duration
        loopStart, loopEnd, isLooping
        play() pause() seek() stop()
    }
    class MixerSlice {
        stem volumes, mute, solo
        transpose, isTransposing
        setTranspose()
    }
    class TimelineSlice {
        minPxPerSec, scrollTime
        punchIn, punchOut, loops
        metronomeOffset
    }
    class DevicesSlice {
        audio + output devices
        recordingOffsets, usedLatencyFallback
        applyCalibration()
    }
    class RecordingSlice {
        isRecording, isSavingTake, count-in
        startRecording() stopRecording()
    }
    class TakesSlice {
        takes, shown, active, muted, soloed, gains
        fetchTakes() deleteTake() renameTake()
    }
    class ChordsSlice {
        capo, chordsRevision, chordDetail
        setCapo() bumpChordsRevision() setChordDetail()
    }
    class Helpers {
        <<files>>
        audioMix.ts (pure gain and mix maths)
        prefs.ts (localStorage)
        singletons.ts (engine, recorder, session)
    }
    PlayerStore *-- TransportSlice
    PlayerStore *-- MixerSlice
    PlayerStore *-- TimelineSlice
    PlayerStore *-- DevicesSlice
    PlayerStore *-- RecordingSlice
    PlayerStore *-- TakesSlice
    PlayerStore *-- ChordsSlice
    PlayerStore ..> Helpers
```

## 6. AudioEngine (class view)

The structural difference from VPS: stems are a `Map<string, WaveSurfer>` because the set differs per song. The first stem loaded (vocals when present) becomes the **master clock**.

```mermaid
classDiagram
    direction LR
    class AudioEngine {
        -_stems : Map of name to WaveSurfer
        -_master : WaveSurfer
        -_takes : Map of id to TakeTrack
        -_silentStems : Set
        -_loadToken (cancels stale loads)
        +load() reloadStemsFromPaths()
        +play() pause() stop() seekTo()
        +setStemVolume() setPlaybackRate() setOutputDevice()
        +loadTakeTrack() removeTakeTrack() setTakeManualOffset()
        +setActiveTakeTrack() setAudibleTakeTracks() setTakeGains()
        +zoomAll() setScrollAll()
        +setLoop() clearLoop() getCurrentTime()
        -rAF tick 60 fps, notify 30 fps
        -drift check every 250 ms, 50 ms tolerance
    }
    class TakeTrack {
        id
        ws : WaveSurfer
        offset
        audioOffset
        manualOffset
    }
    class STEM_COLORS {
        <<constant>>
        vocals blue, drums purple, bass green
        guitar orange, piano yellow, other grey
    }
    AudioEngine *-- "0..*" TakeTrack
    AudioEngine ..> STEM_COLORS
```

## 7. Chord data flow (component view)

Detection is done once, at import (or on demand), by the sidecar; everything after that is cheap, pure TypeScript.

```mermaid
flowchart LR
    subgraph sidecar["Python sidecar (processor.py)"]
        direction TB
        S1["stems without drums and vocals<br/>(else the original file)"]
        S2["beat windows (librosa beat track)<br/>or fixed 1 s grid"]
        S3["chroma templates: 24 triads, 7 / maj7 / min7,<br/>slash bass from the bass stem"]
        S4["Viterbi (switch cost + key prior)"]
        S1 --> S2 --> S3 --> S4
    end
    S4 --> CJ["chords.json v6<br/>segments + confidence + alternatives + tuning"]
    UE["user corrections<br/>(ChordRoll: strip, handles, +, editor)"] --> CEJ["chords_edited.json (wins when present)"]
    CJ --> RS["read_song_chords"]
    CEJ --> RS
    RS --> FE["lib/chords.ts useChordSegments"]

    subgraph pure["Pure TypeScript in lib/"]
        direction TB
        CN["chordNames: transpose, simplify by detail<br/>(Easy / Medium / Advanced)"]
        KC["keyChords: chords of the key"]
        CV["chordVoicing: shapes to play<br/>(chords shown shifted by transpose minus capo)"]
        SE["sections: group repeating chord blocks<br/>(cannot yet tell verse from chorus)"]
        CE["chordEdit: set, split, join, move, add"]
        CC["chordChart: text chart export"]
    end
    FE --> pure
    pure --> UI["ChordCarousel, ChordRoll (strip, editor, spectrum),<br/>ExportChartButton, LoopsMenu sections"]
    UI --> SY["chordSynth (audition tone)"]
    UE -. "save_chord_edits" .-> CEJ
    RD["redetect_song_chords"] -. "detect_chords, deletes edits" .-> sidecar
```

## 8. Tab sync data flow (component view)

The Guitar Pro file is parsed **in the WebView** (alphaTab) into a compact `TabScore`; the sidecar never reads Guitar Pro files. The alignment places bar lines on the recording with chroma plus kick/snare features and a banded DTW, and the user can then drag bars.

```mermaid
flowchart LR
    GP["Guitar Pro file"] --> IMP["import_song_tab (Rust)<br/>copy to tab.EXT, max 20 MB"]
    GP --> AT["tabScore.ts + alphaTab<br/>readScore, tabTracks, buildTabScore"]
    AT --> TS["TabScore JSON<br/>bars, ticks, notes by role g b k d"]
    TS --> AL["align_song_tab (Rust)<br/>tab::align_impl"]
    AL -- "align_tab: scorePath, stemPaths" --> PY["tab_sync.py<br/>score_features + audio_features<br/>best_offset, banded_dtw, quality"]
    PY --> SY["tab_sync.json<br/>bars with times, offset, quality, steadiness"]
    SY --> TR["TabRecord / TabSync"]
    TR --> UI["TabPanel, TabScoreView<br/>bar lines over the stems"]
    UI -- "drag a bar" --> SB["save_tab_bars -> edited = true"]
    SB --> SY
    PY -. "event tab-progress" .-> UI
```

## 9. Rust backend (class view)

`sidecar.rs` and `windows.rs` are thin wrappers over core crates, as in VPS. SPS owns two modules VPS does not have: `tab.rs` (tab storage and alignment) and `takes.rs` (take list persistence).

```mermaid
classDiagram
    direction TB
    class Commands {
        <<commands.rs>>
        process_song import_youtube pitch_shift_song
        read_song_chords redetect_song_chords
        save_chord_edits clear_chord_edits has_chord_edits
        read_bass_tab read_chord_tuning
        read_song_tab import_song_tab align_song_tab
        save_tab_bars delete_song_tab
        save_take list_takes export_mix export_file ...
    }
    class SidecarState {
        Mutex of Option of SidecarManager
    }
    class SidecarWrapper {
        <<sidecar.rs>>
        CONFIG
        Deref to mps_sidecar::SidecarManager
    }
    class Library {
        <<library.rs>>
        Song, Folder, NamedLoop
        ChordSegment, BassTab
        chords.json + chords_edited.json
        library.json
    }
    class TabMod {
        <<tab.rs>>
        TabRecord TabSync TabBar
        read import delete align_impl save_bars
    }
    class TakesMod {
        <<takes.rs>>
        Take
        load add remove rename set_manual_offset
    }
    class LyricsMod {
        <<lyrics.rs>>
        lyrics.json atomic write
        sync_impl find_impl
    }
    class Storage {
        <<storage.rs>>
        app_data_dir library_dir song_dir
    }
    class WindowsMod {
        <<windows.rs>>
        PANELS PanelSpec table
    }
    class CoreCrates {
        <<mps-core Rust>>
        mps-sidecar
        mps-detached-windows
        mps-youtube-signin
    }
    Commands --> SidecarState : locks
    SidecarState o-- SidecarWrapper
    SidecarWrapper ..> CoreCrates
    Commands --> Library
    Commands --> TabMod
    Commands --> TakesMod
    Commands --> LyricsMod
    TabMod --> Storage
    TakesMod --> Storage
    Library --> Storage
    WindowsMod ..> CoreCrates
```

## 10. Python sidecar (component view)

```mermaid
flowchart TB
    MAIN["main.py<br/>loop: read line, dispatch cmd, send result / progress"]
    MAIN -- "process<br/>pitch_shift<br/>detect_chords" --> PROC["processor.py<br/>Demucs (htdemucs, htdemucs_6s cascade),<br/>BPM, key, chords, bass tab, pitch shift"]
    MAIN -- "convert_take<br/>normalize_take<br/>mix_export" --> REC["recording.py<br/>RMS normalise, decode to WAV, mixdown"]
    MAIN -- "align_tab" --> TS["tab_sync.py<br/>chroma + kick/snare features, banded DTW"]
    MAIN -- "import_yt" --> YT["yt_importer.py<br/>yt-dlp, cookie cascade"]
    MAIN -- "align_lyrics<br/>find_lyrics<br/>search_lyrics" --> ML["mps_core.lyrics (core)"]
    MAIN -- "ping / quit" --> CTL["liveness + clean exit"]
    MAIN --> ID["mps_core.app.AppIdentity<br/>mps_core.version_check"]
    PROC --> VEND["vendor/ (bundled models)"]
    subgraph dev["Dev tools (not shipped)"]
        TC["tab_chords.py<br/>tab -> reference chord chart"]
        CEV["chord_eval.py<br/>score detected vs reference (WCSR)"]
        CL["chord_lab/<br/>benchmark, tune, plot, sonify"]
    end
    CEV -.-> PROC
    TC -.-> TS
    CL -.-> PROC
```

## 11. Process a song (sequence view)

```mermaid
sequenceDiagram
    actor U as User
    participant DZ as DropZone + StemPicker
    participant LS as library store
    participant R as commands.rs
    participant P as processor.py
    participant FS as ~/.songpracticestudio

    U->>DZ: pick file and stems (guitar / piano optional)
    DZ->>LS: process(file, stems, highQuality)
    LS->>R: invoke("process_song")
    R->>P: {"cmd":"process", stems, ...}
    P->>P: 1 Demucs separation (0 to 0.75)
    P->>FS: STEM.wav files
    P->>P: 2 BPM (to 0.86)
    P->>P: 3 key, Krumhansl-Kessler (to 0.92)
    P->>P: 4 chords (to 0.96, non-fatal)
    P->>FS: chords.json
    P->>P: 5 bass tab if a bass stem exists (to 1.0, non-fatal)
    P->>FS: bass_tab.json
    P-->>R: {stems, duration, detectedBpm, detectedKey, chords, bassTab}
    Note over R,LS: progress events "processing-progress" throughout
    R->>FS: library.json (Song with stems, hasChords)
    R-->>LS: Song
    LS-->>U: song in the library
```

## 12. Align a tab (sequence view)

Importing a tab aligns it straight away; the **Align** button runs the same alignment again later. The Guitar Pro file is read in the WebView (alphaTab), never in the sidecar.

```mermaid
sequenceDiagram
    actor U as User
    participant TP as TabPanel
    participant TS as tab store
    participant AT as tabScore.ts (alphaTab)
    participant R as Rust (tab.rs)
    participant P as tab_sync.py

    U->>TP: Import tab (.gp file)
    TP->>TS: importTab(songId, path)
    Note over TS: status = importing
    TS->>R: invoke("import_song_tab")
    R-->>TS: TabRecord (no sync yet)
    Note over TS: status = aligning (starts by itself)
    TS->>AT: read the stored file bytes, readScore, buildTabScore
    AT-->>TS: TabScore as JSON
    TS->>R: invoke("align_song_tab", scoreJson)
    R->>P: {"cmd":"align_tab", scorePath, stemPaths, outputPath}
    loop stages
        P-->>R: progress
        R-->>TS: event "tab-progress"
    end
    P-->>R: result (bars, offset, quality)
    R->>R: write tab_sync.json
    R-->>TS: TabSync
    Note over TS: status = idle
    U->>TP: drag a bar line
    TP->>TS: saveBars(bars)
    TS->>R: invoke("save_tab_bars")
    R-->>TS: TabSync (edited = true)
```

## 13. Record a take (sequence view)

SPS records and stores a take but does not analyse its pitch; the sidecar only normalises loudness against the vocals stem.

```mermaid
sequenceDiagram
    actor U as User
    participant RB as RecordButton
    participant RS as RecordingSlice
    participant E as AudioEngine
    participant REC as VocalRecorder (core)
    participant R as save_take (Rust)
    participant P as recording.py

    U->>RB: click Record
    RB->>RS: startRecording()
    RS->>RS: liveMonitorGate.stop() (the Monitor gives the input back)
    RS->>REC: init(mic), pin hardware output
    RS->>E: play from punchIn or playhead
    RS->>REC: start()
    U->>RB: click Stop
    RB->>RS: stopRecording()
    RS->>REC: stop() returns audio bytes
    Note over RS: isSavingTake = true
    RS->>R: invoke("save_take", bytes, startPosition, audioOffset)
    R->>R: write takes/ID.webm
    R->>P: {"cmd":"normalize_take", reference: vocals.wav}
    P-->>R: takes/ID.wav (makeup gain, peak ceiling)
    R->>R: takes.json (WAV path, or webm if normalising failed)
    R-->>RS: Take
    RS->>RS: fetchTakes(), new take active
```

## 14. Transpose (sequence view)

```mermaid
sequenceDiagram
    actor U as User
    participant KT as KeyTranspose
    participant MS as MixerSlice
    participant R as pitch_shift_song (Rust)
    participant P as processor.py
    participant E as AudioEngine

    U->>KT: +2 semitones
    KT->>MS: setTranspose(2)
    Note over MS: isTransposing = true
    MS->>R: invoke("pitch_shift_song", songDir, stems, 2)
    alt cached in pitched/2/
        R-->>MS: paths of cached stems
    else not cached
        R->>P: {"cmd":"pitch_shift", stems, nSteps}
        P-->>R: pitched/2/STEM.wav (phase vocoder)
        R-->>MS: paths
    end
    MS->>E: reloadStemsFromPaths(paths)
    Note over E: every loaded stem swaps its file, playhead kept
    Note over MS: isTransposing = false, chord names shift with transpose
```

## 15. Tab states (state view)

`TabStatus` in the tab store. Any failure ends in `Error` (the message is shown, and after a failed import the stored record is read again); `clearError` returns to `Idle`.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : load(songId)
    Loading --> Idle : record read (or none)
    Idle --> Importing : importTab
    Importing --> Aligning : file stored, alignment starts by itself
    Idle --> Aligning : align (again)
    Aligning --> Idle : TabSync stored
    Idle --> Idle : remove (tab deleted)
    Loading --> Error : failure
    Importing --> Error : failure (size, format)
    Aligning --> Error : failure (empty tab, sidecar error)
    Error --> Idle : clearError
```

## 16. Monitor: the input against the song (component view)

The Monitor in the chord roll listens to the input chosen in the mic menu and never records. `liveMonitorGate` (in the player store's `singletons.ts`) exists because the player store cannot import the monitor's store, which imports the player store; `startRecording` stops the monitor through it first.

```mermaid
flowchart LR
    MC["MonitorControl<br/>toggle, level meter, status"] --> LS["useLiveInput<br/>(liveInputStore: off, starting, on, error, reading)"]
    LS --> LM["createLiveMonitor<br/>100 ms loop, deps injected"]
    LM --> OPEN["openLiveInput<br/>getUserMedia, loudest channel"]
    OPEN --> DEV["Input device"]
    LM --> AN["LiveAnalyser<br/>spectrum + note strengths of the newest window"]
    AN --> NR["noteRoll: frameStrengths, strengthOf<br/>(same scale as a stem)"]
    LM --> TR["liveTrace (LiveTrace)<br/>notes by roll frame"]
    LM -- "reading" --> LS
    PS["PlayerStore<br/>selectedDeviceId, isPlaying, recordingOffsets"] -- "clock: time + calibrated latency" --> LM
    TR --> CRD["ChordRoll draw loop<br/>pink bars, read every frame"]
    LS --> CSP["ChordSpectrumPanel<br/>pink curve, You play C readout"]
    CSP --> CS["chordSpectrum: readTones, isPresent"]
    GATE["liveMonitorGate"] -. "stop() before recording" .-> LS
    PS -. "another input chosen" .-> LS
```

---

## Keeping this current

- Change the matching diagram in the same commit as a structural change (new slice, command, sidecar `cmd`, module, or on-disk file).
- Names in diagrams are searchable in the code. Drift risks: the slice list (5), the registered-command count (1; `generate_handler!` in `lib.rs`), the sidecar command table (10), the processing stages and progress ranges (11, mirrored from `CLAUDE.md`), `ANALYZER_PANELS` (2).
- Every diagram was parsed with Mermaid 11.4.1 (`mermaid.parse`) on 2026-10-18; layout was not viewed. There is no CI check, so re-preview after editing.
