# Live engine experiments

`live_sweep.py OUT.jsonl SET "k=v,k=v" ["k=v" ...]` runs the live engine over every song of a data set once per
configuration (the keys are `realtime.Settings` fields, for example `peak_floor=0.02,seventh_margin=0.12`), scored
aligned like the benchmark, and appends one JSON line per configuration. It chose the defaults on `isophonics`;
`tabs` confirmed them. Run it from `sidecar/` with the sidecar venv; each configuration takes a few minutes.

Results that chose the defaults are in `chord_lab/README.md` ("Measured"). A one-off like this belongs here rather
than in `benchmark.py` because it reloads the audio per configuration; speeding that up (songs outer, configurations
inner) is an easy improvement.
