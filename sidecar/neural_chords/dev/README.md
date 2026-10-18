# Neural chord engine: dev scripts

Not part of the app or of `pytest`. They produced the numbers quoted in `wiki/python-sidecar.md` and MPS
`wiki/chord-ai-spike.md`. Run them with the sidecar venv's Python, after `python fetch_btc.py`, from `sidecar/`.
They need the chord lab's data sets (`datasets/isophonics`, `datasets/tabs`, gitignored; the lab itself is on
the `feat/chord-live` branch until that is merged); point `CHORD_LAB_DATASETS` at the folder that holds them.

- `prod_eval.py OUT.json`: scores `processor._detect_chords_full` with each engine (classic, neural) on both
  sets, aligned, the same protocol as the lab. About 15-25 minutes; it holds a few hundred MB.
- `prod_report.py`: reads `prod_results.json` (edit the path at the top) and prints the weighted scores per set,
  the paired per-song differences with bootstrap intervals, and the timing. `isophonics` is contaminated for BTC.
- `neural_demo.py "song" set start window OUTDIR`: a PNG comparing your tab, the classical detector and the neural
  one on a stretch of a song, and a WAV with the song left and the neural chords right.

Results so far (tabs, 11 independent songs, root / major-minor / sevenths): classical 71.6 / 65.3 / 56.5, neural
76.6 / 72.2 / 62.1; major-minor +6.8 [+0.5, +12.7].
