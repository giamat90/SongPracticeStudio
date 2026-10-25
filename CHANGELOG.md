# Changelog

All notable changes to SPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.0.40 are not itemised; see `git log` and the tags.

## [0.0.78] - 2026-10-25

### Added
- **The tab follows the song's transpose.** When you transpose the song, the Tab panel redraws the notes for the new key: the same string with the fret moved, else the nearest string that fits. A note no string can play (below the lowest open string, or a harmonic) stays as written and is drawn red. This is display only; your saved tab is never changed by it. You can still edit the tab while the song is transposed, and your string choices are remembered for each transposition.
- **Tuning.** When a transposition leaves notes below the lowest string, the panel suggests tunings that play more of them (lowest string down, or all strings down), best first. The new **Tuning...** button opens an editor with presets and a step up / down for every string, with the note names. With the song transposed it sets the tuning for that transposition; with the song at 0 it changes the tab itself, either re-fretting the notes to keep their pitch or keeping the frets so the pitch moves. It can be undone.
- **Transpose... for the tab itself.** Like Guitar Pro and TuxGuitar, the **Transpose...** button rewrites the stored tab by some semitones: all tracks or one, keep notes on their strings or not, and a tuning choice, with a live preview of how many notes fit. One undo step; **Revert to imported** goes back to your original file.

### Changed
- The Edit, Transpose... and Tuning... buttons (and the tuning presets) now show when they are on.

## [0.0.77] - 2026-10-24

### Added
- **Edit the tab you imported.** The Tab panel has an **Edit** button. With it on, click a note, then **Shift+Up / Shift+Down** moves it to the string above or below, keeping the same pitch (the fret changes to match). **Left / Right** put the playhead on the previous or next note, **Alt+Left / Alt+Right** on the previous or next bar, and **Ctrl+Z** undoes the last change (**Ctrl+Y** redoes). Ties, hammer-ons and slides move together with the note; harmonics and strings already in use stay put. The edited tab is saved with the song as a Guitar Pro file, your original is kept, and **Revert to imported** brings it back. The bar lines stay where they were, because no note changes pitch.

### Changed
- **The tab's playhead line sits on the notes.** It used to be spread evenly across each bar, so at the start of a bar it stood on the bar line, left of the first note, and drifted off the notes elsewhere. It now follows the notes' own positions, the first note of a bar included.

### Known
- Saving an edited tab can change the sound preset of an instrument in the file (for example a distortion guitar comes back clean). Notes and timing are identical, and SPS does not play the tab's sound.

## [0.0.76] - 2026-10-24

### Removed
- **The bass tab is gone.** The imported Guitar Pro tab (Tab panel) shows a real tab, so the guessed bass line is no longer made on import, there is no Bass tab panel or Panels-menu entry, and the bass tab MIDI export is removed. Chord sheets and everything else are unchanged; old `bass_tab.json` files in your library are simply ignored.

## [0.0.75] - 2026-10-24

### Added
- **The top bar is made of cards you can move.** Transport, Loop, Tempo, Input and output, Transpose and capo, and Chords are separate cards in one list that wraps with the window. Drag a card by its ⋮⋮ grip anywhere in the bar (or focus the grip and use the arrow keys); double-click a grip to put the cards back in the usual order. This is separate from moving the panels below.
- **A Cards menu next to Panels** hides and restores the cards. The chord carousel is only a card now and is no longer listed under Panels.
- **The Chord roll and Meter names fold the panel**, like Lyrics and Takes.

### Changed
- **Monitor moved from the Chord roll to the input strip**, between Input and Output. Its level meter shows only while it is on, and the card shrinks and grows with it.

## [0.0.74] - 2026-10-24

### Changed
- **Record moved into the transport bar**, right after Play (skip, Stop, Play, Record, skip). It is always red, not the amber of the rest of the app, so it is not mistaken for Play.
- **The top bar reads like VPS's**: tempo, then Input and Output, then Transpose.
- **Transpose is one row** like Speed and the devices, instead of a label stacked over its buttons.
- A long error message in the bar is cut with an ellipsis; hover it to read the whole text.

