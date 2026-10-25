# Tab sync

Import a Guitar Pro tab of the song and SPS places its bar lines on the recording, so the tab follows the music: a cursor moves through the notation with the playhead, clicking a bar seeks there, and a bar that is wrong can be set to the playhead by hand.

**Files:** `sidecar/tab_sync.py` · `src-tauri/src/tab.rs` · `src/lib/tabScore.ts` · `src/lib/tabSync.ts` · `src/stores/tab.ts` · `src/components/tab/TabPanel.tsx` · `src/components/tab/TabScoreView.tsx` · `src/components/tab/TabNoteEditor.tsx` · `src/lib/tabEdit.ts` · `src/lib/tabTranspose.ts` · `src/components/tab/TabTransposeDialog.tsx`

## What the user sees

The **Tab** panel sits under the stems (Panels menu, "Tab"). *Import tab...* takes `.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`, `.musicxml` or `.xml`. The file is copied next to the song, aligned (a few seconds to about twenty, see Measured), and shown. A chip says how far the result can be trusted (Aligned / Check the bar lines / Poor match); a recording that sounds a semitone above the tab (a tab in Eb against an E recording) is retuned automatically and says so. A track menu picks which part is drawn; the default is the guitar with the most notes. *Re-align* runs the alignment again and drops hand corrections; *Remove* deletes the tab.

## Data flow

```
.gp file ──► alphaTab (webview) ──► TabScore JSON ──► Rust align_song_tab ──► sidecar align_tab
                                                                                   │
tab.gp + tab_sync.json  ◄── Rust stores the result  ◄──────────── bars[] with times┘
```

1. **The webview reads the tab.** alphaTab parses the file; `buildTabScore` (`tabScore.ts`) generates alphaTab's own MIDI, so the **played** bars (repeats expanded) and their tempo map come from the same source the notation uses and bar indices always match what is drawn. Only guitar, bass, keyboard and drum notes are kept (vocals and strings are left out); each note is `[tick, duration, pitch, role]`.
2. **Rust hands it to the sidecar.** `tab::align_impl` writes `tab_score.json` (a hand-over file, deleted afterwards) and sends `align_tab` with the song's stems that exist on disk. It refuses before spawning the sidecar when there is no tab, no usable score, or no guitar/bass/piano/other stem.
3. **The sidecar aligns** (`tab_sync.align_tab_to_stems`) and writes `tab_sync.json`; Rust validates the bar count, stamps `alignedAt` and stores it atomically.
4. **The view draws it.** `TabScoreView` renders with alphaTab (player off) and draws its own cursor from the stored bar times and the app's playback clock, placed between the notes' own x positions (`cursorX`, from alphaTab's beat bounds) so the line sits on a note at that note's time, the first note of a bar included, rather than spread evenly across the bar; alphaTab's `boundsLookup` gives each bar's rectangle. Clicking a beat maps back to a time and calls the player's `seek`.

## The algorithm (`chroma-dtw-v1`)

One function, `align_tab_to_stems(score, stem_paths, on_progress) -> dict`; replacing the algorithm touches nothing else (the result carries `algorithm` and `version`).

1. **Features** at 21.5 frames/s: pitch-class energy of the tab's pitched notes against the chroma of the sum of the guitar, bass, piano and other stems, stacked with a **kick** and a **snare** onset channel (the tab's drum track against low and mid-band onsets of the drums stem, weight `DRUM_WEIGHT` 4). The drum channels are what fixes a beat-level phase error, which chroma alone cannot see in riff-based music.
2. **Offset:** cross-correlation of the two feature streams at the tab's nominal tempo (FFT, one pass per feature row), lags from -5 s to +45 s. Repeated for every semitone shift from -2 to +2, with a small penalty per semitone.
3. **Banded DTW** around that line (+-8 s), steps (1,1), (1,2), (2,1) so slopes stay between 0.5 and 2 and a row depends only on the two before it: memory is `n x band`, not `n x m` (the librosa call the spike used allocated the full matrix, about 865 MB for an 8-minute song). The start is anchored within 0.3 s of the offset and off-diagonal steps cost `OFF_DIAGONAL_PENALTY` 0.6; with a weak penalty the path wandered or stretched a sparse intro by 40 %.
4. **Bar times** are interpolated from the path, made non-decreasing, and returned per played bar with its master-bar index and repeat occurrence.

### Quality

