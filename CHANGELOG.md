# Changelog

All notable changes to SPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.0.40 are not itemised; see `git log` and the tags.

## [0.0.54] - 2026-10-12

### Changed
- **Waveforms shrink to a strip, as in a DAW.** The arrow at the start of each stem's header shrinks that stem to its strip (name, M, S, volume, download): **^** shrinks it, **∨** brings the waveform back. It keeps playing, and M, S and the volume still apply. This replaces the old **×**, which hid the waveform completely; the Panels menu tick for a stem is the same setting. With every stem shrunk the ruler and the strips stay.

## [0.0.53] - 2026-10-12

### Fixed
- Showing a recorded take while the timeline was zoomed or resizing could raise a "No audio loaded" error behind the scenes and skip part of the zoom update. Zoom and scroll now leave out waveforms that have not finished decoding.

## [0.0.52] - 2026-10-12

### Added
- **Hide the waveforms.** The **Waveforms** entry at the top of the Panels menu hides the whole stem area, and each stem can be hidden on its own, from the menu or with the **×** next to its download button. Hiding only removes the picture: the stem keeps playing, and M, S and the volume still apply. A hidden stem that is muted or soloed is tagged in the menu.
- **Bass tab** has its own switch in the Panels menu.

## [0.0.51] - 2026-10-12

### Added
- **Move the panels.** Lyrics and Takes, under the tracks, can be dragged above or below each other with the ↕ grip in the panel's corner (or focus the grip, press space, move with the arrows, press space). The order is remembered, the Panels menu lists panels in that order, and **Reset** puts visibility and order back to the defaults. The chord display stays in the top bar.

## [0.0.50] - 2026-10-12

### Changed
- The song page now shows the tracks first, as in VPS: the stems and bass tab on top, then the lyrics, then the takes. Long lyrics scroll in their own area instead of pushing the tracks down.

## [0.0.49] - 2026-10-12

### Changed
- **New look**: SPS now has its own amber accent colour, so it is easy to tell apart from VPS when both are open.
- **New app icon**: stacked stem bars instead of the default Tauri logo.

## [0.0.48] - 2026-10-12

### Added
- Chords: seventh chords (7, maj7, m7) and slash chords (C/E, with the bass note taken from the bass stem) are now detected. Songs imported earlier keep their triads until you press **Re-detect chords** in the header; no new separation is needed.
- **Capo** selector next to the chords: the chord display, the chord row and Export Chords show the shapes to play with the capo on that fret (remembered per song, also in a detached chords window).
- The **Loops** menu lists **Sections from the chords**: the song cut where the chord progression changes, in blocks of four bars, with a letter that repeats for sections playing the same chords (and an Intro before the first chord). Click one to loop it. Chords alone cannot tell a verse from a chorus that loops the same chords.
- **Cancel** button while lyrics are syncing. Nothing is changed; the next sidecar use starts it again.
- **Search** box in the library: title, key, tempo or folder name, several words allowed.

## [0.0.47] - 2026-10-12

### Added
- A **Bass tab** under the stems for songs with a bass stem: a four-string tab that scrolls with the playhead (click to jump), and **Export MIDI** to save the bass line as a MIDI file.
- **Export Chords** saves the detected chords as a text chord sheet in the current key, with an optional **Capo** setting that writes the shapes to play.
- Songs can be renamed from the library: double-click the title or use the pencil.
- Keyboard shortcuts in the analyzer: **Space** play / pause, **Home** / **End** to the start / end, **←** / **→** back / forward 5 seconds (hold **Shift** for 1 second), **L** loop on / off, **[** and **]** set the start and end of the region at the playhead. They are ignored while you type, while recording and during the count-in.
- A **Loops** menu next to the loop button. Save the current region under a name (it is kept with the song), click a saved loop to loop it, rename or delete it. The same menu lists the song cut into groups of 2, 4, 8 or 16 bars from the metronome downbeat, one click each.

### Fixed
- After a key transpose the chord display and the key in the header still showed the original key. They now follow the transpose, also in a detached window.

## [0.0.46] - 2026-10-12

### Added
- A **×** button on the Takes bar deletes every recorded take at once, after an inline confirmation. If one take cannot be deleted, the takes that could not be are kept.

### Fixed
- The app now waits up to 90 s (was 30 s) for the audio engine to start, so the first import or lyrics sync after a cold start no longer fails on a slow disk.

## [0.0.45] - 2026-10-11

### Fixed
- macOS builds were missing from the previous release: the macOS build now takes ffmpeg and ffprobe from GitHub-hosted static builds instead of a site that rate-limited the download. No other change from the previous version.

## [0.0.44] - 2026-10-11

### Added
- Several recorded takes can be shown at the same time, each on its own lane. Click a take in the Takes list to show it, click it again to hide it (a lane also has its own ×). By default every shown take is heard together; **M** on a lane silences just that take.
- A bar above the take lanes with two tick boxes, each with one fixed label: **Selected take only** (only the selected take plays, and clicking another take switches to it; off, every shown take plays together) and **Mute takes while recording** (on by default; untick it to keep hearing the shown takes while you record another one). Both choices are remembered.
- Each take lane has its own **mute, solo and volume** at the far right, next to the offset controls it already had; the shared take volume, mute and solo stay in the bar above the lanes and come first: the main mute silences every take whatever the lanes say, and a lane's solo only picks one take among the takes (it never touches the other tracks). The main buttons' tooltips say so.
- The selected take's lane header is tinted with an accent edge, heard or not, so in selected-only mode a muted selected take is still told apart from the others.
- The recorded takes (their bar and lanes) are set apart from the vocal and instrumental tracks by a divider. It is only a graphic separation: they are the same widget and scroll with it.
- The mixdown export includes every take that is heard, at each take's own level.

### Changed
- Starting a recording no longer removes the takes from the screen. By default they are silent while you record, as before; untick **Mute takes while recording** to hear them.

## [0.0.43] - 2026-10-11

### Added
- The chord display, the lyrics panel and the takes list can be dragged out of the window into a window of their own, for a second monitor, or popped out with their button. The detached window follows playback and the selected take; clicking a lyric line seeks, and selecting, renaming, deleting or downloading a take works from it. Dock it with its button, by closing it, or by carrying its grip over the main window.
- A detached window opens where it was last (and the same size) when that is still on a connected monitor.
- The Panels menu marks panels that are in their own window, and hiding one closes its window.

## [0.0.42] - 2026-10-10

### Added
- A "Panels" menu in the analyzer header: show or hide the chord display, the lyrics panel and the takes list (Show all / Hide all / Reset). Your choice is remembered; everything is shown by default.

## [0.0.41] - 2026-10-10

### Changed
- Shared code (metronome, recorder, timeline zoom/pan, auto-update, lyrics engine, yt-dlp version check) now comes from the shared `mps-core` package, which both apps use. No change in behaviour is intended.

## [0.0.40] - 2026-10-10

### Added
- Lyrics panel with karaoke view and click-to-seek: CTC forced alignment of lyrics to the vocals stem.
- Automated test suites (vitest, cargo, pytest) run in CI on every push and pull request.

### Fixed
- The time readout and lyrics now follow a waveform click while playback is paused.
- The practice room no longer shows a spurious "No audio loaded" label when a song load was superseded by a newer one.
