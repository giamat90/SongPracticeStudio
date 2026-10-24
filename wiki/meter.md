# Meter: the song's bars, and the tools to correct them

SPS used to count every bar as four beats. The Meter feature ("tick-tack") gives each song a **bar map**: where every bar starts, how many pulses it has and which note is one pulse, so a song in 5/4, 7/8 or 6/8, or one that changes meter bar by bar, can be counted, studied and clicked along to. It is built like the chord analysis: the detector's guess is a starting point, the user's corrections are kept apart and win, and every tool a person needs to fix the guess is in the panel.

The measurements behind the detector and the decision about it are in [Meter detection](meter-detection.md). The pure model lives in mps-core (`@giamat90/mps-core/meter`).

## The data

```ts
interface Bar { start: number; num: number; den: number; groups?: number[] }   // start in seconds
interface BarMap { version: 1; bars: Bar[]; end: number; source: "detected" | "grid" | "tapped" | "edited"; confidence?: number }
```

- A bar lasts from its `start` to the next bar's start (the last, to `end`). Its `num` pulses are spaced **evenly** over it, so a bar's tempo is the length of the bar, not a global BPM: a song that speeds up, or changes meter, keeps correct bar lines.
- `den` is the note one pulse is (the bottom of the time signature). 7/8 is `num: 7, den: 8`.
- `groups` says how the pulses split into accented groups (3+2+2). Without it the usual split is used (`defaultGroups`: threes, then a two or two twos; 6, 9 and 12 are all threes).
- Before the first bar and after `end` there are no bars (an intro, an outro). `end` is where the last bar ends, which is the song's length unless the bars stop earlier.

Stored per song, like the chords:

| File | Written by | Meaning |
|---|---|---|
| `meter.json` | the sidecar (`meter.py`), at import and on "Find bars" | what the detector found (`source: "detected"`, `confidence`) |
| `meter_edited.json` | the app, on every correction | the user's bars; **wins** when present; deleted by "Discard my changes" and by finding the bars again |

Rust: `src-tauri/src/meter.rs` (`MeterDoc`, validation that mirrors the frontend's `validateMap`, atomic writes), five commands (`read_song_meter`, `has_meter_edits`, `save_meter_edits`, `clear_meter_edits`, `redetect_song_meter`). The type crossing IPC is core's `BarMap` (`scripts/ipc-types.json`).

## The panel

`MeterPanel.tsx` (Panels menu "Meter", between the chord roll and the lyrics; not detachable, it needs decoded audio):

- **Header:** where the bars came from ("Your bars", "Detected, 60% sure", "From the tempo, not checked", "Tapped in"), a readout of the bar under the playhead (`Bar 17 of 120 · 7/8 (3+2+2) · 215 pulses a minute`), *Find bars*, *Start from the tempo* (four beats to a bar at the detected BPM from the downbeat marker), *Undo*, *Discard my changes*.
- **Summary:** the signatures the song spends its time in (share of time) and, when bar lengths repeat, the pattern (`Repeats 5+7`). A tenth of the bars may break the pattern (a cut-short last bar).
- **Overview** (`MeterOverview.tsx`): the whole song as stretches coloured by signature; click to go there.
- **Lane** (`MeterLane.tsx`): the bars around the playhead (6, 12 or 24 s). A button per bar at the top, a line at every pulse (group starts brighter), the drums' hit strength under them (`useHitEnvelope`, `lib/meterView.ts#hitEnvelope`) so a bar line can be judged against the hits it should land on. Click a bar to pick it, drag the amber handle at its left edge to move where it starts (the bar's pulses re-space live), click or drag elsewhere to seek or scrub.
- **Editor** (`MeterEditor.tsx`), for the picked bar: pulses and unit; accent presets and a typed split (`3+2+2`); who a change reaches (this bar, until the signature changes, to the end); *Go to*, *Loop bar*, *Start here* (the bar starts at the playhead), *Split here*, *Join next*, *Remove*, *Count finer / coarser* (4/4 becomes 8/8 with the bar lines kept); *Repeat from here* (a pattern such as 5+7 at a given pulses-a-minute, to the end or until the signature stops); for the whole song, *First beat of every bar* a pulse earlier or later (the commonest fix: the detector found the right bar length with the downbeat one beat off), and *Shift every bar* by 10 or 50 ms.
- **Tap along:** tap the first beat of each bar (and once more where the last bar ends) or every beat, with the `T` key or the button; Done turns the taps into bars (`barsFromBarTaps` counts the pulses between taps at the given pulses-a-minute, so seven comes out as seven). It replaces only the stretch tapped; what was playing after it carries on.
- Every change is stored at once (`applyMeter`: validate, update, save in order) and can be undone (`meterHistory`, 40 deep, in memory). A change that does not fit says so and changes nothing.

