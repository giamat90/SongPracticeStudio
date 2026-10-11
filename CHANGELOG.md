# Changelog

All notable changes to SPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.0.40 are not itemised; see `git log` and the tags.

## [Unreleased]

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