## [0.0.73] - 2026-10-24

### Added
- **The count-in also counts in Play.** With the clock button set to 1 or 2 bars, Play clicks the bars in first and then starts the song (from the punch-in point if there is one); a song with bars is counted in the way its bars are counted. Resuming from a pause counts in again. The Play button shows the beats left; click Play, press Space or click Stop to cancel the count. Record counts in as before, and a recording started during the count takes over.

### Changed
- The clock button moved from beside the Record button to the transport bar, since it now counts in Play as well.
- The count-in of a song with bars now counts down 4, 3, 2, 1 like the steady one (it dropped a number as the first pulse started).
- Uses mps-core v0.17.0, which holds the count-in for both apps.

## [0.0.72] - 2026-10-24

### Added
- **Every panel's name is a button that folds it**, like the Lyrics button always did. Click the name to fold the panel down to just that button, click it again to open it. It works on the Chords display in the top bar (folded, the bar gets shorter), Takes, the Bass tab and the Tab panel. The Bass tab and the Tab panel keep their buttons above their card, the way the Lyrics button sits above its card. A folded panel is only its button. Your choice is remembered, and a panel in a window of its own follows it.

### Changed
- Uses mps-core v0.16.0.

## [0.0.71] - 2026-10-24

### Changed
- **The analyzer page scrolls as one page.** The stems or waveforms, lyrics and takes no longer have scroll boxes of their own: the whole page scrolls, so every panel is reachable with the wheel. The title, Panels menu and export buttons stay pinned with the transport bar, which is now more compact (speed, input and output sit in rows). Ctrl+wheel still zooms the timeline and Shift+wheel still pans it.

## [0.0.70] - 2026-10-22

### Fixed
- **A long list of release notes no longer pushes the update buttons off screen.** The "Update available" window is now at most as tall as the window allows and the notes scroll inside it, so Install & Restart and Later stay visible.

## [0.0.69] - 2026-10-21

### Added
- **Meter: count a song's bars, whatever its time signature.** SPS used to treat every bar as four beats. A new **Meter** panel (Panels menu, under the chord roll) gives each song a map of its bars: where each starts, how many pulses it has, and which note is one pulse, so 5/4, 7/8, 6/8, or a song that changes meter from bar to bar, can be seen, corrected and clicked along to. Like the chords, the app's guess is a starting point and your corrections are kept apart and win.
  - **Find bars** listens to the song's beat and proposes the bars; new imports do it automatically. **Treat it as a first guess:** on the author's own test songs it found the right bar length about two times in three on steady songs and rarely on songs that change meter, and it often puts the first beat of the bar one beat off. The panel says where the bars came from and how sure it was, asks before replacing bars you edited, and has Undo.
  - **Correct them with tools:** the song as coloured stretches by time signature; a lane of the bars around the playhead with the drums drawn under them, where you drag a bar line; pulses and note unit; accent groups (3+2+2, or your own); split, join, remove; count finer or coarser (4/4 as 8/8); **repeat a pattern** such as 5+7 at a chosen pulse rate over the rest of the song; move the first beat of every bar a pulse earlier or later; shift every bar by 10 or 50 ms.
  - **Tap along:** press T on the first beat of each bar (and once more where the last bar ends), or on every beat, and the bars are built from your taps. Seven pulses between taps comes out as seven.
  - **Start from the tempo** gives four beats to a bar at the detected tempo to correct from.
  - **Everything follows the bars:** the metronome clicks the bars' own pulses with the first of each group louder and starts again when you seek or the loop wraps (choose to click every pulse, only the groups, or only the bars); the recording count-in counts the bar you start in; the time ruler draws bar lines with numbers and the signature where it changes; the Loops menu's bar sections are cut from the bars. A song with no bars works as before.
  - Uses mps-core 0.15.0.

### Fixed
- The local-only test that reads a folder of real Guitar Pro files no longer times out on a busy machine.

