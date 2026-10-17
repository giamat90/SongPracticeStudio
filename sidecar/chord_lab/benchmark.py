"""
Score the chord detector on a data set.

    python chord_lab\\benchmark.py isophonics
    python chord_lab\\benchmark.py tabs --const _SEVENTH_MARGIN=0.1
    python chord_lab\\benchmark.py isophonics --against results\\isophonics-baseline.json

Per song and over the whole set: weighted chord symbol recall at root /
major-minor / sevenths. The set's score is time-weighted, with a 95% interval
from resampling the songs (a small set gives a wide one; read the interval
before believing a one-point change). `--against` prints the change from an
earlier run's file. The result is written to results/<set>-<tag>.json.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab


def run(dataset: lab.Dataset, values: dict) -> list:
    results = []
    for entry in dataset.songs:
        print(f"  {entry['name']} ...", file=sys.stderr, flush=True)
        results.append(lab.score_song(entry, values, dataset.align))
    return results


def summary(results: list) -> dict:
    return {
        level: {"score": lab.weighted(results, level), "interval": lab.bootstrap(results, level)}
        for level in lab.LEVELS
    }


def table(dataset: lab.Dataset, results: list, values: dict, against: dict | None) -> None:
    print(f"\n{dataset.name}: {dataset.description}")
    if values:
        print("constants: " + ", ".join(f"{k}={v}" for k, v in values.items()))
    print(f"{'song':<34}" + "".join(f"{level:>10}" for level in lab.LEVELS) + f"{'offset s':>10}")
    for r in results:
        cells = "".join(f"{r['levels'][level]['score'] * 100:>9.1f}%" for level in lab.LEVELS)
        print(f"{r['name'][:33]:<34}{cells}{r['offset']:>+10.1f}")
    total = summary(results)
    print(f"{'ALL (time-weighted)':<34}" + "".join(f"{total[level]['score'] * 100:>9.1f}%" for level in lab.LEVELS))
    print(f"{'  95% interval':<34}" + "".join(
        f"{'%.0f-%.0f' % (total[level]['interval'][0] * 100, total[level]['interval'][1] * 100):>10}" for level in lab.LEVELS))
    if against:
        before = against["summary"]
        print(f"{'  change vs ' + against['tag']:<34}" + "".join(
            f"{(total[level]['score'] - before[level]['score']) * 100:>+9.1f}%" for level in lab.LEVELS))
        old = {s["name"]: s for s in against["songs"]}
        moved = [(r["name"], r["levels"]["sevenths"]["score"] - old[r["name"]]["levels"]["sevenths"]["score"])
                 for r in results if r["name"] in old]
        moved.sort(key=lambda m: m[1])
        if moved:
            print("  biggest changes (sevenths): " + ", ".join(f"{n} {d * 100:+.1f}" for n, d in moved[:2] + moved[-2:]))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dataset")
    ap.add_argument("--const", action="append", default=[], metavar="NAME=VALUE", help="override a processor constant")
    ap.add_argument("--tag", default="run", help="name of the result file (results/<set>-<tag>.json)")
    ap.add_argument("--against", help="an earlier result file to show the change from")
    args = ap.parse_args(argv)

    dataset = lab.load_set(args.dataset)
    values = lab.parse_constants(args.const)
    results = run(dataset, values)

    against = json.loads(Path(args.against).read_text(encoding="utf-8")) if args.against else None
    table(dataset, results, values, against)

    lab.RESULTS.mkdir(exist_ok=True)
    out = lab.RESULTS / f"{dataset.name}-{args.tag}.json"
    out.write_text(json.dumps({
        "dataset": dataset.name, "tag": args.tag, "constants": values, "summary": summary(results),
        "songs": [{k: v for k, v in r.items() if k != "segments"} for r in results],
    }, indent=2, default=list), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
