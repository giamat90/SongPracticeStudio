# Chord Lab — Claude Code Context

Measurement workspace for SPS's chord detector, living in the repo at `sidecar/chord_lab/`.
**Read `README.md` here first**: setup, data sets, every tool, the workflow. This file is the
fast-orientation layer for picking up mid-investigation.

## Rules that always apply

- The lab never edits `processor.py` or anything shipped. A finding is provisional until it holds on
  a set it was not tuned on; then port it by hand (CHANGELOG line, `wiki/testing.md#chord-accuracy`).
- Tune on one data set, confirm on the other (`sweep.py --tune A --heldout B`). Never report a
  number on the songs a constant was chosen on.
- Audio, charts and results are gitignored (`datasets/*`, `results/*`). Isophonics charts have no
  stated licence; the tabs and the audio are the user's own. Never commit them, never print cookie files.
- `matplotlib` is lab-only. Production code must not import from `chord_lab/`.
- `lab.prepare` + `lab.detect` must give what `processor._detect_chords_full` gives
  (`tests/test_chord_lab.py` holds them equal). If `_detect_chords_full` changes how it reads the
  audio, change `lab.prepare` with it.

## State (2026-10-18)

- Built on `feat/chord-lab`: `lab.py`, `benchmark.py`, `sweep.py`, `visualize.py`, `sonify.py`,
  `import_set.py`, tests in `sidecar/tests/test_chord_lab.py` (they skip the plot check without matplotlib).
- Data sets on the author's disk: `isophonics` (12 songs, copied out of a temporary scratchpad,
  2.8 GB, `align: true`) and `tabs` (11 library songs, `song_dir` into `~/.songpracticestudio/library`).
- Reproduces the earlier harness exactly: `tabs` unaligned 71.4 / 65.1 / 56.3 equals `chord_eval.py`'s
  unaligned columns for the v0.0.63 detector.

- Live tool (branch `feat/chord-live`): `realtime.py` (pure engine: YIN pitch, peak-based chroma, causal
  Viterbi with the app's templates and switch costs, running tuning, lowest-note bass), `live.py`
  (`devices`, `listen [--plot]`, `file`, `replay`). Tests in `sidecar/tests/test_chord_live.py` use a fake
  `sounddevice`, so they need no hardware. The user's interface is a Focusrite (WASAPI device by name:
  `--device Focusrite`). Held-out result in README: level with the offline detector on root, 4-5 points
  behind on major-minor and sevenths on `tabs`; the 5-point lead on `isophonics` did not transfer.
- `CHORD_LAB_DATASETS` overrides where `datasets/` lives (a worktree can point at the main checkout's).

## Not built yet (ideas, roughly in order)

- Basic Pitch (or another neural note transcriber) as an optional front end for the live engine, scored on
  both sets next to the current one. Cost to weigh before shipping anything: model file, onnx/tensorflow, latency.
- Real guitar through the interface has not been measured: no clean DI guitar data exists here yet. Record a
  few takes with `listen --record --lab` and import them as a third data set.
- Party in the U.S.A. scored 76% root in the first live replay against 55% offline: the offline pipeline
  (beat grid? tuning?) fails there for a reason that is not the audio. Worth diagnosing with `visualize.py`.

- A "listen here" list per song: the stretches where the detector's top choices disagree or where it
  is confident and wrong, as start times to feed to `sonify.py --start/--end`.
- A confusion table and a segmentation score (boundaries, not only labels), mirrored from
  `chord_eval.py`'s confusions.
- Exact YouTube video IDs recorded in the `isophonics` manifest, and a fetch script, so the set can be
  rebuilt bit-identically.
- Songs that are not rock and pop; a third set for a final check.
- Open questions that need this lab: Party in the U.S.A. (root 55% against its tab, undiagnosed),
  major/minor third flips, "N -> chord" in silences, power chords (`5`) and sus/dim in the vocabulary.

## Gotchas

- Windows: run with `.venv\Scripts\python.exe`; the global Python has no librosa.
- A full `benchmark.py` run decodes every song (a few minutes per set); keep one run at a time,
  the machine has little free RAM.
- `--const` constants that change what is read (`_MIN_BEATS`, `_BEAT_INTERVAL_RANGE`,
  `_CHORD_EXCLUDED_STEMS`, ...) make `lab` prepare the song again; decoding-only constants reuse it.
