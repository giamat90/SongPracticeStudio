# Meter detection ("tick-tack"): design record and measurement protocol

Status 2026-10-20: **protocol written before any detector result exists.** Nothing here ships yet. The point of this page is that the pass/fail thresholds below were fixed first, so a result cannot move them.

## Why

SPS counts every bar as four beats: `BEATS_PER_BAR = 4` in mps-core's `audio/metronome.ts` and `hooks/popover-panels/useLoopsMenu.ts`, and `beatsPerBar` defaults to 4 in `metronomeSync`, `loops` and `lib/sections.ts`. A song in 3/4, 6/8, 7/4 or 5/8 gets a metronome accent, a count-in, bar sections and a bar ruler that are all wrong. The wish: study whether a song is in 4/4, 5/4, 7/8 and have the grid follow it.

## What was learned before this page

- Picking the bar length by periodicity alone returns multiples of the true length (8 for 4/4). Restricting candidates to 2 to 7 beats fixed that: 20 of 21 presumed-4/4 library songs picked 4. A fixed score ratio did not separate 4 from 8.
- Two songs gave no usable signal at all (best score about zero). Confidence has to say so.
- 3 Libras (6/8, confirmed by the user) came out as 3 beats per bar: the right family, the wrong beat level. The pulse level (which note the tempo counts) has to be settled before bar length means anything.
- The reference tabs show that odd-meter songs are not one meter. Schism alternates 5/8 and 7/8; Lateralus cycles 9/8, 8/8, 7/8; 7empest is 5/8 three times then 6/8; Pneuma mixes 4/4, 5/4, 6/8 and 5/8. Money and Solsbury Hill are 7/4 with short 4/4 or 6/4 bars. A single "beats per bar" number cannot describe the first group. The model that does is a **constant pulse plus a repeating cycle of bar lengths** (Schism [5,7] eighths, Lateralus [9,8,7]).

## Reference data

Bar maps `[{index, time, num, den}]` on the real recordings, from the user's Guitar Pro files:

- `.gp` is read by alphaTab in Node into the same score the Tab panel builds (`src/lib/tabScore.ts`), then placed on the recording by `tab_sync.align_tab_to_stems`. The 11 older tabs go through their `.mid` exports (`tab_chords.score_from_midi`).
- Time signatures come from the tab, so they are only as right as the transcriber. Tab times are only as right as the alignment, which is ear-checked per song (`GP-and-MIDI-files/sync-check/<Song>_with_bar_beeps.wav`). A song whose alignment fails the ear check is scored on P1 and P2 only, never on P3.
- Audio, tabs and references stay local (gitignored), like `chord_lab`.

| Set | Songs | Role |
|---|---|---|
| `constant` | the 11 tab songs (4/4 by their tabs) + Money + Solsbury Hill (7/4 with short 4/4 bars) | tuning |
| `odd` | Schism, Lateralus, Pneuma, 7empest | held out: never used to choose a constant |

Four held-out songs is a small set. A song count that low means a pass is evidence, not proof, and every number gets its count next to it.

## Metrics

Let the *reference unit* of a song be the note its time signature counts (quarter for x/4, eighth for x/8).

- **P1, pulse level.** The detected pulse period is within 4% of the reference unit's period times 0.5, 1 or 2.
- **P2, dominant bar length** (constant set). The detector's most common bar length, in reference units, equals the reference's.
- **P3, downbeat F1 at 70 ms.** Detected bar starts against aligned reference bar starts, the standard downbeat measure, on songs that passed the ear check.
- **P4, baseline.** "Fixed four-beat bars on the beat tracker's grid, best phase" scored with P3. The detector must beat it.
- **P5, confidence.** Area under the ROC curve of confidence against "this song's dominant bar length is right".

## Thresholds (fixed 2026-10-20, before any run)

| Metric | `constant` | `odd` (held out) |
|---|---|---|
| P1 | at least 85% of songs | at least 3 of 4 |
| P2 | at least 85% of songs, and both 7/4 songs | not scored (no dominant length) |
| P3 | F1 at least 0.75 | F1 at least 0.50 |
| P4 | beat the baseline by at least 0.15 on Money + Solsbury Hill | beat the baseline by at least 0.15 |
| P5 | AUC at least 0.70 on all 17 songs together | not scored |

Decision rule:

1. `constant` passes P1 to P3 and P5, `odd` fails P3: ship **constant meter per song** (detect, override, drive the grid) and keep the bar map as a later stage.
2. `constant` passes and `odd` passes P1 and P3: build the **bar map** (pulse plus cycle) as the model.
3. `constant` fails P2 or P3: **do not ship detection.** Ship only the override and the generalised grid (`beatsPerBar` through core), which is useful without any detector.

## Open

Whether a learned downbeat tracker beats a stems-based classical one is not decided; its weights' licence is unchecked and it would be a comparison arm, not an assumption.