## [0.0.68] - 2026-10-21

### Added
- **Monitor: see what you play against the song.** A new **Monitor** switch in the chord roll's header listens to the input chosen in the mic menu (a guitar or keyboard through your interface, or a voice) and draws it in pink next to the song. Nothing is recorded.
  - On the notes, thin pink bars show the notes you play over the song's own, so you can see at a glance whether you are on the same ones.
  - On the spectrum, a pink curve for your input sits beside the song's curve and the chord you are trying.
  - A **You play C** line above the spectrum says which notes of that chord it hears and which are missing, and names the strongest note you play that the chord does not have (play C minor against C major and it reports the E missing and the D sharp).
  - A level meter and a short message tell you when there is no sound, when the input is clipping, or when the input is unplugged or could not be opened.
  - While the song plays, the pink notes are placed using the latency calibrated for your input (the same one recording uses), so calibrate it for the best match. Use headphones: a song coming out of speakers is picked up too.
  - The monitor stops by itself when you leave the song, hide the chord roll, or start a recording, and it follows you if you choose another input.

### Fixed
- The chord spectrum could stay empty (no orange curve for the song) when the page had just opened, until you moved the playhead. It now measures again as soon as the audio is ready.

## [0.0.67] - 2026-10-20

### Added
- **Chord roll: the place to study and correct a song's harmony.** A new panel under the stems (Panels menu, *Chord roll*, on by default). It shows the notes each stem plays over ten seconds around the playhead, in the stem's colour, with the chords on a strip above them. The chord that is playing is lit, notes the chord does not have can be faded, and a piano on the left lights the notes sounding now. Choose which stems to show and the range of notes (default E1 to C5). The first time you open a song the notes are analysed (about 12 seconds for a four-minute song) and saved with it, so the next visit opens ready.
- **Correct chords on the roll.** Click a chord's button to pick it; drag its amber handle to move where it starts; press the dashed **+** at the playhead to add a chord where there is none; click anywhere else to go there, drag to scrub.
- **One spectrum, with the editing in it.** The short-term spectrum of the picked chord (or of the playhead) sits in the same panel, with a synthetic chord drawn over it to compare. Choose a root and a quality from two drop-downs, add a slash bass, press *Use* to make it the chord, or try a chord from the **In this key** and **Also heard** drop-downs. Hear, With song, Go to, Start here, End here, Split here, Join next, Delete and Done sit beside the stems.
- **More chord kinds.** The quality menu now offers 22 kinds: the power chord (5), add9, minor 6, 9, minor 7♭5, diminished 7, 7sus4, minor/major 7, major 9, minor 9, 11 and 13 join the ones that were there. The detector still finds only major, minor, sevenths and sus; the others are for chords you set yourself.

### Changed
- **The chord row above the time ruler is gone.** Every chord is now shown and edited on the chord roll; the chord display in the top bar stays. If you hide the chord roll in the Panels menu you cannot correct chords until you show it again.
- The chord editor no longer has its own *Spectrum* button; the roll's spectrum replaces it.

## [0.0.66] - 2026-10-18

### Added
- **Chord spectrum: look at a chord before you decide.** In the chord editor, the new *Spectrum* button shows the spectrum of the song over the selected chord (the stems you tick; drums and vocals start off, like the detector reads) with the spectrum of a synthetic candidate chord drawn over it. Pick a root and a quality (Cm, Cm7, Csus2 ...) with one click and see whether the song's peaks line up; the chord now there is drawn dashed for comparison, and *Use* makes the candidate the chord. Under the plot, each note of the candidate shows how strong it is in the song (or that it is probably only an overtone of another note) and the strongest note the candidate does not have. Tick the vocals to see what the sung note adds. It is a tool for judging a chord, not a second detector.

## [0.0.65] - 2026-10-18

