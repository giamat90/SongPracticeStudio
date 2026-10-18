# Chord Lab

Workspace for measuring and diagnosing SPS's chord detector (`processor._chords_from_signal`),
outside the app and against reference charts, the way VPS's `pitch_lab` does for pitch. A change to
the detector is judged here with numbers, and with your eyes and ears on the songs it gets wrong,
before it goes anywhere near a release. The lab never edits `processor.py`: a finding is ported by
hand once it holds on songs it was not chosen on.

## Setup

Reuses the sidecar venv, plus `matplotlib` and `sounddevice` (lab-only, not part of the shipped sidecar):

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
| `live.py` | Real-time pitch and chord detection from an audio interface (`listen`), a recording (`file`) or a data-set song (`replay`, scored). See "Live: a guitar through an interface" below. |
| `realtime.py` | The live engine: pure (samples in, one frame per 50 ms out), no audio I/O, tested without hardware. |
| `lab.py` | Shared helpers: `prepare` / `detect` (the production detector on audio decoded once), `constants(...)` (override `processor` constants and restore them), scoring and the bootstrap. |

`--const` takes any numeric constant of `processor.py` (`_SEVENTH_MARGIN`, `_SWITCH_COST`,
`_KEY_BONUS`, `_NO_CHORD_RMS_RATIO`, ...). A name the detector does not have is an error, not a no-op.

## Live: a guitar through an interface

`live.py` listens to an input and shows, every 50 ms, the note (name and cents, like a tuner) when one
note rings clearly, and the chord otherwise.

```powershell
python chord_lab\live.py devices                      # find the interface; pick its WASAPI entry
python chord_lab\live.py listen --device Focusrite --plot   # a window: big chord, note + cents, chroma, last 20 s
python chord_lab\live.py listen --device 12           # terminal only: a status line + one line per chord change
python chord_lab\live.py listen --device Focusrite --record take.wav --lab take.lab --capo 2
```

- **Hardware:** plug the guitar into an input, set the interface's instrument/line switch, and keep the
  level healthy (it warns at full scale and when it hears nothing for 6 s). `--channel auto` follows the louder
  input; `0`, `1` or `mix` override. Windows must allow desktop apps to use the microphone (Settings, Privacy).
  Use direct monitoring on the interface to hear yourself: the tool only listens, it plays nothing.
- **What it shows:** the note only when one note rings (a weak or missing fundamental, as in a strummed chord,
  is not called a note); the chord with its fit (0-1, how well the notes match), the next best guesses, and
  the instrument's offset from A440 in cents, followed from the spectrum. `--capo N` names the shapes you play.
- **How:** YIN for the pitch. For the chord, the spectrum's real peaks of the last 0.4 s are folded to a
  chroma, matched against the app's chord templates (sevenths pay the app's margin) and decoded by a causal
  Viterbi pass with the app's switch costs, so a new chord has to win for about `--stick` seconds. The bass
  note makes a slash chord, as in the app. Details in `realtime.py`.
- **Latency:** a chord shows about a quarter to half a second after the strum (half a window of new sound plus
  the evidence time). Shorten `--window` / `--stick` for speed at the cost of steadiness; low strings blur
  below about 0.3 s because a semitone there is only 5 Hz wide.
- **Kept takes:** `--record` writes the audio, `--lab` the chords shown; the audio can be replayed with
  `live.py file` or imported as a data-set song.
- **Not the app's detector:** it cannot look ahead, has no beat grid and no key prior, so it is less steady and
  slower than the app's chords. It is for playing along and for trying ideas, not a replacement.

**Measuring it** (the lab's way): `python chord_lab\live.py replay tabs --align` feeds each song's harmonic
mix through the same engine block by block and scores it against the chart, next to the offline detector's
numbers. `--align` also reports how far the chords are shifted, which is the engine's real delay.
`--stems guitar` replays one stem.

Measured (time-weighted root / major-minor / sevenths), live engine at its defaults
(`--peak-floor 0.02 --seventh-margin 0.12 --stick 0.25`), settings chosen on `isophonics` and confirmed on `tabs`:

| Set | Live engine | App's offline detector | Notes |
|---|---|---|---|
| `isophonics` (tuning set, 12 songs) | 78.9 / 71.5 / 63.1 | 72.7 / 64.3 / 55.4 | `--stick 0.4`: 79.6 / 72.7 / 64.3; `--stick 0.15`: 77.9 / 69.9 / 61.6 |
| `tabs` (held out, 11 songs) | 72.9 / 60.9 / 51.5 | 71.6 / 65.3 / 56.5 | the old floor and margin (0.05 / 0.07) scored 72.5 / 61.5 / 52.5 there |

Read it as: about level with the offline detector on root, ahead on one set and behind on the other for the
rest. The lead on `isophonics` did not carry over to `tabs`, so the peak-based front end is not shown to be
better than the app's chroma, and the tuned floor and margin are not shown to matter. Each set's interval is
several points wide. Chosen because: a clear seventh needs a larger margin on this chroma than on the app's
(0.02 cost 11 points of sevenths on `isophonics`), and a quarter second of evidence (`--stick`) balances
steadiness and speed.

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
