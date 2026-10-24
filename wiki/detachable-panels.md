# Detachable panels

Any optional panel of the analyzer page can be dragged out into a window of its own, for a second monitor: **Chords** (the carousel of the Chords card in the top bar), **Lyrics** and **Takes**. Lyrics and Takes are shown or hidden from the Panels menu; the Chords card from the Cards menu (`sps_topbar`), which closes its window the same way. The waveforms, mixer, transport and microphone stay in the main window. Ported from VPS (see `MPS/wiki/lineage.md`); on branch `feat/detachable-panels`, not released.

## The model

The main window stays the only owner of the audio engine, the microphone, recording and the song state. A detached window is a **remote view**: it runs the same panel component (`ChordCarousel`, `LyricsPanel`, `TakeList`) against its own player store, which is fed from the main window.

| Event | Direction | Content |
|---|---|---|
| `mps:hello` | detached → main | `{ panelId }`, once, after listening |
| `mps:state` | main → detached | transport snapshot `{ time, playing, rate, sentAt }` and the shared state: song, duration, takes, active take id, which takes are shown |
| `mps:command` | detached → main | `seek`, `toggleTake`, `deleteTake`, `renameTake` |
| `mps:docked` | Rust → main | panel id, when its window is destroyed |

Time is not streamed 30 times a second: the detached window extrapolates from the snapshot (`RemoteClock`) and the main window only resends on a change, a seek or a 1 s heartbeat. Until a window says hello the main window publishes nothing and runs no timer. Takes are small here (no analysis arrays), so the whole list is mirrored, and the takes list's `fetchTakes()` is replaced by a no-op in the detached window.

## Where things live

| File | Role |
|---|---|
| `@giamat90/mps-core/windows` | the generic half: clock, both bridges, drag gestures, detached store, guards. Shared with VPS |
| `src/windows/protocol.ts` | the three panel ids, `SharedState`, `Command`, `parseCommand`, `isSharedState` |
| `src/windows/mainBridge.ts`, `detachedBridge.ts` | this app's shared state and commands on top of the core bridges |
| `src/windows/useMainBridge.ts`, `DetachedHost.tsx` | the React ends; `main.tsx` picks `DetachedHost` from the window label |
| `src/components/panels/DetachHandle.tsx`, `DockHandle.tsx` | corner grip / pop-out on a panel; dock grip in a detached window |
| `src/stores/detached.ts` | which panels are in their own window (never persisted) |
| `src-tauri/src/windows.rs` | SPS's panel table and the five `#[tauri::command]` wrappers (`detach_panel`, `dock_panel`, `close_detached_panel`, `cursor_over_main`, `close_detached_windows`); the allowlist check, remembered geometry (`~/.songpracticestudio/detached_windows.json`) and docking are mps-core's `mps-detached-windows` crate |
| `src-tauri/capabilities/detached.json` | events and core only: no dialog or updater access |

The window handling is shared with VPS in mps-core's `mps-detached-windows` crate; this app supplies the panel table and the data directory. `tests/contract/detachablePanels.test.ts` compares the table with `DETACHABLE_PANELS`; the label prefix and the `mps:docked` event are pinned in mps-core against its frontend half.

## Behaviour

- Drag the ⋮⋮ grip of a panel past the edge of the window to detach it there, or press ⤢ to pop it out where it was last (only if that spot is still on a connected monitor). Size is always remembered.
- In the detached window: Dock button, closing the window, or carrying the ⋮⋮ grip in its bar over the main window and releasing. Moving the window by its title bar never docks it.
- Hiding a detached panel in the Panels menu closes its window; the menu marks panels that are "own window". Leaving the analyzer page closes every detached window, and so does closing the main window.
- Lyrics sync, find online and edit work from the detached window (the commands and `lyrics-progress` are app-wide). The docked panel reloads `lyrics.json` when it is mounted again.

## Trying it by hand

1. `npm run tauri dev`, open a song with chords and vocals, record or select a take.
2. Detach each panel (grip drag outside the window, and ⤢).
3. Play, seek on the main waveform: the detached chord display and lyrics follow. Click a lyric line: the main playhead moves.
4. Takes: select, rename (✎ or double-click), delete and ↓ download from the detached window.
5. Move and resize a detached window, close it, pop it out again: same place and size.
6. Untick a detached panel in the Panels menu: its window closes.
7. Carry the grip of a detached window over the main window and release: it docks.

## Not done

- Mixed-DPI multi-monitor placement and macOS are untested.
- Several windows of one panel (one window per panel id).
- The component and gesture wiring (pointer capture, window creation) has no automated test: there is no DOM environment. The decisions behind them are tested (`decideDrop`, `createDockGesture`, the bridges, the Rust planner and hit-test).
- The stems and the mixer cannot be detached; that would need the audio engine to move.
- The Takes list in a detached window shows what is heard (▶ playing, ▷ silent, ○ hidden) from the mirrored `shownTakeIds`, `takePlayback`, `mutedTakeIds`, `muteTakesWhileRecording` and recording state; the lane mutes and the two toggles live in the main window's take bar.