### Fixed
- **Finding lyrics online now searches by artist as well as title.** Imports used to leave the artist empty, so the search ran on the title alone and a common title could find another band's song. The artist is now read from the file's tags or from the YouTube video, shown in the lyrics panel next to the title, and can be corrected there. If nothing is found with the artist, the search tries the title alone, and versions by the right artist are listed first. Songs imported earlier keep an empty artist until you set one.

## [0.0.64] - 2026-10-18

### Fixed
- **Latency calibration reads the click and the clap more accurately.** The calibration wizard measured the delay between a click and the sound the microphone picked up with a timing error in its frame counting; it now uses the corrected measurement that Vocal Practice Studio already had, so the offset it suggests is closer to the real one. Run **Calibrate** again if recordings sit slightly off.

### Changed
- **Internal restructuring, nothing else to relearn.** The player, the library, the panels and the controls now share their logic with Vocal Practice Studio through one common package (mps-core 0.13.0) instead of keeping two copies. The screens, the buttons and the files on disk are unchanged.
- **Fewer security advisories in the build tools.** The development toolchain was updated; the installed app is not affected.

## [0.0.63] - 2026-10-15

### Changed
- **Fewer plain chords shown as seventh chords.** The detector used to name a seventh (Cmaj7, G7, Am7) whenever the extra note was only faintly there, which was the most common mistake against reference charts: a plain C or G read as Cmaj7 or G7. A seventh now needs clearly more evidence before it is named. On a test of eleven tabs the detector did not see during tuning, sevenths came out right about 57% of the time instead of 47%, and major and minor chords went from 63% to 65%. Songs imported earlier keep their chords until you press **Re-detect chords**.

### Notes
- Both test sets are mostly rock and pop. A song with a lot of real sevenths (jazz, soul) may now read some of them as plain chords; **Easy / Medium / Advanced** and the chord editor are still there to correct it, and **Hear** helps to decide.

## [0.0.62] - 2026-10-15

### Added
- **Lyrics search keeps the song's real name.** Renaming a song (for example to "Hallelujah (live)") no longer changes what **Find online** looks for. The lyrics panel shows **Searches as: Artist – Title** with a **Change** link to correct it.
- **Choose among the results.** When more than one lyrics result is found, they are listed under the text box with their length and whether they are timed; click one to use it. A result of a different length than your song is marked, so a live or acoustic version can still be picked.

### Changed
- The shared package moved to mps-core 0.11.0 (it was 0.7.0).

## [0.0.61] - 2026-10-15

### Added
- **Hear a chord before you accept it.** In the chord editor (click a chord on the timeline), **Hear** plays the chord on a synthesiser, and changing the root, quality or bass plays the new chord straight away, so you can listen to a correction instead of guessing. The chord is tuned to the recording, so a song that sits a little sharp or flat does not make a correct chord sound wrong, and it follows the song's transpose.
- **With song** loops that chord's part of the song and holds the synthesised chord under it, so you can compare the two on the same notes. Closing the editor stops it.
- **Choose from a list.** Under the editor, **Also heard** lists the other chords the detector considered for that stretch with how well each fit, and **In this key** lists the chords of the song's key. Click one to hear it; double-click it (or press **Use**) to apply it. On a test set of twelve songs the right chord was among the detector's first three guesses about nine times in ten (major and minor chords).

### Notes
- Songs imported earlier have no "Also heard" list and are tuned to concert pitch until you press **Re-detect chords**. Re-detecting replaces your hand corrections, and asks first.

## [0.0.60] - 2026-10-15

### Added
- **Easy / Medium / Advanced chords.** A new menu next to the capo chooses how much of each chord is shown: *Easy* reduces sevenths and sixths to the plain major or minor chord and drops slash bass notes, *Medium* keeps the sevenths, *Advanced* shows everything that was detected. The choice applies to the chord display, the chord row, the detached chord window and the exported chord sheet, and is remembered for every song.
- **Unsure chords are dimmed.** After **Re-detect chords**, a chord the detector was not confident about is shown faded and in italics in the chord row, with "not sure about this one" in its tooltip: those are the ones worth a second listen. A chord you set by hand is never dimmed.