`quality` is `good` when the mean frame distance along the warped path is at most 0.36, `check` up to 0.45, `poor` above; below an offset peak of 0.45 it is `poor` regardless, and a path whose bar lengths are not steady (less than 70 % within 20 % of the median) drops one level. The cost is measured after warping, so a drifting performance is not penalised, which the offset peak alone did.

## Measured

On 12 real full-band GP8 tabs and the stems SPS had made for them (alignment itself 1-17 s per 4-8 minute song, one CPU):

- Mercy and Beat It were **checked by ear** (the tab's guitar, bass, kick and snare mixed over the recording): tight. Beat It was off by one beat at bar 33 with chroma alone, and the drum channels fixed it. Chop Suey was tight in the section listened to; the bar-1 labelling question ("beep on beat 2") was never resolved and is most likely the tab's pickup bar.
- The other songs have only proxies (drum-onset correlation, guitar vs. bass agreement, tempo steadiness); do not read more into them. Smooth Criminal (the library copy is a shortened video) correctly comes out `poor`; Immigrant Song (tab in Eb, recording in E) is only found with the semitone search.
- Thresholds were chosen from these 12; they are constants at the top of `tab_sync.py`.
- Through the app path (alphaTab-generated score into the sidecar), Mercy's bar 33/65/97 land within 4 ms of the ear-checked spike and Beat It's within 4/4/96 ms.
- The cursor, scrolling, bar numbers and click-to-seek were verified in headless Chrome with a throwaway page against two real tabs; there is no automated browser test.

## Limits

- **A tab that differs from the recording** (a different arrangement, a shortened video, missing or extra sections) is not fixed by a better algorithm; the chip says `poor` and the bar lines are for the user to correct by hand.
- **Repeats** come from the tab's repeat signs; a tab that writes a repeated section out in full is fine, and a recording that does not repeat what the tab repeats is a mismatch.
- **Free time** (a long rubato intro, a tempo the band does not hold) is outside the +-8 s band and the 0.5-2 slope.
- **Which beat the user calls "one"** is whatever the tab's bar lines say; a tab that starts on a pickup has its bar 1 line before the first note.
- Not detachable into its own window (not in `ANALYZER_PANELS`); the Tab panel is one of the show/hide entries under the stems (`waveforms.ts`, `songTab`).
- Tabs are the user's own files and never leave the machine.

## Editing the tab (strings)

The **Edit** button in the panel header turns editing on; the keys are TuxGuitar's. **Click a note** to pick it (the playhead still seeks), then **Shift+Up / Shift+Down** move it to the string above / below at the same pitch (a string that cannot play it is skipped), **Left / Right** put the playhead on the previous / next note (from the picked note, or from the note at the playhead; rests are skipped, bars are crossed, a chord keeps the string) and pick it, **Alt+Left / Alt+Right** put the playhead on the start of the previous / next bar, in play order (repeats count again), and pick that bar's first note (the one nearest to the string you were on), and **Ctrl+Z** undoes the last change (**Ctrl+Y** or **Ctrl+Shift+Z** redo). The row under the tab has a button for each of those, saying which string and fret ▲ / ▼ would give, and *Revert to imported*. Up is toward the thinnest string, the top line of the tab. The notes that only make sense on the same string move with it: the other end of a tie, a hammer-on / pull-off and a slide. Not moved: harmonics (they sound by fret, not pitch), strings another note of the beat already uses, notes on a percussion or keyboard track. Undo and redo are in memory (reset when the panel folds, the song changes or the tab is read again). The keys are listened for in the capture phase and stopped, so the app's own shortcuts and the meter's undo never see them; they only act while Edit is on.

One difference from TuxGuitar: its Shift+Up / Shift+Down keep the fret number (so the note changes pitch); here the pitch is kept and the fret changes, which is the point of moving a note between strings. The first versions here had a list of every playable string, then no Edit button at all (Guitar Pro's Alt+Up / Alt+Down); both were replaced by this.

Because the pitch never changes, the alignment is untouched: the stored bar lines stay valid and nothing is re-aligned (measured: the MIDI alphaTab generates from an exported tab is identical to the original's on all 26 local tabs). Changing a fret or pitch is deliberately not offered; see [Tab editing spike](tab-edit-spike.md) for the reasoning and the scope ladder.

- **Pure logic:** `lib/tabEdit.ts` (`movability`, `stepString`, `neighbourNote`, `firstNoteOfBar`, `moveToString`, `restore`, `linkedNotes`, `exportTab`), tested on alphaTex scores. String numbers in the UI are the player's (1 is the thinnest string); alphaTab's `Note.string` counts from the lowest, `playerString` converts.
- **Saving:** 600 ms after the last edit (exporting a long tab takes a moment) the panel exports the live score with alphaTab's `Gp7Exporter` and calls `save_edited_tab`; pending edits are flushed on fold, song change and before *Re-align*, and dropped by *Replace*, *Remove* and *Revert*. Saves run one after another in the store, the last one wins.
- **The view is not reloaded by its own edits:** `TabScoreView` reads its bytes again only when `source` changes (a new alignment or a revert), and keeps its scroll position across a redraw. The panel keeps `bytes` current after each save so folding and unfolding shows the edited tab.
- **Limit:** the exporter changes the General MIDI preset of about 1 track in 70 (4 of 272 on the local tabs: a distortion guitar comes back clean, one effects bass comes back with a guitar program). Notes, timing and tempo are identical, and the alignment treats guitar, bass and keys alike, so nothing observable changes; SPS does not play the tab's sound. Beyond that only playback was verified after export; Guitar Pro features alphaTab's exporter may not carry (text, lyrics, chord diagrams, fingerings) are not checked, which is why the imported file is kept.

## Transposed songs

When the song is transposed (`transpose` in the player store, the +/- control), the tab is drawn for the new key: `TabScoreView` runs `applyTranspose` (`lib/tabTranspose.ts`) on the live alphaTab score each time the track, the score or the transpose changes, then draws it again. The panel says what happened ("N notes on new frets, N on another string, N that this tuning cannot play").

- **Same string first.** Each fretted note keeps its string and its fret moves by the interval (down a whole step: 5 becomes 3). Notes of a tie, hammer-on / pull-off or slide are one group and move together, so a link never spans two strings.
- **Out of range.** When a fret would pass the nut or the 24th (`MAX_FRET`), the group goes to the nearest string where every fret fits and no other note of the beat sits (a D-string fret 3 lowered by 4 becomes the A string fret 4).
- **Unplayable.** Below the lowest open string, or a harmonic (it sounds by fret), the note stays where it was written and is drawn red (fret number and notehead). It is deliberately not octave-shifted: that would play a note different from the transposed audio. Dead notes, percussion and non-fretted tracks are left alone.
- **Display only.** The stored file and the alignment are untouched (timing does not change). The transposition lives in the live model; `exportUntransposed` takes it out for the save and puts it back, and the view takes it out when it unmounts, so no transposed tab is ever written. Edits made while transposed are kept apart (next bullet).
- **Editing while transposed.** Edit works on the transposed view: the same keys move a note to another string at the same pitch. That choice belongs to the transposition it was made in, not to the stored tab: `transposeEdits` compares each moved note with where the automatic pass put it (`Applied.auto`) and returns `TransposeEdit`s (track, staff, bar, voice, beat, the pitch in the stored tab, the chosen string), saved per amount of semitones in `tab_transposed.json` (`read_tab_transposed` / `save_tab_transposed`, a JSON object `{"-2": {"edits": [...], "retune": {"0": 2}}}` (the first version stored just the array; it is still read), 1 MB at most, `{}` removes the file; removed with the tab). `applyTranspose(..., edits)` puts them back after the automatic pass, so they return whenever that amount is chosen again and never touch another amount or `tab.gp`. A note is found by place and stored pitch, so a later string edit in the stored tab does not lose it; a choice whose note or string is gone is skipped and counted ("N saved choices that no longer fit the tab"). Notes drawn red (and dead notes) cannot be moved while transposed. The edits are snapshotted when scheduled, so changing the amount before the 600 ms save fires cannot write them under the wrong amount; undo and redo are cleared when the amount changes.
- **Tuning (retune).** A track's tuning is an `Offsets` list: semitones each string is tuned down from the tab's own tuning, lowest string first (`allStrings(n)`, `lowestString(n)`, `describeOffsets` names it: Same tuning / All strings down N / Lowest string down N / Custom). When a transposition leaves notes no string can play, `applyTranspose` tries lowest-string-down 1..`MAX_RETUNE` (5) and all-strings-down 1..`MAX_ALL_DOWN` (4) (trial runs on the live model, taken back each time) and returns for each track a ranked list in `TransposeResult.suggestions` (`{offsets, fixes, label, from, to}`, most notes played first). The panel lists them ("All strings down 2 (E A D G to D G C F) plays 14 more notes", *Use this tuning*); the choice is saved per amount (`retune` in `tab_transposed.json`, track index to offsets, e.g. `{"-2": {"edits": [...], "retune": {"0": [2,0,0,0]}}}`; the older single number and bare edit array are still read) and applied as `TransposeOptions.retune`: the staff gets a new `Tuning` object (the shared preset is replaced, never mutated) and `EditStep.tunings` / `restoreStep` (`tabEdit.ts`) put the old one back. **Tuning…** (header button, shown track) opens `TabTuningEditor`: presets, and a - / + per string with note names (`storedTuning` gives the tab's open strings). With the song transposed it sets the saved tuning for that amount; with transpose 0 it changes the tab itself through `retuneTab` (undoable, saved to `tab.gp`), either keeping the notes' pitch (re-fret) or keeping the frets (pitch moves).
- **Transpose… (rewrite the tab).** For a recording in another key than the tab, as in Guitar Pro and TuxGuitar: the **Transpose…** button (enabled when the song's own transpose is 0) opens `TabTransposeDialog` with the semitones (-12 to 12), the scope (all tracks or one), *keep notes on their strings* (off: the position with the lowest fret first) and a *Tuning* choice (keep, retune only if notes do not fit, all strings down / up N), with a live preview from `previewTransposition` (apply, count, take back). *Transpose the tab* runs `transposeTab`, the same engine as the song transposition but permanent: frets, strings and the retuned strings are rewritten in the live score, the step goes on the editor's undo stack (`EditStep`, so one Ctrl+Z restores notes and tuning), and the usual save writes `tab.gp` with the imported file kept for *Revert to imported*. A note nothing can play stays as written (its fret raised by the drop when its string was retuned, so it keeps its pitch); nothing is painted red in a rewrite. Timing and the alignment are untouched. `transposeTab` refuses while a song transposition is drawn.
- **Not done:** an octave-fold option, an instrument profile (say a 5-string bass) as another way out of range, and combining with the alignment's own `transpose` (a recording a semitone above its tab): the tab follows only the user's transpose control, relative to the tab as written.

## Storage

In the song directory: `tab.<ext>` (the original bytes), `tab_meta.json` (the file's name), `tab_sync.json`:

```json
{"version":1,"algorithm":"chroma-dtw-v1","alignedAt":"...","offset":0.42,"transpose":0,"usedDrums":true,
 "peak":0.61,"meanCost":0.35,"steadiness":0.99,"quality":"good","edited":false,
 "bars":[{"index":0,"occurrence":0,"time":0.70}, ...]}
```

After an edit the song directory also holds `tab.gp` (the edited file, always Guitar Pro 7 format) and `tab.original.<ext>` (the file as imported, kept once; `TabRecord.hasOriginal`). `save_edited_tab(songId, data)` writes both and keeps `tab_sync.json`; `revert_tab_edits` puts the imported file back under its own extension and removes the copy. Importing again or removing the tab deletes both.

`save_tab_bars` stores corrections: same bars in the same order, only times change, finite, non-negative, never running backwards; sets `edited`. Importing again replaces the file and drops the alignment.

## Tests

- `sidecar/tests/test_tab_sync.py`: validation messages, tempo maps, features, offset, banded DTW (identity, ramp, band), end-to-end on a synthetic tab and stems with +-13 % drift, a semitone-shifted recording, no drum stem, unrelated audio.
- `sidecar/tests/test_protocol.py`: `align_tab` over real stdio, error message, handled-commands lists.
- `src-tauri/src/tab.rs` unit tests (also the saved transposed choices) and one `integration_tests.rs` test through the real sidecar (it found a contract mismatch the unit tests hid: the sidecar does not send `alignedAt`).
- `src/lib/tabScore.test.ts` (alphaTex tabs with a repeat), `tabSync.test.ts`, `stores/tab.test.ts`, the IPC contract test.
- `src/lib/tabEdit.test.ts` (alphaTex: other strings at the same pitch, the string above / below, the first note of a bar, the 24-fret limit, occupied strings, ties, hammer-ons, slides, harmonics, undo and redo, a `.gp` round trip that plays the same); `tab.rs` tests for save / revert / import / delete of the kept original; store tests for the save queue and revert.
- `tests/tabs/realTabs.test.ts` reads every `.gp` in the maintainer's local `GP-and-MIDI-files` folder when it exists and skips otherwise; the files are copyrighted and never committed.