## What follows the bars

When a song has a bar map: the **metronome** clicks its pulses (`metronome.startSequence`, `PulseCursor`; the first pulse of a bar 1500 Hz, the first of another group 1200, the rest 900), starts again when the playhead jumps (seek, loop wrap) and at the song's speed; the **click density** (*Every pulse / Groups / Bars*, kept for every song) lets 7/8 as 3+2+2 click three times or 6/8 click twice; the **recording count-in** counts in the bar playing at the start of the take, with its own pulses and accents (`countInMap`); the **time ruler** draws bar lines, numbers and the signature wherever it changes, and the blue downbeat marker, which only anchored the old four-beat grid, is not drawn; the **Loops menu's bar sections** are cut from the bars (`barSectionsFromMap`). A song without bars behaves exactly as before.

## Finding the bars (sidecar)

`sidecar/meter.py` (`stems-accent-v0`), a non-fatal pipeline stage after the chords and the `detect_meter` command: the beats are tracked on the drums and bass; each beat gets the strength of the kick, the rest of the drums, the bass and the harmony change; a bar length of 2 to 7 beats is right when one position in every N stands out (variance explained by position, corrected for N; a shorter divisor wins when it explains 85% as much); the first beat is where kick, bass and harmony change are strongest; the bars are the tracked beats cut into whole bars of that length, so tempo drift is followed. One signature for the whole song, `confidence` from how plainly the length stood out (not calibrated).

**It is a first guess, and measured as one**: on the 17 reference songs it finds the bar length in 9 of 13 steady songs and 1 of 4 changing-meter songs, and often puts the first beat on the wrong one. It does not meet the thresholds written down for it. See [Meter detection](meter-detection.md#results-of-the-first-detector). The panel is where that is corrected.

## Tests and how it was checked

- mps-core: `src/meter/*.test.ts` (model, edits, taps, cursor), the metronome's sequence mode, the tempo hook, the ruler's bar lines, `barSectionsFromMap`.
- SPS: `src/lib/meterView.test.ts`, the IPC wrappers, the Meter slot in `AnalyzerPage.test.ts`, Rust `meter::tests` (validation, edits win, clearing), sidecar `tests/test_meter.py` (synthetic stems with a known bar length, the shorter-divisor rule, the written file).
- A throwaway real-browser run (vite dev server, mocked Tauri bridge, headless Edge over CDP, synthetic stems in a 5+7 pattern): 25 of 25 checks, including the metronome's clicks (1500, 900, 900, 1200, 900 | 1500, 900, 900, 1200, 900, 1200, 900, a pulse apart) and the ruler's bar lines. **Not run inside the real Tauri app.**
- `sidecar/meter_lab/`: the reference bar maps (from the user's Guitar Pro tabs through `tab_sync`) and `benchmark.py`; data stay local (gitignored).

## Known limits and open ideas

- The detector is one meter for the whole song and puts the downbeat on the wrong beat often; it counts a 6/8 song as four beats (the tracker's tempo prior), though its bar lines are usually right.
- The pulse inside a bar is even; swing and rubato inside one bar are not modelled.
- Not built: bars from the Tab panel's aligned bars and the tab's time signatures ("Use the tab's bars"), snapping a bar line to the nearest hit, chord windows that follow the bars, a chord roll/ruler grid over the waveforms, the same panel in VPS (VPS has no drum stem to show; the core pieces are shared).
