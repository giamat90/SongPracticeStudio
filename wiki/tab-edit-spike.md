# Tab editing: feasibility spike (2026-10-24)

**Status:** step 1 of the scope ladder (move a note to another string at the same pitch) is **built** on `feat/tab-edit`; see [Tab sync](tab-sync.md#editing-the-tab-strings). The "popover with the other strings" under *Design* below was replaced after a first try by Guitar Pro's interaction (pick a note, Alt+Up / Alt+Down). The rest of this page is the spike as it was written before building.

**Question:** can the user change the tab they imported, for example move a note to another string, and keep it? **Answer: yes, and the risky parts are measured, not guessed.** A first version (move a note to another string at the same pitch, change a fret, persist it) is a small feature, about 3 to 5 days with tests and docs. Nothing was built in the app; the numbers below come from throwaway Node scripts against alphaTab 1.8.4 and the 26 real `.gp` files in `MPS/GP-and-MIDI-files`.

## Why it is cheap here

Tab sync already parses the stored file into an alphaTab `Score` and draws it (`TabScoreView`, `tabScore.ts`). alphaTab's model is mutable and ships a writer:

| Need | Already in alphaTab 1.8.4 |
|---|---|
| Change a note | `note.string` (1 = lowest string) and `note.fret` are plain fields; `realValue` is computed (capo + tuning + fret), so pitch follows |
| Pick a note | `api.noteMouseDown` event gives the `Note`; `boundsLookup.findNoteAtPos(x, y)` and `findBeat(beat)` give where to put a popover |
| Redraw | `api.renderTracks([...])` (what the track menu already calls) |
| Save | `new at.exporter.Gp7Exporter().export(score)` returns the bytes of a `.gp` file |

## What was measured

1. **Edit, export, reload** (`moved first movable note to another string, same pitch`): 6 of 6 tabs came back with the note on the new string/fret, every stringed note's pitch unchanged, same track count and bar count. About 0.3 to 0.8 s each including parsing.
2. **Does an unedited export play the same music?** The alignment input is built from alphaTab's generated MIDI (`buildTabScore`), so this decides whether re-aligning is ever needed. Compared note-on events, tempo events and played-bar tick ranges before and after export: **26 of 26 identical** (repeats expanded, same bar count). So a string/fret edit that keeps the pitch **cannot change the alignment**: the stored `tab_sync.json` bar times stay valid and no re-align is needed.
3. **File size:** the exported `.gp` is 2.5 to 4 times larger than the originals (for example 44 KB to 162 KB, 92 KB to 306 KB). Irrelevant on disk.

## Design (if built)

- **Where the edit lives.** Save the edited score as `tab.gp` (GP7 format) in the song directory, next to the alignment; keep the original bytes once as `tab.original.<ext>` so *Revert edits* is possible and a `.gp5` import is never lossy-converted without a way back. `tab_meta.json` keeps the user's file name. Rust gains one command, `save_song_tab(songId, bytes)`, with the same atomic write and validation as `tab.rs::import` (non-empty; extension forced to `gp`; old `tab.<ext>` removed). The IPC step is the documented one in `CLAUDE.md` (doc comment, `generate_handler!`, `npm run gen:ipc`, `tauri.test.ts` case).
- **Frontend.** `TabScoreView` keeps the parsed `Score` in a ref and exposes `onNoteClick`. A small editor popover (not a modal) offers: the other strings where the same pitch is playable (fret 0 to 24 given the track's tuning and capo), plus fret +/-1 for a pitch change. Apply mutates the note, re-renders, and the store's `saveEdited` exports and saves, debounced. Undo is an in-memory stack of `{note, string, fret}`; the persisted file is the only durable state.
- **Pure logic** goes in a new `lib/tabEdit.ts` (candidate strings for a pitch, conflict check, apply/undo), tested in Vitest with alphaTex scores like `tabScore.test.ts`.
- **After a pitch-changing edit** the alignment is stale only in a minor way: chroma correlation changes by one note. A string move needs no change to `tab_sync.json`; for pitch changes offer *Re-align* (existing button), do not force it.
- **Reload path.** `TabPanel` re-fetches bytes on `alignedAt` change; an edit must not remount the view (it would lose scroll and the cursor), so the save should update the record's file stamp without touching `alignedAt`.

## Risks and edge cases (the real work)

- **Ties:** a tied-to note copies its fret from the origin (alphaTab `Note.finish`); moving the origin to another string must move the whole tie chain, or the destination keeps the old string. Not yet tested.
- **Same-string clash:** two notes of one beat cannot share a string; the editor must hide occupied strings.
- **Fret-dependent effects:** natural harmonics sound by fret (5, 7, 12) and not by pitch, so they should not be offered a string move; slides, hammer-ons and bends keep their data but their targets may need to move together. Disable move for notes carrying a harmonic until tested.
- **Fidelity of export beyond playback.** Check 2 compares MIDI only. GP7 export of lyrics, text marks, chord diagrams, fingerings, beam and layout hints is **not verified**; open an exported file in Guitar Pro or Songsterr-like viewers before shipping, and keep the original as the safety net.
- **Percussion and non-stringed tracks:** `note.isStringed` is false there; the editor ignores them.
- **Other import formats:** `.gp3` to `.gp5`, `.gpx` and MusicXML load fine, but saving rewrites them as `.gp`. This is a one-way conversion on first edit, hence the kept original.
- **Detached/other windows:** the Tab panel is not detachable (`ANALYZER_PANELS`), so there is no cross-window sync problem.

## Scope ladder

1. **Move to another string, same pitch** (this spike's subject): exact, no alignment effect. 3 to 5 days.
2. **Change a fret or pitch, add or delete a note:** needs duration/beat model care and offers *Re-align*. About a week more.
3. **Free editing (new beats, bars, rests, rhythms):** that is a tab editor; alphaTab has no editing UI, and this is not recommended. Users who need it can edit in Guitar Pro and *Replace tab*.

## Recommended next step

Build step 1 behind the existing Tab panel, on a branch, with: `lib/tabEdit.ts` + tests (including a tie and a clash case), the Gp7 round trip on the real-tab test (`tests/tabs/realTabs.test.ts`, which already skips when the folder is absent), the Rust command, and docs/UML in the same PR (`tab-sync.md`, `uml.md` tab-sync diagram, `components.md`). Before that, one hand check: export an edited tab and open it in Guitar Pro to confirm text, lyrics and chord diagrams survive.

## Scripts

The throwaway scripts are in the session scratchpad (`roundtrip.mjs`, `fidelity.mjs`); they import alphaTab's `dist/alphaTab.core.mjs` directly and read the maintainer-local tab folder. They are not part of the repository.
