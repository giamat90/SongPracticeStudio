# Chord Lab

Workspace for measuring and diagnosing SPS's chord detector (`processor._chords_from_signal`),
outside the app and against reference charts, the way VPS's `pitch_lab` does for pitch. A change to
the detector is judged here with numbers, and with your eyes and ears on the songs it gets wrong,
before it goes anywhere near a release. The lab never edits `processor.py`: a finding is ported by
hand once it holds on songs it was not chosen on.

## Setup

Reuses the sidecar venv, plus `matplotlib` (lab-only, not part of the shipped sidecar):

```powershell
cd SPS\sidecar
.\.venv\Scripts\activate
pip install -r chord_lab\requirements-lab.txt
```

Run lab scripts with that venv's Python. Everything below is run from `SPS\sidecar`.

## Data sets

A data set is a folder under `chord_lab/datasets/` with a `manifest.json` and one reference chart
(`.lab`, one `start end label` line per chord, Harte or plain names) per song:

```json
{"description": "...", "align": true,
 "songs": [{"name": "Let It Be", "song_dir": "let-it-be", "ref": "let-it-be.lab"}]}
```

`song_dir` is a folder with the song's `source.wav` and its stems (what `~/.songpracticestudio/library/<id>`
holds), relative to the manifest, absolute, or `~/...`. `align: true` says the chart is for another
master of the recording, so a constant offset is searched (+-10 s) before scoring.

`datasets/` and `results/` are gitignored: charts of unclear licence and audio do not belong in the
repo. Two sets exist on the author's machine:

| Set | Songs | Charts | Notes |
|---|---|---|---|
| `isophonics` | 12 Beatles and Queen songs, YouTube remasters, stems in the set folder | Isophonics (`isophonics.net/files/annotations`) | `align: true`: the charts are for the CD masters. 2.8 GB. |
| `tabs` | 11 songs of the author's library | read from the author's Guitar Pro tabs with `tab_chords.py` | `song_dir` points into the library, so deleting a song breaks its entry. Rock and pop only. |

Make a set from a `chord_eval.py`-style list with `import_set.py` (see its docstring). Rebuilding
`isophonics` from scratch needs the charts re-downloaded and each song's audio found again; the
original download used `ytsearch1:` queries without recording video IDs, so a rebuild is not
bit-identical. Record the video IDs in the manifest if you rebuild.

## Tools

| Script | What it does |
|---|---|
| `benchmark.py <set>` | Weighted chord symbol recall at root / major-minor / sevenths per song and overall, with a 95% interval from resampling songs. `--const NAME=VALUE`, `--against <earlier result>`, writes `results/<set>-<tag>.json`. |
| `sweep.py --tune A --heldout B --param NAME=v1,v2` | Values of one or more constants (crossed), chosen on `A` and only confirmed on `B`. Each song is decoded once. |
| `visualize.py <set> <song>` | Chroma, detected chords (paler = less confident), reference chords, and a green/amber/red agreement strip. Slider and arrow keys, or `--save`. |
| `sonify.py <set> <song>` | WAV with the song in the left channel and the chords as an organ in the right (`--layout blend` for one mono mix); `--chords reference` plays the chart instead. Pan to hear a wrong chord clash. |
| `import_set.py` | Builds a data set from a manifest list. |
| `lab.py` | Shared helpers: `prepare` / `detect` (the production detector on audio decoded once), `constants(...)` (override `processor` constants and restore them), scoring and the bootstrap. |

`--const` takes any numeric constant of `processor.py` (`_SEVENTH_MARGIN`, `_SWITCH_COST`,
`_KEY_BONUS`, `_NO_CHORD_RMS_RATIO`, ...). A name the detector does not have is an error, not a no-op.

## Workflow

1. **Measure:** `python chord_lab\benchmark.py tabs --tag baseline`, then the same with the change
   and `--against results\tabs-baseline.json`. Look at the interval before believing a point.
2. **Choose on one set, confirm on the other:** `sweep.py --tune isophonics --heldout tabs ...`
   (and the reverse). Tuning and reporting on the same songs flatters the number.
3. **Look at the worst song:** `visualize.py` shows where it disagrees; `sonify.py` lets you hear
   whether the reference or the detector is the one that sounds right. A red stretch is sometimes
   the chart being wrong (a different arrangement, a tab that simplifies the band).
4. **Port by hand** to `processor.py`, add a CHANGELOG line, and record the numbers in
   `wiki/testing.md#chord-accuracy`.

## What the numbers do not tell you

- Charts are not the audio: Isophonics charts are for other masters; tab charts are what the author
  wrote down, often simpler than what the band plays. Both are rock and pop; nothing here measures jazz.
- Twelve and eleven songs give wide intervals (the tab set's major-minor interval is about 61-70).
- `chord_eval.py` scores `X` (a tab's unknowable moments) as unscored, and sus/dim/aug chords
  have no major-minor reading and drop out of that level.
- The sevenths level is the strictest: phantom `maj7`/`7` labels were most of the errors there.

## Reference numbers

Unaligned, current detector (v0.0.63, `_SEVENTH_MARGIN = 0.07`): `tabs` 71.4 / 65.1 / 56.3
(root / major-minor / sevenths). The 71.6 / 65.3 / 56.5 quoted in the release notes of that change
were the same run with `--align` (a constant offset search adds about 0.2 points).
