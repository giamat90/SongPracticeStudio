"""
Try values of detector constants, tuning on one data set and checking on another.

    python chord_lab\\sweep.py --tune isophonics --heldout tabs --param _SEVENTH_MARGIN=0.02,0.07,0.1
    python chord_lab\\sweep.py --tune tabs --heldout isophonics --param _SWITCH_COST=0.08,0.12 --param _KEY_BONUS=0,0.02

Several --param options are crossed. Pick the value on the tuning set's
columns and read the held-out columns only to confirm it: a value that wins
where it was chosen and not on songs it never saw is fitted to the songs, not
to the music. Each song is decoded once and every combination runs on it.
"""

import argparse
import itertools
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab


def parse_params(specs: list) -> list:
    """["NAME=a,b,c", ...] -> [{name: value}, ...], every combination."""
    axes = []
    for spec in specs:
        name, _, values = spec.partition("=")
        if not values:
            raise SystemExit(f"--param expects NAME=v1,v2,..., got {spec!r}")
        axes.append([(name, lab._number(v)) for v in values.split(",")])
    combos = [dict(c) for c in itertools.product(*axes)]
    for combo in combos:
        lab._check_names(combo)
    return combos


def run_set(dataset: lab.Dataset, combos: list) -> list:
    """results[i] = the per-song results of combos[i]; a song is prepared once per distinct preparation."""
    results = [[] for _ in combos]
    for entry in dataset.songs:
        print(f"  {dataset.name}: {entry['name']} ...", file=sys.stderr, flush=True)
        prepared = {}
        for i, combo in enumerate(combos):
            prep_values, _ = lab.split_constants(combo)
            key = tuple(sorted(prep_values.items(), key=lambda kv: kv[0]))
            if key not in prepared:
                prepared.clear()
                prepared[key] = lab.prepare(entry["song_dir"], **prep_values)
            result = lab.score_song(entry, combo, dataset.align, prepared[key])
            result.pop("segments")
            results[i].append(result)
    return results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tune", required=True, help="data set the value is chosen on")
    ap.add_argument("--heldout", required=True, help="data set that only confirms the choice")
    ap.add_argument("--param", action="append", required=True, metavar="NAME=v1,v2,...")
    args = ap.parse_args(argv)
    if args.tune == args.heldout:
        raise SystemExit("--tune and --heldout must be different data sets")

    combos = parse_params(args.param)
    tune, held = lab.load_set(args.tune), lab.load_set(args.heldout)
    tuned, confirmed = run_set(tune, combos), run_set(held, combos)

    label = lambda combo: " ".join(f"{k.lstrip('_')}={v:g}" for k, v in combo.items())
    width = max(len(label(c)) for c in combos) + 2
    levels = [lvl[:3] if lvl != "sevenths" else "7th" for lvl in lab.LEVELS]
    print(f"\n{'':<{width}}{'TUNING: ' + tune.name:<30}{'HELD OUT: ' + held.name}")
    print(f"{'':<{width}}" + "".join(f"{l:>8}" for l in levels) + "    " + "".join(f"{l:>8}" for l in levels))
    for combo, a, b in zip(combos, tuned, confirmed):
        cells = lambda rs: "".join(f"{lab.weighted(rs, lvl) * 100:>7.1f}%" for lvl in lab.LEVELS)
        print(f"{label(combo):<{width}}{cells(a)}    {cells(b)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
