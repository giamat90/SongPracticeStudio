# Meter detection ("tick-tack"): design record and measurement protocol

Status 2026-10-20: the protocol below was written before any detector result existed, and the first detector has since been measured against it: [it does not meet the thresholds](#results-of-the-first-detector). The Meter feature ships anyway, with the detector as a labelled first guess and the tools to correct it, on the user's decision ([Meter](meter.md)). The thresholds below were fixed first so a result could not move them, and they have not been moved.

## Why

SPS counts every bar as four beats: `BEATS_PER_BAR = 4` in mps-core's `audio/metronome.ts` and `hooks/popover-panels/useLoopsMenu.ts`, and `beatsPerBar` defaults to 4 in `metronomeSync`, `loops` and `lib/sections.ts`. A song in 3/4, 6/8, 7/4 or 5/8 gets a metronome accent, a count-in, bar sections and a bar ruler that are all wrong. The wish: study whether a song is in 4/4, 5/4, 7/8 and have the grid follow it.

## What was learned before this page

- Picking the bar length by periodicity alone returns multiples of the true length (8 for 4/4). Restricting candidates to 2 to 7 beats fixed that: 20 of 21 presumed-4/4 library songs picked 4. A fixed score ratio did not separate 4 from 8.
- Correction (same day): the sentence above rested on an assumption that was wrong for one song. The Kill is 6/8 in its tab, and the spike called it 4, so it was 19 of 20 of the *presumed* 4/4 songs, not 20 of 21 confirmed. See the amendment below.
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
| `constant` | the 11 older tab songs + Money + Solsbury Hill: one dominant meter each (see the amendment) | tuning |
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

## Amendment 2026-10-20 (reference data read; still no detector result)

Building the reference maps showed the song descriptions above were partly wrong. The thresholds are unchanged; what changes is how two metrics treat compound meters.

Share of bars by meter in the reference maps:

| Song | Set | Meter (share of bars) |
|---|---|---|
| Beat It, Chop Suey, Immigrant Song, Like a Stone, Party in the U.S.A., Starlight, What I've Done, You Oughta Know | `constant` | 4/4 (100%) |
| Mercy, War Pigs | `constant` | 4/4 (96%, 95%), a few 2/4, 3/4 or 12/8 bars |
| **The Kill** | `constant` | **6/8 (100%)** |
| Money | `constant` | 4/4 61%, 7/4 35%, 6/4 2% |
| Solsbury Hill | `constant` | 7/4 91%, 4/4 8% |
| Schism | `odd` | 6/8 27%, 7/8 24%, 5/8 21% (plus 5/4, 4/4, 3/8 and others) |
| Lateralus | `odd` | 6/8 59%, 5/8 23%, 9/8 6% |
| Pneuma | `odd` | 4/4 48%, 6/8 23%, 5/8 23% |
| 7empest | `odd` | 4/4 30%, 7/8 28%, 5/8 17% |

- **P1 and P2 for compound meters.** A pulse ratio of 3 to the denominator note (the dotted quarter in 6/8, 9/8, 12/8) counts as level-correct for those songs, and the bar length is then counted in those pulses (6/8 is 2). Without this a tracker that follows the dotted quarter would score as wrong on The Kill, which is the natural way to count it. The rule is stated before any detector ran.
- **The `constant` set is not all 4/4.** It holds four meters (4/4, 6/8, 7/4 and a 4/4 and 7/4 mix). "Dominant meter" in P2 means the most common one by bar count.
- **Ear checks are still pending.** `ear_checked` in each reference file is `null` until the user has listened to the bar-beep file. P3 only uses songs set to true.

## Results of the first detector

`meter.py` (`stems-accent-v0`, [how it works](meter.md#finding-the-bars-sidecar)) scored with `meter_lab/benchmark.py` on the 17 reference songs, 2026-10-20. No constant was tuned on these songs: the detector was written from the spike, and the only change after seeing a result was the shorter-divisor rule, made on a synthetic test before the benchmark ran.

| Song | Set | Tab says | Found | Pulse | Length | F1 at 70 ms | Confidence |
|---|---|---|---|---|---|---|---|
| Beat It | constant | 4/4 | 4 beats | ok | ok | 0.00 | 0.84 |
| Chop Suey | constant | 4/4 | 4 beats | ok | ok | 0.00 | 1.00 |
| Immigrant Song | constant | 4/4 | 4 beats | miss | miss | 0.24 | 0.33 |
| Like a Stone | constant | 4/4 | 4 beats | ok | ok | 0.93 | 1.00 |
| Mercy | constant | 4/4 | 4 beats | ok | ok | 0.88 | 1.00 |
| Money | constant | 4/4 (61%), 7/4 (35%) | 7 beats | miss | miss | 0.17 | 0.86 |
| Party in the U.S.A. | constant | 4/4 | 4 beats | ok | ok | 0.00 | 1.00 |
| Solsbury Hill | constant | 7/4 | 7 beats | ok | ok | 0.14 | 0.33 |
| Starlight | constant | 4/4 | 4 beats | ok | ok | 0.99 | 1.00 |
| The Kill | constant | 6/8 | 4 beats | miss | miss | 0.87 | 0.88 |
| War Pigs | constant | 4/4 | 2 beats | ok | miss | 0.21 | 0.04 |
| What I've Done | constant | 4/4 | 4 beats | ok | ok | 0.94 | 1.00 |
| You Oughta Know | constant | 4/4 | 4 beats | ok | ok | 0.81 | 0.55 |
| 7empest | odd | 4/4 (30%) | 2 beats | ok | miss | 0.16 | 0.00 |
| Lateralus | odd | 6/8 (59%) | 4 beats | miss | miss | 0.06 | 0.00 |
| Pneuma | odd | 4/4 (48%) | 4 beats | ok | ok | 0.29 | 0.06 |
| Schism | odd | 6/8 (27%) | 2 beats | ok | miss | 0.10 | 0.00 |

Against the thresholds:

| Metric | `constant` (13) | Threshold | `odd` (4) | Threshold | Verdict |
|---|---|---|---|---|---|
| P1 pulse level | 10 of 13 (77%) | 85% | 3 of 4 | 3 of 4 | constant **fails**, odd passes |
| P2 bar length | 9 of 13 (69%), Money missed | 85% and both 7/4 songs | 1 of 4 | not scored | **fails** |
| P3 downbeat F1 | mean 0.48 | 0.75 | mean 0.15 | 0.50 | **fails** both |
| P4 against the four-beat baseline | not run | | not run | | open |
| P5 confidence | AUC 0.86 for "the length it found is right", over all 17 | 0.70 | | | **passes** |

Decision rule 3 applies: the detector fails P2 and P3 on the `constant` set. What it says is not to ship detection by itself; the user chose (2026-10-20) to ship the tools and keep detection as a clearly labelled first guess, since the point of the feature is that a person can study and fit the meter whatever the detector does. The panel therefore shows where the bars came from and the detector's confidence, never replaces the user's own bars without asking, and has an undo.

What the numbers say:

- **The downbeat is the weak part.** Beat It, Chop Suey and Party in the U.S.A. have the right bar length at confidence 0.84 to 1.00 and an F1 of exactly 0.00: the bar lines sit on beats, one or two beats from the first. Among the ten songs with the right length, six have a good downbeat. This is why the panel has *First beat of every bar, a pulse earlier or later* as a one-click tool. (Beat It and Chop Suey are two of the three tabs that have bar-beep files from the tab-sync work; the other references have not been ear-checked, and F1 is only as good as their alignment.)
- **Counting is not the same as placing.** The Kill is 6/8 in its tab and the detector counts four beats, so it scores as wrong on P1 and P2, yet its bar lines are right (F1 0.87): the tracker counts the two dotted-quarter beats of a 6/8 bar as four beats at its preferred tempo. *Count finer / coarser* and the pulse editor exist for this.
- **Money is a fair miss.** The tab is 4/4 for 61% of the time and 7/4 for 35%; the detector found the 7/4 riff. A reference with one dominant meter per song is too crude for it.
- **The changing-meter songs are out of reach of one meter per song.** Schism, Lateralus and 7empest score near zero by construction. They are the reason for the repeat-a-pattern and tap tools.
- **Confidence is informative about the length, not the downbeat.** AUC 0.86 against "the length is right" (small set, wide uncertainty: 10 and 7 songs), but Beat It scores 0.84 with the downbeat on the wrong beat.

Not yet done: P4 (the four-beat baseline), a downbeat rule tuned on the `constant` set and confirmed on the `odd` set, and the ear check of the bar-beep files that decides which references count for P3.
