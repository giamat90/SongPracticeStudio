# Changelog

All notable changes to SPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.0.40 are not itemised; see `git log` and the tags.

## [Unreleased]

### Added
- Several recorded takes can be shown at the same time, each on its own lane. Click a take in the Takes list to show it, click it again to hide it (a lane also has its own ×). By default every shown take is heard together; **M** on a lane silences just that take.
- A bar above the take lanes with two tick boxes, each with one fixed label: **Selected take only** (only the selected take plays, and clicking another take switches to it; off, every shown take plays together) and **Mute takes while recording** (on by default; untick it to keep hearing the shown takes while you record another one). Both choices are remembered.
- Each take lane has its own **mute, solo and volume** at the far right, next to the offset controls it already had; the shared take volume, mute and solo stay in the bar above the lanes and come first: the main mute silences every take whatever the lanes say, and a lane's solo only picks one take among the takes (it never touches the other tracks). The main buttons' tooltips say so.
- The selected take's lane header is tinted with an accent edge, heard or not, so in selected-only mode a muted selected take is still told apart from the others.
- The recorded takes (their bar and lanes) form a section of their own, set apart by a divider, which scrolls by itself (up to 45% of the window height) so the vocal and instrumental waveforms stay in view however many takes are shown.
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