### Changed
- **Recordings that are not at concert pitch are read more accurately.** The detector now measures how far a recording sits from A440 before it listens for chords, which matters for older recordings and remasters a few tens of cents sharp or flat. On a test set of twelve songs the share of correct chords went up by about two to three points overall, and by far more on a recording a quarter-tone off pitch. Songs imported earlier keep their chords until you press **Re-detect chords**.

### Notes
- Checked against published reference charts on twelve songs, not by ear on a large library: major and minor chords are right about 64% of the time and sevenths about 38%. A plain chord shown as a major seventh is the most common mistake; *Easy* hides it, it is not fixed yet.

## [0.0.59] - 2026-10-14

### Added
- **Tab sync.** Import a Guitar Pro tab of the song (`.gp`, `.gp3`-`.gp5`, `.gpx`, MusicXML) in the new **Tab** panel under the stems. SPS places the tab's bars on the recording using the separated stems, then the tab follows the music: a cursor moves through the notation with the playhead, and clicking a bar seeks there. A tab written a semitone off the recording is retuned automatically.
- A chip shows how far the alignment can be trusted (Aligned / Check the bar lines / Poor match). A bar that is wrong can be selected and set to the playhead, optionally moving the following bars too. *Re-align* runs it again, *Remove* deletes the tab. A tab that is a different arrangement or a shortened video will come out as a poor match.
- Everything stays on your machine: the tab is copied next to the song and nothing is uploaded.

### Notes
- Checked by ear on three songs; the rest were checked with measurements only. Expect to correct a bar here and there.

## [0.0.58] - 2026-10-14

### Changed
- **Chords follow the beat.** Detection used to cut the song into fixed one-second windows, so a change that fell between two seconds landed up to a second early or late. It now reads one window per beat and decides the whole progression at once, so a single noisy window no longer flips a chord. A song with no steady pulse is still read on the one-second grid. Songs imported earlier keep their chords until you press **Re-detect chords** in the header; no new separation is needed.

### Added
- **Correct a chord by hand.** Click a chord on the timeline to change its root, quality (now including sus2, sus4, dim, aug and 6) or slash bass, move its start or end to the playhead, split it, join it with the next one or delete it. With the playhead paused in a gap a **+** adds a chord there. Your corrections are kept apart from the detection, show in the chord sheet and sections, and **Reset edits** in the header brings the detected chords back. **Re-detect chords** replaces them and asks first.

## [0.0.57] - 2026-10-14

### Added
- **Sign in again with one click when your YouTube sign-in has expired.** If a YouTube import is turned down in a way a fresh sign-in can fix, the error now has a **Sign in again and retry** button: it opens the sign-in window, saves the new session and repeats the same import. If YouTube refuses even a fresh sign-in, the message says the network or VPN is probably the cause.

### Changed
- The in-app YouTube sign-in is now shared code with the sibling app; behaviour is unchanged.

## [0.0.56] - 2026-10-14

### Added
- **Sign in to YouTube inside the app.** Settings → YouTube account → **Sign in to YouTube** opens Google's sign-in in a private window; once you are signed in the app keeps only the YouTube/Google session cookies it needs and uses them for imports, so you no longer have to export a `cookies.txt` by hand. Choosing a cookies file is still available, and **Sign out** forgets the session.

### Fixed
- **YouTube imports with a signed-in session no longer fail with "The page needs to be reloaded".** The app now bundles the JavaScript runtime (Deno) that YouTube's challenges need, which makes the installer larger.
- YouTube import error messages point at Settings → YouTube.

## [0.0.55] - 2026-10-14

### Changed
- **Chords are read without the drums and vocals.** Detection used to listen to the whole mix, so drum hits and the sung melody leaked into the chords. It now listens to the bass, guitar, piano and other stems only. A song with none of guitar, piano or other extracted is still read from the original file. Songs imported earlier keep their chords until you press **Re-detect chords** in the header; no new separation is needed.

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
